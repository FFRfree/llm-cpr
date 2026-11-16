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
