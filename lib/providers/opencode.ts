import type { Backend, HeaderContext, ProviderAdapter, QuotaContext, QuotaSnapshot } from '../contracts.ts';
import { getJson, item, object, requestHeaders, timestamp } from './shared.ts';

const MONTH_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function parseDirect(data: unknown, now: number): QuotaSnapshot {
  const usage = object(object(data).usage);
  const rolling = object(usage.rolling), weekly = object(usage.weekly), monthly = object(usage.monthly);
  const valid = [rolling, weekly, monthly].every((window) => percent(window.percent) !== null && Number.isFinite(Date.parse(String(timestamp(window.resetsAt) || ''))));
  const monthlyResetMs = Date.parse(String(timestamp(monthly.resetsAt) || ''));
  const monthProgress = Number.isFinite(monthlyResetMs) ? 100 * (1 - (monthlyResetMs - now) / MONTH_PERIOD_MS) : null;
  const rollingPercent = percent(rolling.percent), weeklyPercent = percent(weekly.percent), monthlyPercent = percent(monthly.percent);
  return {
    known: valid, degraded: !valid, monthlyPercent, monthProgress,
    periodEnd: timestamp(monthly.resetsAt) || null,
    fiveHour: { used: rollingPercent, cap: 100, resetAt: timestamp(rolling.resetsAt) || null, exceeded: rollingPercent !== null && rollingPercent >= 100 },
    weekly: { used: weeklyPercent, cap: 100, resetAt: timestamp(weekly.resetsAt) || null, exceeded: weeklyPercent !== null && weeklyPercent >= 100 },
  };
}
function parseProxy(data: unknown, backend: Backend): QuotaSnapshot {
  const entries = object(data).accounts;
  const accounts = Array.isArray(entries) ? entries.map(object) : [];
  const match = accounts.find((entry) => entry.name === (backend.account || backend.name)) || accounts[0];
  const raw = object(match?.usage || match);
  const month = Number(item(raw, 'monthly_percent', 'monthlyPercent'));
  const w5 = Number(item(raw, 'rolling_percent', 'fiveHourPercent'));
  const weekly = Number(item(raw, 'weekly_percent', 'weeklyPercent'));
  const monthProgress = Number(item(match, 'month_progress', 'monthProgress'));
  return {
    known: Number.isFinite(month) && Number.isFinite(monthProgress), degraded: !Number.isFinite(month) || !Number.isFinite(monthProgress),
    monthlyPercent: Number.isFinite(month) ? month : null, monthProgress,
    periodStart: timestamp(raw.monthly_start || raw.periodStart), periodEnd: timestamp(raw.monthly_resets_at || raw.periodEnd),
    fiveHour: { used: Number.isFinite(w5) ? w5 : null, cap: 100, resetAt: timestamp(raw.rolling_resets_at || raw.rollingResetAt), exceeded: w5 >= 100 },
    weekly: { used: Number.isFinite(weekly) ? weekly : null, cap: 100, resetAt: timestamp(raw.weekly_resets_at || raw.weeklyResetAt), exceeded: weekly >= 100 },
  };
}
export const openCode: ProviderAdapter = {
  requestHeaders(context: HeaderContext) {
    const headers = requestHeaders(context);
    const sessionKey = (context.identityHeader || 'x-session-id').toLowerCase();
    const primary = headers[sessionKey], legacy = headers['x-opencode-session'];
    delete headers[sessionKey];
    // Resolve the same identity as routing: valid primary, valid legacy, then
    // fingerprint/address. Preserve supplied session bytes (including whitespace).
    const session = typeof primary === 'string' && primary.trim() ? primary
      : typeof legacy === 'string' && legacy.trim() ? legacy : context.identity?.key;
    if (session !== undefined) headers['x-opencode-session'] = session;
    return headers;
  },
  async readQuota({ backend, env, fetchImpl, now }: QuotaContext) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (backend.direct === true) {
      headers['user-agent'] = BROWSER_UA;
      const key = env[backend.key_env];
      if (key) headers.authorization = `Bearer ${key}`;
      return parseDirect(await getJson(fetchImpl, `${backend.base_url.replace(/\/+$/, '')}/usage`, headers), now());
    }
    const url = backend.status_url || backend.admin_url || `${new URL(backend.base_url).origin}/api/route/status`;
    const key = backend.admin_key_env && env[backend.admin_key_env];
    if (key) headers.authorization = `Bearer ${key}`;
    return parseProxy(await getJson(fetchImpl, url, headers), backend);
  },
};
