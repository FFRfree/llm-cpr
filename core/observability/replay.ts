// 策略回放（observability 票 02）：把捕获库的历史轮次离线灌给新旧两个 policy 实例跑 decide，
// 输出对比报告。dry-run 性质：只读两本库（readOnly 连接）、只调 decide、不碰真实上游、
// 不写任何生产数据。ctx 构造与 server.ts 同源（core/policy/ctx.ts 的 decisionCtx/routeScope）。
//
// 口径与已知近似（读报告前先看）：
// - 回放时钟 = 录制时间（turn.ts）：decide 拿到的 now 与当时一致；引擎层的冷却/快照轮询
//   不在回放内（那是引擎状态，decide 只看 ctx.now）。
// - 快照额度状态不回放：捕获库不存历史快照，candidates 的 walled 全 false、snapshot 未知——
//   decide 若依赖 walled 分支，回放结果与真实路由会有差，看报告时记住这一层。
// - 改绑决策点：只重放走到决策点的失败笔（data.db 里 403/429 的账本行）——原地短重试
//   不落账本（引擎口径），回放也不问，两边一致。retryAfterMs 无法从账本还原，恒 null。
// - affinity 模拟：同一 (tenant, identity) 内，用「该 policy 自己上一个决定的目标后端」当
//   亲和（模拟引擎钉死）；policy 返回 null/'keep' 时亲和不变。这不是引擎历史，是沙盘自身状态。
import { DatabaseSync } from 'node:sqlite';
import { decisionCtx, routeScope } from '../policy/ctx.ts';
import type { Backend, SnapshotView } from '../contracts.ts';
import type { DecisionCtx, RouterPolicy } from '../policy/contract.ts';

export interface ReplaySide { label: string; policy: RouterPolicy }
export interface ReplayInput {
  captureDbFile: string;
  ledgerDbFile: string;
  baseline: ReplaySide;
  candidate: ReplaySide;
  tenant?: string;
  since?: number;
  until?: number;
  limit?: number;
}
export interface ReplayOutcomeBuckets {
  total: number;
  keep: number;
  builtin: number;   // decide 返回 null/undefined → 交内置（内置逻辑本身不在回放内）
  threw: number;     // decide 抛错（真实路径此时回落内置并落 policy.error）
  byBackend: Record<string, number>;
}
export interface ReplaySideReport {
  label: string;
  turns: number;
  skipped_model: number;
  normal: ReplayOutcomeBuckets;
  rebind: ReplayOutcomeBuckets;
}
export interface ReplayResult {
  window: { since: number | null; until: number | null; tenant: string | null };
  turns: number;
  rebindPoints: number;
  baseline: ReplaySideReport;
  candidate: ReplaySideReport;
  notes: string[];
}

interface TurnRow {
  capture_id: string;
  ts: number;
  tenant: string;
  identity: string | null;
  identity_kind: string;
  model: string;
  message_count: number;
  bytes: number;
}

const emptyBuckets = (): ReplayOutcomeBuckets => ({ total: 0, keep: 0, builtin: 0, threw: 0, byBackend: {} });
const emptyReport = (label: string): ReplaySideReport => ({ label, turns: 0, skipped_model: 0, normal: emptyBuckets(), rebind: emptyBuckets() });

// 快照未知视图：与 server 首启（快照未刷新时）peek 的形状一致——walled 全 false。
const unknownSnapshotView = (): SnapshotView => ({ snapshots: {}, fetchedAt: null, ageMs: null, intervalMs: 0, stale: true, degraded: true, lastError: {} });

const ask = (policy: RouterPolicy, ctx: DecisionCtx, buckets: ReplayOutcomeBuckets): { backend?: string; keep: boolean } => {
  buckets.total += 1;
  try {
    const decision = typeof policy.decide === 'function' ? policy.decide(ctx) ?? null : null;
    if (decision === 'keep') { buckets.keep += 1; return { backend: undefined, keep: true }; }
    if (decision && typeof decision === 'object') {
      buckets.byBackend[decision.backend] = (buckets.byBackend[decision.backend] ?? 0) + 1;
      return { backend: decision.backend, keep: false };
    }
    buckets.builtin += 1;
    return { backend: undefined, keep: false };
  } catch {
    buckets.threw += 1;
    return { backend: undefined, keep: false };
  }
};

