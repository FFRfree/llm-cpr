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
}
export interface Endpoint {
  host: string;
  port: number;
}
// The on-disk config.json shape; only the required fields are checked at load.
export interface GatewayConfig extends RequestConfig {
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
}
// loadConfig() fills every default, so routing code never re-derives them.
export interface LoadedConfig extends GatewayConfig {
  listen: Endpoint;
  admin: Endpoint;
  masterKeyEnv: string;
  identityHeader: string;
}

// node:sqlite rows and HTTP payloads are untyped at the boundary; these are the
// shapes the gateway itself produces and reads back.
export interface AuditEntry {
  ts?: number | null;
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
