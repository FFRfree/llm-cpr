import { currentSnapshot, timestampMs } from '../store/snapshots.ts';
import type { Backend, Family, QuotaSnapshot } from '../contracts.ts';

function pct(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function timeProgress(snapshot: QuotaSnapshot, now: number): number | null {
  const recorded = snapshot.monthProgress;
  if (typeof recorded === 'number' && Number.isFinite(recorded)) return pct(recorded);
  const start = timestampMs(snapshot.periodStart);
  const end = timestampMs(snapshot.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return pct(100 * (now - start) / (end - start));
}

export function monthlyDebtScore(snapshot: QuotaSnapshot | undefined, now = Date.now()): number | null {
  const current = currentSnapshot(snapshot, now);
  if (current.degraded || current.known === false) return null;
  const progress = timeProgress(current, now);
  const used = pct(current.monthlyPercent);
  if (progress === null || used === null) return null;
  return progress - used;
}

export interface RankOptions {
  backends: Backend[];
  snapshots?: Record<string, QuotaSnapshot | undefined>;
  model?: Partial<Record<Family, string>>;
  now?: number;
}

export function rankBackends({ backends, snapshots = {}, model, now = Date.now() }: RankOptions): Backend[] {
  const current: Record<string, QuotaSnapshot> = {};
  for (const [name, value] of Object.entries(snapshots)) current[name] = currentSnapshot(value, now);
  const candidates = backends.filter((backend) => model?.[backend.family]);
  if (!candidates.length) throw Object.assign(new Error('model is not available on configured backends'), { statusCode: 400 });
  const available = candidates.filter((backend) => {
    const snap = current[backend.name];
    return !snap?.fiveHour?.exceeded && !snap?.weekly?.exceeded;
  });
  if (!available.length) return [];
  const allKnown = available.every((backend) => current[backend.name]?.known);
  const priority = (a: Backend, b: Backend): number => Number(a.priority ?? 0) - Number(b.priority ?? 0);
  if (!allKnown) return [...available].sort(priority);
  const nonExhausted = available.filter((backend) => Number(current[backend.name]?.monthlyPercent) < 100);
  const pool = nonExhausted.length ? nonExhausted : available;
  return [...pool].sort((a, b) => {
    const scoreA = monthlyDebtScore(current[a.name], now);
    const scoreB = monthlyDebtScore(current[b.name], now);
    if (scoreA === null || scoreB === null) return priority(a, b);
    return scoreB - scoreA || priority(a, b);
  });
}

export function selectBackend(options: RankOptions): Backend {
  const ranked = rankBackends(options);
  if (!ranked.length) throw Object.assign(new Error('all eligible subscriptions are window-limited'), { statusCode: 429 });
  return ranked[0];
}
