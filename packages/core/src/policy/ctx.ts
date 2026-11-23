// DecisionCtx 同源构造器（observability 票 02）：server.ts 正常路由与改绑两处决策点、
// 离线回放 harness 都从这一个文件拿 ctx——回放测的就是真实决策环境，别手搓第二份。
// 构造逻辑原样从 server.ts 收编（2026-11-19），行为逐字保持。
import type { Backend, SnapshotView } from '../contracts.ts';
import type { BackendRecent, CandidateView, DecisionCtx } from './contract.ts';
import { currentSnapshot } from '../store/snapshots.ts';

// 近期健康的数据源形状：server 的内存追踪器与回放的「无观察」桩都长这样。
export interface HealthSource {
  view(name: string, now?: number): BackendRecent | undefined;
}

export function candidateViewOf(
  view: SnapshotView,
  backend: Backend,
  health: HealthSource | undefined,
  now = Date.now(),
): CandidateView {
  const raw = view.snapshots[backend.name];
  const snapshot = raw === undefined ? undefined : currentSnapshot(raw, now);
  return {
    name: backend.name, family: backend.family, alias: backend.alias, account: backend.account ?? null,
    priority: Number(backend.priority ?? 0),
    walled: Boolean(snapshot?.fiveHour?.exceeded) || Boolean(snapshot?.weekly?.exceeded),
    snapshot,
    recent: health?.view(backend.name, now),
  };
}

export interface DecisionCtxInput {
  now: number;
  tenant: string;
  // 客户端请求面（server 的 requestView / 回放的捕获轮次同形）。
  model: string;
  chars: number;
  messages: number;
  // 当前亲和订阅名（= 上次路由到谁）；新会话 undefined。
  affinity: string | undefined;
  // 已按「支持该模型 + 租户池」过滤的候选（过滤逻辑见 routeScope——同样同源）。
  candidates: Backend[];
  snapshots: SnapshotView;
  health?: HealthSource;
  // 仅改绑决策点出现：刚失败的后端与错误；正常路由不带。
  error?: { backend: string; status: number; retryAfterMs: number | null };
}

export function decisionCtx(input: DecisionCtxInput): DecisionCtx {
  const request = { model: input.model, chars: input.chars, messages: input.messages };
  const candidates = input.candidates.map((candidate) => candidateViewOf(input.snapshots, candidate, input.health, input.now));
  const session = { affinity: input.affinity, pin: input.affinity };
  const base = { now: input.now, tenant: input.tenant, request, session, candidates };
  return input.error === undefined ? base : { ...base, error: input.error };
}

// 候选过滤同源：租户池收缩（tenants[].backends 子集）+ 模型支持过滤。
// server 正常路由与回放构造候选都用它，别在调用点手写 filter。
export function routeScope(
  backends: Backend[],
  tenantBackends: string[] | undefined,
  model: { backends: Partial<Record<string, string>> },
): Backend[] {
  const pool = tenantBackends ? backends.filter((candidate) => tenantBackends.includes(candidate.name)) : backends;
  return pool.filter((candidate) => model.backends[candidate.family]);
}
