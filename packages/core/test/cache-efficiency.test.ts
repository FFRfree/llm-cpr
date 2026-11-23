// family-observability 票 03 纯函数单测：账本形状自适应（P2-1）、rates 覆盖、clamp、
// 交错线程独立 first-seen、内容缺失剔除。computeCacheEfficiency 无 I/O，直接喂合成数据。
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCacheEfficiency, DEFAULT_RATES, threadKeyOf } from '../src/observability/cache-efficiency.ts';
import type { EfficiencyTurn, EfficiencyUsage } from '../src/observability/cache-efficiency.ts';

// contentBytes 查表：hash → bytes；usage prompt 恒等于该轮 contentSum（scale=1，token=bytes 精确）。
function fixture(turns: Array<{ hashes: Array<[string, number]>; usage: EfficiencyUsage }>) {
  const bytes = new Map<string, number>();
  const effTurns: EfficiencyTurn[] = [];
  const usageMap = new Map<string, EfficiencyUsage>();
  turns.forEach((turn, i) => {
    const capture_id = `c${i + 1}`;
    const refs = turn.hashes.map(([hash]) => hash);
    let contentSum = 0;
    for (const [hash, size] of turn.hashes) { bytes.set(hash, size); contentSum += size; }
    effTurns.push({ capture_id, ts: 1000 + i, refs });
    usageMap.set(capture_id, turn.usage);
  });
  return { effTurns, usageMap, contentBytes: (hash: string) => bytes.get(hash) ?? null };
}

const usage = (prompt: number, hit: number, write: number, extra: Partial<EfficiencyUsage> = {}): EfficiencyUsage =>
  ({ prompt_tokens: prompt, cache_hit_tokens: hit, cache_write_tokens: write, cache_observed: true, ...extra });

test('threadKeyOf: refs[1] primary, falls back to refs[0] then (none)', () => {
  assert.equal(threadKeyOf(['sys', 'goal']), 'goal');
  assert.equal(threadKeyOf(['only']), 'only');
  assert.equal(threadKeyOf([]), '(none)');
});

