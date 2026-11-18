import { providerFor } from '../providers/index.ts';
import type { Backend, Environment, Logger, QuotaSnapshot, SnapshotView } from '../contracts.ts';

export function timestampMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && value ? Date.parse(value) : NaN;
}

// A passed reset invalidates the old observation, not the provider's quota wall.
// Unknown windows use null, never zero usage / exceeded=false; routing may only
// make the same best-effort priority choice as it does with missing snapshots.
export function currentSnapshot(value: QuotaSnapshot = {}, now = Date.now()): QuotaSnapshot {
  const result: QuotaSnapshot = { ...value };
  for (const name of ['fiveHour', 'weekly'] as const) {
    const window = value[name];
    const reset = timestampMs(window?.resetAt);
    if (Number.isFinite(reset) && reset <= now) {
      result[name] = { ...window, used: null, exceeded: null, known: false, expired: true };
      result.known = false;
      result.degraded = true;
    }
  }
  const end = timestampMs(value.periodEnd);
  if (Number.isFinite(end) && end <= now) {
    result.monthlyPercent = null;
    result.monthProgress = null;
    result.known = false;
    result.degraded = true;
  }
  if (value.stale) {
    result.known = false;
    result.degraded = true;
  }
  return result;
}

export interface UsageSnapshotsOptions {
  backends?: Backend[];
  env?: Environment;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export class UsageSnapshots {
  backends: Backend[];
  env: Environment;
  intervalMs: number;
  fetchImpl: typeof fetch;
  now: () => number;
  logger: Logger;
  values: Record<string, QuotaSnapshot>;
  fetchedAt: number | null;
  lastError: Record<string, string>;
  inflight: Promise<SnapshotView> | null;
  timer: NodeJS.Timeout | null;

  constructor({ backends = [], env = process.env, intervalMs = 300_000, fetchImpl = fetch, now = Date.now, logger = console }: UsageSnapshotsOptions = {}) {
    this.backends = backends;
    this.env = env;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.values = {};
    this.fetchedAt = null;
    this.lastError = {};
    this.inflight = null;
    this.timer = null;
  }

  peek(): SnapshotView {
    const now = this.now();
    const snapshots: Record<string, QuotaSnapshot> = {};
    for (const [name, value] of Object.entries(this.values)) {
      const fetchedAt = typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt) ? value.fetchedAt : null;
      const ageMs = fetchedAt === null ? null : now - fetchedAt;
      snapshots[name] = currentSnapshot({ ...structuredClone(value), ageMs, stale: ageMs === null || ageMs >= this.intervalMs * 2 }, now);
    }
    const stale = (this.backends.length > 0 && Object.keys(snapshots).length === 0) || Object.values(snapshots).some((value) => value.stale);
    return { snapshots, fetchedAt: this.fetchedAt, ageMs: this.fetchedAt === null ? null : now - this.fetchedAt, intervalMs: this.intervalMs, stale, degraded: Object.values(snapshots).some((value) => value.degraded), lastError: { ...this.lastError } };
  }

  async refresh(): Promise<SnapshotView> {
    if (this.inflight) return this.inflight;
    this.inflight = this._refresh();
    try { return await this.inflight; } finally { this.inflight = null; }
  }

  async _refresh(): Promise<SnapshotView> {
    const next: Record<string, QuotaSnapshot> = { ...this.values };
    await Promise.all(this.backends.map(async (backend) => {
      try {
        const value = await providerFor(backend).readQuota({ backend, env: this.env, fetchImpl: this.fetchImpl, now: this.now });
        value.fetchedAt = this.now();
        next[backend.name] = value;
        delete this.lastError[backend.name];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError[backend.name] = message;
        next[backend.name] = { ...(this.values[backend.name] || {}), known: false, degraded: true, lastError: message };
        this.logger.warn?.(`[snapshots] ${backend.name}: ${message}; routing by priority`);
      }
    }));
    this.values = next;
    this.fetchedAt = this.now();
    return this.peek();
  }

  start(): void {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