export function replayPolicy(input: ReplayInput): ReplayResult {
  // 只读连接：回放绝不写任何一本库。捕获库不存在/打不开 → 明确报错。
  const capture = new DatabaseSync(input.captureDbFile, { readOnly: true });
  const ledger = new DatabaseSync(input.ledgerDbFile, { readOnly: true });
  try {
    const limit = Math.max(1, Math.min(50_000, Math.trunc(Number(input.limit) || 5000)));
    const where: string[] = [];
    const args: (number | string)[] = [];
    if (input.tenant !== undefined) { where.push('tenant = ?'); args.push(input.tenant); }
    if (input.since !== undefined) { where.push('ts >= ?'); args.push(Math.trunc(input.since)); }
    if (input.until !== undefined) { where.push('ts <= ?'); args.push(Math.trunc(input.until)); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const turns = (capture.prepare(`SELECT capture_id, ts, tenant, identity, identity_kind, model, message_count, bytes FROM turns${clause} ORDER BY ts ASC, id ASC LIMIT ${limit}`).all(...args) as unknown as TurnRow[]);

    const reports = new Map<string, ReplaySideReport>([
      [input.baseline.label, emptyReport(input.baseline.label)],
      [input.candidate.label, emptyReport(input.candidate.label)],
    ]);
    // 改绑决策点从账本取：每个 turn 的 403/429 失败行（逐笔，两份报告共用同一组点）。
    const failQuery = ledger.prepare('SELECT subscription, status FROM requests WHERE capture_id = ? AND status IN (403, 429) ORDER BY id ASC');
    let rebindPoints = 0;
    // 沙盘亲和状态：policy 自己上一个决定的目标（模拟引擎钉死），按 side 分别记账。
    const affinity = new Map<string, string>();
    for (const turn of turns) {
      const failures = failQuery.all(turn.capture_id) as unknown as Array<{ subscription: string | null; status: number }>;
      rebindPoints += failures.length;
      for (const side of [input.baseline, input.candidate]) {
        const report = reports.get(side.label)!;
        const policy = side.policy;
        const model = policy.models.find((entry) => entry.id === turn.model);
        if (!model) { report.skipped_model += 1; continue; }
        const tenantDecl = (policy.tenants ?? []).find((entry) => entry.name === turn.tenant);
        const tenantBackends = tenantDecl?.backends
          ? policy.backends.filter((backend) => tenantDecl.backends!.includes(backend.name))
          : policy.backends;
        const candidates: Backend[] = routeScope(tenantBackends, undefined, model);
        const affinityKey = `${turn.tenant}\u0000${turn.identity ?? ''}`;
        const view = unknownSnapshotView();
        const shared = { now: turn.ts, tenant: turn.tenant, model: turn.model, chars: turn.bytes, messages: turn.message_count, candidates, snapshots: view };
        // 正常路由决策点。
        const normalAffinity = affinity.get(affinityKey);
        const normalPick = ask(policy, decisionCtx({ ...shared, affinity: normalAffinity }), report.normal);
        if (normalPick.backend) affinity.set(affinityKey, normalPick.backend);
        // 改绑决策点（每笔失败一次；沙盘亲和用「刚失败的后端」，与真实 errorCtx 语义一致）。
        for (const failure of failures) {
          const rebindPick = ask(policy, decisionCtx({
            ...shared,
            affinity: failure.subscription ?? normalAffinity,
            error: { backend: failure.subscription ?? 'unknown', status: failure.status, retryAfterMs: null },
          }), report.rebind);
          if (rebindPick.backend) affinity.set(affinityKey, rebindPick.backend);
        }
        report.turns += 1;
      }
    }
    return {
      window: { since: input.since ?? null, until: input.until ?? null, tenant: input.tenant ?? null },
      turns: turns.length,
      rebindPoints,
      baseline: reports.get(input.baseline.label)!,
      candidate: reports.get(input.candidate.label)!,
      notes: [
        '回放时钟 = 录制时间；快照额度状态不回放（walled 全 false，依赖 walled 的 decide 分支会有差）',
        '改绑决策点只重放走到决策点的失败笔（原地短重试不落账本，两边口径一致）；retryAfterMs 恒 null',
        'affinity 是沙盘自身状态（该 policy 上一个决定的目标），不是引擎历史',
        'dry-run：全程只读两本库，不碰上游、不写账本',
      ],
    };
  } finally {
    capture.close();
    ledger.close();
  }
}

// 终端报告（人类可读）：关键数字与基线逐项对齐。
export function renderReplayReport(result: ReplayResult): string {
  const lines: string[] = [];
  const window = [
    result.window.tenant !== null ? `tenant=${result.window.tenant}` : 'tenant=全部',
    result.window.since !== null ? `since=${new Date(result.window.since).toISOString()}` : null,
    result.window.until !== null ? `until=${new Date(result.window.until).toISOString()}` : null,
  ].filter(Boolean).join(' ');
  lines.push(`回放 ${result.turns} 轮（${window}），改绑决策点 ${result.rebindPoints} 个`);
  const backends = [...new Set([...Object.keys(result.baseline.normal.byBackend), ...Object.keys(result.candidate.normal.byBackend), ...Object.keys(result.baseline.rebind.byBackend), ...Object.keys(result.candidate.rebind.byBackend)])].sort();
  const row = (name: string, a: number | string, b: number | string): string => `${name.padEnd(28)}${String(a).padStart(15)}${String(b).padStart(18)}`;
  lines.push('');
  lines.push(row('指标', result.baseline.label.slice(0, 14), result.candidate.label.slice(0, 17)));
  lines.push('-'.repeat(60));
  for (const [kind, label] of [['normal', '正常路由'], ['rebind', '改绑决策点']] as const) {
    const a = result.baseline[kind], b = result.candidate[kind];
    lines.push(row(`${label}·decide 被问`, a.total, b.total));
    for (const backend of backends) lines.push(row(`  → ${backend}`, a.byBackend[backend] ?? 0, b.byBackend[backend] ?? 0));
    lines.push(row('  → keep（保亲和）', a.keep, b.keep));
    lines.push(row('  → null（交内置）', a.builtin, b.builtin));
    lines.push(row('  → decide 抛错', a.threw, b.threw));
  }
  lines.push(row('轮次（模型缺失跳过）', `${result.baseline.turns}（${result.baseline.skipped_model}）`, `${result.candidate.turns}（${result.candidate.skipped_model}）`));
  lines.push('');
  for (const note of result.notes) lines.push(`注：${note}`);
  return lines.join('\n');
}
