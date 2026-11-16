import type { HeaderContext, ProviderAdapter, QuotaContext, QuotaSnapshot, QuotaWindow } from '../contracts.ts';
import { getJson, item, object, requestHeaders, timestamp } from './shared.ts';

function windowData(source: unknown, name: string): QuotaWindow {
  const w = object(object(source)[name]);
  const used = Number(item(w, 'used', 'usedAmount') ?? undefined);
  const cap = Number(item(w, 'cap', 'limit') ?? undefined);
  return {
    used: Number.isFinite(used) ? used : null,
    cap: Number.isFinite(cap) ? cap : null,
    resetAt: timestamp(item(w, 'resetAt', 'resetsAt')),
    exceeded: w.exceeded === true || (Number.isFinite(used) && Number.isFinite(cap) && cap > 0 && used >= cap),
  };
}
function parseQuota(creditsBody: unknown, usage: unknown, subscriptions: unknown): QuotaSnapshot {
  const body = object(creditsBody);
  const credits = body.credits && typeof body.credits === 'object' ? object(body.credits) : body;
  const windows = body.windowLimits ?? credits.windows ?? credits;
  const monthlyRemaining = Number(item(credits, 'monthlyCredits', 'monthlyRemaining'));
  const spent = Number(item(usage, 'totalCost', 'total_cost'));
  const monthlyCap = Number.isFinite(monthlyRemaining) && Number.isFinite(spent) ? monthlyRemaining + spent : Number(item(credits, 'monthlyCap'));
  const monthlyPercent = monthlyCap > 0 && Number.isFinite(spent) ? 100 * spent / monthlyCap : null;
  return {
    known: Number.isFinite(monthlyPercent), degraded: !Number.isFinite(monthlyPercent),
    monthlyCap: Number.isFinite(monthlyCap) ? monthlyCap : null,
    monthlyRemaining: Number.isFinite(monthlyRemaining) ? monthlyRemaining : null,
    monthlySpent: Number.isFinite(spent) ? spent : null,
    monthlyPercent,
    fiveHour: windowData(windows, 'fiveHour'), weekly: windowData(windows, 'weekly'),
    periodStart: timestamp(item(subscriptions, 'periodStart', 'currentPeriodStart', 'startAt')),
    periodEnd: timestamp(item(subscriptions, 'periodEnd', 'currentPeriodEnd', 'endAt')),
  };
}
export const commandCode: ProviderAdapter = {
  requestHeaders(context: HeaderContext) {
    const headers = requestHeaders(context);
    delete headers[(context.identityHeader || 'x-session-id').toLowerCase()];
    delete headers['x-opencode-session'];
    return headers;
  },
  async readQuota({ backend, env, fetchImpl }: QuotaContext) {
    const base = backend.usage_base_url || new URL(backend.base_url).origin;
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = env[backend.key_env];
    if (key) headers.authorization = `Bearer ${key}`;
    const root = `${base.replace(/\/+$/, '')}/alpha`;
    const [credits, usage, subscriptions] = await Promise.all([
      getJson(fetchImpl, `${root}/billing/credits`, headers),
      getJson(fetchImpl, `${root}/usage/summary`, headers),
      getJson(fetchImpl, `${root}/billing/subscriptions`, headers),
    ]);
    return parseQuota(credits, usage, object(subscriptions).data ?? subscriptions);
  },
};
