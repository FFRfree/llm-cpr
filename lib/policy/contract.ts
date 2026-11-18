// Policy-as-code 契约：用户 policy 文件 import type 用的唯一入口。
// 引擎侧硬护栏不在这里（模型支持校验、迁移冷却、探活、鉴权、账本），policy 只回答「去哪、用谁」。
import type { Backend, Endpoint, Family, Model, QuotaSnapshot, RoutingConfig } from '../contracts.ts';
export type { Backend, Endpoint, Family, Model, QuotaSnapshot, RoutingConfig } from '../contracts.ts';

// 喂给 decide 的候选：已按「支持请求的模型」过滤；额度墙不是过滤而是标志位——
// 钉死撞墙是合法决定（代价是原样吃 429/403 透传），内置路径（decide 返回 null）仍会过滤。
export interface CandidateView {
  name: string;
  family: Family;
  alias?: string;
  account?: string | null;
  priority: number;
  // 5h/周窗口撞满（快照过期/未知不算撞满）。
  walled: boolean;
  // undefined = 没有任何快照（未知额度），不是「没额度」。
  snapshot: QuotaSnapshot | undefined;
}

export interface DecisionCtx {
  now: number;
  // 客户端请求的模型 id（config models[].id 口径）；policy 可用 {model} 覆盖实际模型。
  request: { model: string; chars: number; messages: number };
  // pin = 会话当前钉死的订阅名；stale pin（订阅已删）时 candidates 里不会有它。
  // requests/degraded 只在 403/429 出错重试时才有值（平时为 null/false，不做每请求查库）。
  session: { pin?: string; requests: number | null; degraded: boolean };
  // 出错重试时包含 active；正常请求时 active 为空。
  candidates: CandidateView[];
  active?: string;
  // 仅有：上次尝试 403/429 且短 retry-after 重试用尽后。出现即本次 decide 是「迁不迁/迁去谁」。
  error?: { status: number; retryAfterMs: number | null };
}

// {backend} 选中订阅；{model} 覆盖实际模型（Auto 模式口子）；'keep' 维持当前钉死；
// null = 这个决定交给内置逻辑（月欠账 / 长会话阈值 / 尊重钉死）。'keep' 对新会话/失效钉死无效。
export type Decision = { backend: string; model?: string } | 'keep' | null;

// 声明区 = 原 config.json 的整体形状；decide = 策略区。字段名沿用 config 时代的两种拼写。
export interface RouterPolicy {
  backends: Backend[];
  models: Model[];
  listen?: Partial<Endpoint>;
  admin?: Partial<Endpoint>;
  routing?: RoutingConfig;
  master_key_env?: string;
  masterKeyEnv?: string;
  identity_header?: string;
  identityHeader?: string;
  sessions_db?: string;
  // 纯同步本地计算：禁 fetch/DB/长循环。抛错或返回非法值时该次决定回落内置并告警。
  decide?(ctx: DecisionCtx): Decision;
}

// 配置即代码后无「加载后补默认值」这一步；声明方（lib/policy/mine.ts）自己写全。
// LoadedPolicy 曾是 PolicyStore 加载产物的形状，随其退役删除（2026-11-18）。
