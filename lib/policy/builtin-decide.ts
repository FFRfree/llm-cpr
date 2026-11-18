// 内置决策：decide 返回 null 时的兜底，行为 = config 时代的原逻辑（月欠账评分、
// 长会话保缓存、尊重钉死）。用户 policy 坏掉时引擎也回到这里，所以它必须独立于 policy 可测。
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
}

// orderedBackends：内置决定带完整有序候选，引擎沿它探活（与旧行为一致——逐个试到第一个健康者）。
// 用户 policy 的决定只有一个目标，引擎只探那一个。
export interface BuiltinDecision {
  decision: Decision;
  note: string | null;
  orderedBackends?: Backend[];
}

export function builtinDecide(ctx: DecisionCtx, { backends, model, snapshots, longSessionMin }: BuiltinOptions): BuiltinDecision {
  const pin = ctx.session.pin;
  if (ctx.error) {
    // 长会话保缓存：请求轮数达到阈值的会话不做额度迁移——换后端会作废上游 prompt cache，
    // 宁可让 agent 稍后重试原后端（阈值 routing.long_session_min_requests，默认 10，0 关闭）。
    // Missing/degraded history is not evidence that this is a short session.
    const requestCount = ctx.session.requests;
    const stickyLong = longSessionMin > 0 && (ctx.session.degraded === true
      || typeof requestCount !== 'number' || requestCount >= longSessionMin);
    if (stickyLong) return { decision: 'keep', note: 'builtin:sticky-long' };
    let alternates: Backend[] = [];
    try {
      alternates = rankBackends({ backends: backends.filter((candidate) => candidate.name !== ctx.active), snapshots, model: model.backends });
    } catch {}
    if (!alternates.length) return { decision: 'keep', note: 'builtin:no-alternate' };
    return { decision: { backend: alternates[0].name }, note: `builtin:migrate->${alternates[0].name}`, orderedBackends: alternates };
  }
  const pinnedBackend = pin ? backends.find((candidate) => candidate.name === pin) : undefined;
  if (pin && pinnedBackend && !ctx.candidates.some((candidate) => candidate.name === pin)) {
    // 钉死订阅还在声明里但不支持请求的模型：客户端/配置错配，透传 400（旧行为）。
    throw Object.assign(new Error(`model ${model.id} is not available on ${pinnedBackend.family}`), { statusCode: 400 });
  }
  if (pin && pinnedBackend) return { decision: 'keep', note: null };
  // 新会话，或钉死订阅已从声明下线（stale pin）：月欠账评分重选。
  const ranked = rankBackends({ backends, snapshots, model: model.backends });
  if (!ranked.length) throw Object.assign(new Error('all eligible subscriptions are window-limited'), { statusCode: 429 });
  const note = pin ? `builtin:reselect->${ranked[0].name}` : `builtin:select->${ranked[0].name}`;
  return { decision: { backend: ranked[0].name }, note, orderedBackends: ranked };
}
