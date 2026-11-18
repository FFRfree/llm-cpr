// Policy-as-code 契约：用户 policy 文件 import type 用的唯一入口。
// 引擎侧硬护栏不在这里（模型支持校验、迁移冷却、探活、鉴权、账本、长会话保缓存），policy 只回答「发给谁」。
import type { Backend, Endpoint, Family, Model, QuotaSnapshot, RoutingConfig } from '../contracts.ts';
export type { Backend, Endpoint, Family, Model, QuotaSnapshot, RoutingConfig } from '../contracts.ts';

// 后端近期健康：record() 记账路径喂入的内存追踪（见 server.ts），窗口 10 分钟。
// undefined = 窗口内没观察到失败 —— 观察不到 ≠ 事情没发生（引擎刚重启、流量稀疏都如此），别当健康保证。
export interface BackendRecent {
  fails: number;         // 窗口内失败笔数（全 identity 聚合；499 客户端取消不计）
  lastStatus?: number;   // 最近一次失败的状态码（403/429=额度信号，5xx/504=服务信号，结合 walled 解读）
  lastErrorAt?: number;  // 最近一次失败的时间戳
}

// 喂给 decide 的候选：已按「支持请求的模型」过滤；额度墙不是过滤而是标志位——
// 钉死撞墙是合法决定（代价是原样吃 429/403 透传），内置路径（decide 返回 null）仍会过滤。
export interface CandidateView {
  name: string;
  family: Family;
  alias?: string;
  account?: string | null;
  priority: number;
  // 5h/周窗口撞满（快照过期/未知不算撞满）。额度问题看这里。
  walled: boolean;
  // undefined = 没有任何快照（未知额度），不是「没额度」。
  snapshot: QuotaSnapshot | undefined;
  // 后端近期健康（服务质量问题看这里）。窗口内没失败/刚重启 → undefined。
  recent?: BackendRecent;
}

export interface DecisionCtx {
  now: number;
  // 客户端请求的模型 id（config models[].id 口径）；policy 可用 {model} 覆盖实际模型。
  // chars = 整个请求体 JSON 的字节数（≈上下文大小，不是 token 数）；messages = 消息条数（精确值）。
  request: { model: string; chars: number; messages: number };
  // pin = 上一次路由到的后端（会话钉死的订阅名）；新会话 undefined。
  // stale pin（订阅已删）时 candidates 里不会有它。
  session: { pin?: string };
  candidates: CandidateView[];
  // 仅迁移决策点出现：原地短重试（引擎自治，policy 不可见）烧尽后，刚失败的后端与错误。
  // 出现即本次 decide 是「迁不迁/迁去谁」；正常路由时无此字段。
  // 长会话保缓存是引擎前置护栏（sticky-long 命中时不问 policy），policy 无需也无法处理长会话。
  error?: { backend: string; status: number; retryAfterMs: number | null };
}

// {backend} 选中订阅；{model} 覆盖实际模型（Auto 模式口子）；'keep' 维持当前钉死；
// null = 这个决定交给内置逻辑（月欠账 / 尊重钉死；错误路径 = 内置备选排序）。
// 迁移决策点：{backend} = 迁到该订阅；'keep' = 不迁、原错误透传；backend === error.backend 按 'keep' 处理。
// 迁移频率口径：单请求内自动迁移 ≤1 次、冷却窗口内 ≤1 次（迁移即入冷却）；长会话 = 0（护栏）。
// 正常路径覆写不受冷却前置检查限制，但每次成功都刷新冷却计时——逃生口，别写成高频动作。
export type Decision = { backend: string; model?: string } | 'keep' | null;

// 声明区 = 原 config.json 的整体形状；decide = 策略区（唯一钩子，两个决策点共用）。
// 字段名沿用 config 时代的两种拼写。
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
