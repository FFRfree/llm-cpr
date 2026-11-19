// 策略回放（observability 票 02）：ctx 构造同源性、正常/改绑两决策点的重放计数、
// dry-run 只读口径、终端报告。夹具全部本机假数据，不碰真实上游。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayPolicy, renderReplayReport } from '../core/observability/replay.ts';
import { CaptureStore } from '../core/store/capture.ts';
import { openDatabase } from '../core/store/db.ts';
import { UsageAudit } from '../core/store/audit.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Backend } from '../core/contracts.ts';
import type { DecisionCtx, RouterPolicy } from '../core/policy/contract.ts';

const SALT = 'ab'.repeat(32);
process.env.CPR_CAPTURE_SALT = SALT;

interface Fixture {
  dir: string;
  captureDb: string;
  ledgerDb: string;
  turnCaptureIds: string[];
  turnBytes: number[];
}

function buildFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-replay-'));
  const captureDb = path.join(dir, 'capture.db');
  const ledgerDb = path.join(dir, 'data.db');
  const store = new CaptureStore({ dbFile: captureDb, ttlDays: 0, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  const captureIds: string[] = [];
  for (const messages of [
    [{ role: 'system', content: 's' }, { role: 'user', content: 'q1' }],
    [{ role: 'system', content: 's' }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }],
    [{ role: 'system', content: 's' }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }, { role: 'user', content: 'q3' }],
  ]) {
    const outcome = store.capture({ tenant: 't', identity: 'sess-1', identityKind: 'session', model: 'm', body: JSON.parse(JSON.stringify({ model: 'm', messages })), rawBytes: 120 });
    assert.ok(outcome.captureId);
    captureIds.push(outcome.captureId);
  }
  store.sweepNow();
  store.close();
  const turnBytes: number[] = (new DatabaseSync(captureDb, { readOnly: true }).prepare('SELECT bytes FROM turns ORDER BY id').all() as Array<{ bytes: number }>).map((row) => row.bytes);
  // 账本：第 2 轮一笔 403 失败（改绑决策点），第 1 轮一笔成功。
  const audit = new UsageAudit({ db: openDatabase(ledgerDb) });
  audit.insertRow({ ts: 1000, tenant: 't', identity: 'sess-1', identity_kind: 'session', subscription: 'first', model: 'm', path: '/v1/chat/completions', status: 200 }, null);
  audit.insertRow({ ts: 2000, tenant: 't', identity: 'sess-1', identity_kind: 'session', subscription: 'first', model: 'm', path: '/v1/chat/completions', status: 403, capture_id: captureIds[1] }, null);
  audit.close();
  return { dir, captureDb, ledgerDb, turnCaptureIds: captureIds, turnBytes };
}

interface CtxRecord { kind: 'normal' | 'rebind'; chars: number; messages: number; affinity: string | undefined; error?: { backend: string; status: number }; ts: number }

