import type { OutgoingHttpHeaders } from 'node:http';

export type Family = 'ocg' | 'ccg';
export interface Backend {
  // name is the immutable routing/ledger key; alias and account are not substitutes.
  name: string;
  family: Family;
  base_url: string;
  key_env: string;
  account?: string;
  alias?: string;
  priority?: number;
  direct?: boolean;
  usage_base_url?: string;
  status_url?: string;
  admin_url?: string;
  admin_key_env?: string;
}
export interface Model {
  id: string;
  backends: Partial<Record<Family, string>>;
}
// 租户 = 一类调用方的身份键（name 不改，同 backend.name 哲学）。key_env 只存 .env 变量名，密钥不进仓。
// backends/models 缺省 = 共享全池/全部模型；额度仍是上游账号的物理属性，租户不隔离额度（见 ADR-0007）。
export interface Tenant {
  name: string;
  key_env: string;
  backends?: string[];
  models?: string[];
}
export interface RequestConfig {
  models: Model[];
  identityHeader?: string;
}
export interface Identity {
  kind: 'session' | 'fingerprint' | 'address';
  key: string;
}
export type Headers = OutgoingHttpHeaders;
export type Environment = Record<string, string | undefined>;
export interface Logger {
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}
export interface QuotaWindow {
  used: number | null;
  cap?: number | null;
  resetAt?: string | number | null;
  exceeded: boolean | null;
  known?: boolean;
  expired?: boolean;
}
export interface QuotaSnapshot {
  known?: boolean;
  degraded?: boolean;
  monthlyCap?: number | null;
  monthlyRemaining?: number | null;
  monthlySpent?: number | null;
  monthlyPercent?: number | null;
  monthProgress?: number | null;
  periodStart?: string | number | null;
  periodEnd?: string | number | null;
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  fetchedAt?: number;
  ageMs?: number | null;
  stale?: boolean;
  lastError?: string;
}
export interface HeaderContext {
  headers: Headers;
  upstreamKey: string;
  identityHeader?: string;
  identity?: Identity;
}
export interface QuotaContext {
  backend: Backend;
  env: Environment;
  fetchImpl: typeof fetch;
  now: () => number;
}
// Two real implementations, varying together in session headers and quota reads.
export interface ProviderAdapter {
  requestHeaders(context: HeaderContext): Headers;
  readQuota(context: QuotaContext): Promise<QuotaSnapshot>;
}
export type ChatBody = Record<string, unknown>;
export interface PrepareChatRequest extends HeaderContext {
  config: RequestConfig;
  // 显式生效模型（policy 模型覆盖时传）；缺省沿用 config.models 按 body.model 查找。
  model?: Model;
  body: ChatBody;
  backend: Backend;
}
export type ChatUsage = Record<string, unknown>;
export interface UsageCollector {
  write(chunk: Buffer): void;
  end(): ChatUsage | null;
}

export interface RoutingConfig {
  long_session_min_requests?: number;
  upstream_timeout_ms?: number;
  snapshot_interval_ms?: number;
  // 改绑冷却长度（默认 3_600_000）：改绑成功即入冷却，窗口内不再触发改绑决策。
  // 旧名 migration_cooldown_ms 仍被读取（v0.1.0 兼容别名，声明方应改用新名）。
  rebind_cooldown_ms?: number;
  migration_cooldown_ms?: number;
  // 原地短重试（仅 429）：retry-after ≤ wall_retry_max_after_ms 时原地等重试，最多 wall_retry_max_attempts 次。
  // 0 = 关闭原地重试（第一次撞墙直接进改绑决策点）。原地重试不落账本、不问 policy。
  wall_retry_max_attempts?: number;
  wall_retry_max_after_ms?: number;
}
export interface Endpoint {
  host: string;
  port: number;
}
// The policy declaration shape (field names survive from the config.json era); only
// required fields are checked at load. RouterPolicy in policy-contract.ts adds decide().
export interface GatewayConfig extends RequestConfig {
  backends: Backend[];
  models: Model[];
  tenants?: Tenant[];
  listen?: Partial<Endpoint>;
  admin?: Partial<Endpoint>;
  routing?: RoutingConfig;
  master_key_env?: string;
  masterKeyEnv?: string;
  identity_header?: string;
  identityHeader?: string;
  // 数据库单文件（流量账 requests + 事件账 system_events 共库）；旧名 sessions_db 仍被读取。
  db_file?: string;
  sessions_db?: string;
}

// node:sqlite rows and HTTP payloads are untyped at the boundary; these are the
// shapes the gateway itself produces and reads back.
export interface AuditEntry {
  ts?: number | null;
  tenant?: string | null;
  identity?: string | null;
  identity_kind?: string | null;
  subscription?: string | null;
  account?: string | null;
  model?: string | null;
  translated_model?: string | null;
  path?: string | null;
  status?: number | null;
  ms?: number | null;
  ttft_ms?: number | null;
  stream_ms?: number | null;
}
export interface AuditRow {
  id: number;
  ts: number;
  tenant: string;
  identity: string | null;
  identity_kind: string;
  subscription: string | null;
  account: string | null;
  model: string | null;
  translated_model: string | null;
  path: string | null;
  status: number | null;
  ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cache_observed: number;
  cache_outcome: string | null;
  ttft_ms: number | null;
  stream_ms: number | null;
}
export interface CacheLossEvent {
  ts: number;
  previous_prompt_tokens: number;
  cache_hit_tokens: number;
}
export interface SessionSummary {
  tenant?: string;
  identity: string;
  requests: number | null;
  full_miss_rate: number | null;
  loss_events: CacheLossEvent[];
  degraded?: boolean;
  full_misses?: number;
  cache_observed_requests?: number;
}
export interface SubscriptionSummary {
  subscription: string;
  requests: number;
  errors: number;
  total_tokens: number;
  avg_ttft_ms: number | null;
  tps: number | null;
}
export interface AuditSummary {
  requests: number | null;
  sessions: number | null;
  subscriptions: SubscriptionSummary[];
  degraded?: boolean;
}
export interface SnapshotView {
  snapshots: Record<string, QuotaSnapshot>;
  fetchedAt: number | null;
  ageMs: number | null;
  intervalMs: number;
  stale: boolean;
  degraded: boolean;
  lastError: Record<string, string>;
}
