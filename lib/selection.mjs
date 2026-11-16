import { currentSnapshot, timestampMs } from './snapshots.mjs';

function pct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function timeProgress(snapshot, now) {
  if (Number.isFinite(snapshot.monthProgress)) return pct(snapshot.monthProgress);
  const start = timestampMs(snapshot.periodStart);
  const end = timestampMs(snapshot.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return pct(100 * (now - start) / (end - start));
}

export function monthlyDebtScore(snapshot, now = Date.now()) {
  snapshot = currentSnapshot(snapshot, now);
  if (snapshot.degraded || snapshot.known === false) return null;
  const progress = timeProgress(snapshot, now);
  if (progress === null || !Number.isFinite(snapshot.monthlyPercent)) return null;
  return progress - pct(snapshot.monthlyPercent);
}

export function rankBackends({ backends, snapshots = {}, model, now = Date.now() }) {
  snapshots = Object.fromEntries(Object.entries(snapshots).map(([name, value]) => [name, currentSnapshot(value, now)]));
  const candidates = backends.filter((backend) => model?.[backend.family]);
  if (!candidates.length) throw Object.assign(new Error('model is not available on configured backends'), { statusCode: 400 });
  const available = candidates.filter((backend) => {
    const snap = snapshots[backend.name];
    return !snap?.fiveHour?.exceeded && !snap?.weekly?.exceeded;
  });
  if (!available.length) return [];
  const allKnown = available.every((backend) => snapshots[backend.name]?.known);
  const priority = (a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0);
  if (!allKnown) return [...available].sort(priority);
  const nonExhausted = available.filter((b) => Number(snapshots[b.name]?.monthlyPercent) < 100);
  const pool = nonExhausted.length ? nonExhausted : available;
  return [...pool].sort((a, b) => {
    const scoreA = monthlyDebtScore(snapshots[a.name], now);
    const scoreB = monthlyDebtScore(snapshots[b.name], now);
    if (scoreA === null || scoreB === null) return priority(a, b);
    return scoreB - scoreA || priority(a, b);
  });
}

export function selectBackend({ backends, snapshots = {}, model, now = Date.now() }) {
  const ranked = rankBackends({ backends, snapshots, model, now });
  if (!ranked.length) throw Object.assign(new Error('all eligible subscriptions are window-limited'), { statusCode: 429 });
  return ranked[0];
}