function ctxRecorder(record: CtxRecord[]): { policy: RouterPolicy } {
  return { policy: {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: [
      { name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' },
      { name: 'second', family: 'ocg', base_url: 'https://b', key_env: 'K' },
    ] as Backend[],
    decide(ctx: DecisionCtx) {
      record.push({ kind: ctx.error ? 'rebind' : 'normal', chars: ctx.request.chars, messages: ctx.request.messages, affinity: ctx.session.affinity, error: ctx.error ? { backend: ctx.error.backend, status: ctx.error.status } : undefined, ts: ctx.now });
      return ctx.error ? 'keep' : { backend: 'first', reason: 'pin-first' };
    },
  } };
}

test('replay rebuilds both decision points from the same ctx source as server.ts', (): void => {
  const fx = buildFixture();
  const candidateSeen: CtxRecord[] = [];
  const candidate = ctxRecorder(candidateSeen);
  const baseline: RouterPolicy = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: [
      { name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' },
      { name: 'second', family: 'ocg', base_url: 'https://b', key_env: 'K' },
    ],
    decide() { return null; },
  };
  const result = replayPolicy({
    captureDbFile: fx.captureDb,
    ledgerDbFile: fx.ledgerDb,
    baseline: { label: 'baseline', policy: baseline },
    candidate: { label: 'candidate', policy: candidate.policy },
    tenant: 't',
  });
  assert.equal(result.turns, 3);
  assert.equal(result.rebindPoints, 1);
  // 基线：3 个正常点全 null（交内置），1 个改绑点 null。
  assert.equal(result.baseline.normal.builtin, 3);
  assert.equal(result.baseline.rebind.builtin, 1);
  // 候选：正常点 3 次都挑 first；改绑点 keep。沙盘亲和被自己的决定推进（第 2/3 轮 affinity=first）。
  assert.equal(result.candidate.normal.byBackend.first, 3);
  assert.equal(result.candidate.rebind.keep, 1);
  assert.deepEqual(candidateSeen.filter((entry) => entry.kind === 'normal').map((entry) => entry.affinity), [undefined, 'first', 'first']);
  // ctx 与 server.ts 同源：chars=捕获轮字节、messages=条数、now=录制时间、error 带 status。
  const normal = candidateSeen.find((entry) => entry.kind === 'normal')!;
  assert.equal(normal.chars, fx.turnBytes[0]); // ctx.chars = 捕获轮实际字节（与 server 的 requestView 同口径）
  assert.equal(normal.messages, 2);
  const rebind = candidateSeen.find((entry) => entry.kind === 'rebind')!;
  assert.deepEqual(rebind.error, { backend: 'first', status: 403 });
  assert.ok(rebind.ts > 1e12); // ctx.now = 捕获轮录制时间（turn.ts），不是账本行 ts 也不是回放当时
  // 候选列表按模型/租户过滤同源（routeScope）。
  assert.ok(candidateSeen.every((entry) => entry.affinity !== 'second'));
});

test('replay is dry-run: reads both databases read-only and writes nothing', (): void => {
  const fx = buildFixture();
  const before = fs.readFileSync(fx.captureDb);
  const result = replayPolicy({
    captureDbFile: fx.captureDb,
    ledgerDbFile: fx.ledgerDb,
    baseline: { label: 'old', policy: { models: [{ id: 'm', backends: { ocg: 'x' } }], backends: [{ name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' }], decide() { return null; } } },
    candidate: { label: 'new', policy: { models: [{ id: 'm', backends: { ocg: 'x' } }], backends: [{ name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' }], decide() { return null; } } },
  });
  assert.equal(result.turns, 3);
  assert.deepEqual(fs.readFileSync(fx.captureDb), before); // 库文件逐字节未动
});

test('replay report renders baseline-vs-candidate aligned numbers', (): void => {
  const fx = buildFixture();
  const candidate: RouterPolicy = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: [
      { name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' },
      { name: 'second', family: 'ocg', base_url: 'https://b', key_env: 'K' },
    ],
    decide(ctx) { return ctx.error ? { backend: 'second', reason: 'wall → second' } : null; },
  };
  const baseline: RouterPolicy = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: [
      { name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' },
      { name: 'second', family: 'ocg', base_url: 'https://b', key_env: 'K' },
    ],
    decide() { return null; },
  };
  const result = replayPolicy({
    captureDbFile: fx.captureDb, ledgerDbFile: fx.ledgerDb,
    baseline: { label: 'baseline(mine)', policy: baseline },
    candidate: { label: 'candidate(new)', policy: candidate },
  });
  const text = renderReplayReport(result);
  assert.ok(text.includes('baseline(mine)'));
  assert.ok(text.includes('candidate(new)'));
  assert.ok(text.includes('改绑决策点·decide 被问'));
  assert.ok(text.includes('dry-run'));
  // 候选在改绑点改绑 second，基线交内置——差异行可见。
  assert.ok(text.includes('second'));
});

test('replay skips turns whose model is not in the policy and reports the count', (): void => {
  const fx = buildFixture();
  const result = replayPolicy({
    captureDbFile: fx.captureDb, ledgerDbFile: fx.ledgerDb,
    baseline: { label: 'old', policy: { models: [{ id: 'other', backends: { ocg: 'x' } }], backends: [{ name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' }], decide() { return null; } } },
    candidate: { label: 'new', policy: { models: [{ id: 'm', backends: { ocg: 'x' } }], backends: [{ name: 'first', family: 'ocg', base_url: 'https://a', key_env: 'K' }], decide() { return null; } } },
  });
  assert.equal(result.baseline.turns, 0);
  assert.equal(result.baseline.skipped_model, 3);
  assert.equal(result.candidate.turns, 3);
});