test('P2-1 exclusive shape (Anthropic ledger): fresh is prompt, not clamped to 0', () => {
  // t1: fresh-only 100（无缓存分量）；t2: fresh 100 + read 500 + write 200 → prompt=100。
  // 修复前：fresh 恒钳 0 → actual=250；修复后：fresh=100 → actual = 100 + 50 + 200×1 = 350。
  const fx = fixture([
    { hashes: [['sys', 100]], usage: usage(100, 0, 0, { usage_json: '{"input_tokens":100}' }) },
    { hashes: [['sys', 100], ['old', 500], ['new', 200]], usage: usage(100, 500, 200, { usage_json: '{"input_tokens":100,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}' }) },
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, fx.contentBytes);
  assert.equal(report.totals.turns_used, 2);
  assert.equal(report.totals.turns_skipped_no_usage, 0);
  // actual = t1 100（无缓存分量，全 fresh）+ t2 (100×1 + 500×0.1 + 200×1) = 450
  // （修复前 t2 的 100 fresh 被钳 0 → 350，漏计首行全价）。
  assert.ok(Math.abs(report.totals.actual_weighted - 450) < 1e-9, `actual=${report.totals.actual_weighted}`);
});

test('P2-1 exclusive detection via hit>prompt heuristic (no usage_json)', () => {
  const fx = fixture([
    { hashes: [['sys', 100], ['goal', 200]], usage: usage(300, 0, 0) },
    { hashes: [['sys', 100], ['goal', 200], ['a2', 300]], usage: usage(100, 500, 0) }, // hit 500 > prompt 100 ⇒ exclusive
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, fx.contentBytes);
  // exclusive：fresh=prompt=100；actual = 300 + (100 + 50) = 450（inclusive 误算会把 fresh 钳 0 → 350）。
  assert.ok(Math.abs(report.totals.actual_weighted - 450) < 1e-9, `actual=${report.totals.actual_weighted}`);
});

test('inclusive shape (OpenAI ledger): fresh = prompt − hit − write', () => {
  const fx = fixture([
    { hashes: [['sys', 100], ['goal', 200]], usage: usage(300, 0, 0) },
    { hashes: [['sys', 100], ['goal', 200], ['a2', 300]], usage: usage(600, 300, 0, { usage_json: '{"prompt_tokens":600,"prompt_tokens_details":{"cached_tokens":300}}' }) },
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, fx.contentBytes);
  // t2: fresh 300 + hit 300×0.1 = 330 = ideal（300×0.1 + 300×1）→ 完美线程 efficiency 1.0。
  assert.ok(Math.abs((report.totals.efficiency ?? 0) - 1) < 1e-9, `eff=${report.totals.efficiency}`);
});

test('interleaved threads: independent first-seen per thread (shared system double-counted in corpus)', () => {
  const fx = fixture([
    { hashes: [['sys', 100], ['goalA', 200]], usage: usage(300, 0, 0) },      // A1
    { hashes: [['sys', 100], ['goalB', 400]], usage: usage(500, 0, 0) },      // B1（交错）
    { hashes: [['sys', 100], ['goalA', 200], ['a2', 300]], usage: usage(600, 300, 0) },   // A2
    { hashes: [['sys', 100], ['goalB', 400], ['b2', 500]], usage: usage(1000, 500, 0) },  // B2
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, fx.contentBytes);
  assert.equal(report.threads.length, 2);
  // 唯一语料 = 1500（六条消息各一次）+ system 100 第二次首现 = 1600：票口径「共享 system 在两线程各计一次写」。
  assert.equal(report.totals.corpus_tokens_est, 1600);
  // 每线程内部都是完美 append-only → 线程与总量 efficiency 都是 1.0。
  assert.ok(Math.abs((report.totals.efficiency ?? 0) - 1) < 1e-9);
  for (const thread of report.threads) assert.ok(Math.abs((thread.efficiency ?? 0) - 1) < 1e-9);
  // 线程按语料量降序：B（1000）在 A（600）前。
  assert.equal(report.threads[0].corpus_tokens_est, 1000);
  assert.equal(report.threads[1].corpus_tokens_est, 600);
});

test('rates override: read=1 keeps a perfect thread at 1.0 and read_multiplier unaffected', () => {
  const fx = fixture([
    { hashes: [['sys', 100], ['goal', 200]], usage: usage(300, 0, 0) },
    { hashes: [['sys', 100], ['goal', 200], ['a2', 300]], usage: usage(600, 300, 0) },
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, fx.contentBytes, { ...DEFAULT_RATES, read: 1 });
  assert.equal(report.assumptions.rates.read, 1);
  assert.ok(Math.abs((report.totals.efficiency ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((report.totals.read_multiplier ?? 0) - 0.5) < 1e-9); // Σhit 300 / corpus 600
});

test('cache-drop turn shows waste; efficiency clamps at 1.0 when actual undercharges', () => {
  // 丢缓存：t2 hit=0 → 多付全价。
  const dropped = fixture([
    { hashes: [['sys', 100], ['goal', 200]], usage: usage(300, 0, 0) },
    { hashes: [['sys', 100], ['goal', 200], ['a2', 300]], usage: usage(600, 0, 0) },
  ]);
  const dropReport = computeCacheEfficiency(dropped.effTurns, dropped.usageMap, dropped.contentBytes);
  // actual = 300 + 600 = 900；ideal = 300 + (300×0.1 + 300) = 630 → eff = 0.7。
  assert.ok(Math.abs((dropReport.totals.efficiency ?? 0) - 0.7) < 1e-9, `eff=${dropReport.totals.efficiency}`);
  assert.ok(Math.abs((dropReport.totals.waste_share ?? 0) - 0.3) < 1e-9);
  // 反向（上游少收）：hit 500 > old 内容 300 → actual = 100 + 50 = 150 < ideal 330 → clamp 1.0。
  const cheap = fixture([
    { hashes: [['sys', 100], ['goal', 200]], usage: usage(300, 0, 0) },
    { hashes: [['sys', 100], ['goal', 200], ['a2', 300]], usage: usage(600, 500, 0) },
  ]);
  const cheapReport = computeCacheEfficiency(cheap.effTurns, cheap.usageMap, cheap.contentBytes);
  assert.equal(cheapReport.totals.efficiency, 1.0);
  assert.equal(cheapReport.totals.waste_share, 0);
});

test('skips: no-usage and no-content counted separately, efficiency null on empty window', () => {
  const fx = fixture([
    { hashes: [['sys', 100]], usage: usage(0, 0, 0) },                        // prompt=0 → no-usage
    { hashes: [['sys', 100]], usage: usage(100, null as unknown as number, 0, { cache_observed: false }) }, // observed=false → no-usage
    { hashes: [['ghost', 100]], usage: usage(100, 0, 0) },                   // content 缺失 → no-content
  ]);
  const report = computeCacheEfficiency(fx.effTurns, fx.usageMap, () => null);
  assert.equal(report.totals.turns_used, 0);
  assert.equal(report.totals.turns_skipped_no_usage, 2);
  assert.equal(report.totals.turns_skipped_no_content, 1);
  assert.equal(report.totals.efficiency, null);
  assert.equal(report.totals.waste_share, null);
  assert.equal(report.totals.read_multiplier, null);
});
