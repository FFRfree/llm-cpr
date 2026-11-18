// 内置决策：decide 返回 null 时的兜底，行为 = config 时代的原逻辑（月欠账评分、
// 长会话保亲和、尊重亲和）。用户 policy 坏掉时引擎也回到这里，所以它必须独立于 policy 可测。
import { rankBackends } from './selection.ts';
import type { Backend, Model } from '../contracts.ts';
import type { Decision, DecisionCtx } from './contract.ts';
import type { QuotaSnapshot } from '../contracts.ts';

export interface BuiltinOptions {
  // 全量声明（不只是 ctx.candidates）：重选/备选排序要在完整集合上做。
  backends: Backend[];
  // 请求的模型条目：候选过滤与 400 错配信息都以它为准。
  model: Model;
  snapshots: Record<string, QuotaSnapshot | undefined>;
  longSessionMin: number;
  // 错误路径的账本会话概要（长会话判定数据源）。正常路径不传——keep-affinity 只在错误分支消费；
  // server 的 keep-affinity 前置护栏已经用同一数据源先行判断过（命中即不问 policy、也不到这里）。
  sessionUsage?: { requests: number | null; degraded: boolean };
}

// 内置决定的三种结局：
// - decision: 'keep' + hold —— 撞墙但不改绑（护栏），server 据此落 route.hold 事件；
// - decision: {backend} + note —— 换了目标，note 是内置的标准短语（进事件 detail.note）；
// - orderedBackends —— 内置决定带完整有序候选，引擎沿它探活（与旧行为一致——逐个试到第一个健康者）。
// 用户 policy 的决定只有一个目标，引擎只探那一个。
export interface BuiltinDecision {
  decision: Decision;
  note?: string;
  hold?: 'keep-affinity' | 'no-alternate';
  orderedBackends?: Backend[];
}

export function builtinDecide(ctx: DecisionCtx, { backends, model, snapshots, longSessionMin, sessionUsage }: BuiltinOptions): BuiltinDecision {
  const affinity = ctx.session.affinity ?? ctx.session.pin;
  if (ctx.error) {
    // 长会话保亲和：请求轮数达到阈值的会话不改绑——换后端会作废上游 prompt cache，
    // 宁可让 agent 稍后重试原后端（阈值 routing.long_session_min_requests，默认 10，0 关闭）。
    // Missing/degraded history is not evidence that this is a short session.
    // 注：server 的 keep-affinity 前置护栏已用同一数据源先行判断；走到这里的兜底分支通常已非长会话，
    // 保留同一判定是为「直接调用 builtinDecide 的路径」保持独立正确。
    const requestCount = sessionUsage?.requests;
    const stickyLong = longSessionMin > 0 && (sessionUsage?.degraded === true
      || typeof requestCount !== 'number' || requestCount >= longSessionMin);
    if (stickyLong) return { decision: 'keep', hold: 'keep-affinity' };
    let alternates: Backend[] = [];
    try {
      alternates = rankBackends({ backends: backends.filter((candidate) => candidate.name !== ctx.error?.backend), snapshots, model: model.backends });
    } catch {}
    if (!alternates.length) return { decision: 'keep', hold: 'no-alternate' };
    return { decision: { backend: alternates[0].name }, note: 'monthly-debt', orderedBackends: alternates };
  }
  const pinnedBackend = affinity ? backends.find((candidate) => candidate.name === affinity) : undefined;
  if (affinity && pinnedBackend && !ctx.candidates.some((candidate) => candidate.name === affinity)) {
    // 钉死亲和还在声明里但不支持请求的模型：客户端/配置错配，透传 400（旧行为）。
    throw Object.assign(new Error(`model ${model.id} is not available on ${pinnedBackend.family}`), { statusCode: 400 });
  }
  if (affinity && pinnedBackend) return { decision: 'keep' };
  // 新会话，或亲和目标已从声明下线（stale）：月欠账评分重选。
  const ranked = rankBackends({ backends, snapshots, model: model.backends });
  if (!ranked.length) throw Object.assign(new Error('all eligible subscriptions are window-limited'), { statusCode: 429 });
  return { decision: { backend: ranked[0].name }, note: 'monthly-debt', orderedBackends: ranked };
}
