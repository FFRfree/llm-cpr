const REQUEST_TIMEOUT_MS = 5000;
const OCG_MONTH_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const OCG_BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function getJson(fetchImpl, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function item(obj, ...keys) {
  for (const key of keys) if (obj?.[key] !== undefined) return obj[key];
  return undefined;
}
function windowData(source, name, usedValue, capValue) {
  const w = source?.[name] || {};
  const used = Number(item(w, 'used', 'usedAmount') ?? usedValue);
  const cap = Number(item(w, 'cap', 'limit') ?? capValue);
  return {
    used: Number.isFinite(used) ? used : null,
    cap: Number.isFinite(cap) ? cap : null,
    resetAt: item(w, 'resetAt', 'resetsAt') ?? null,
    exceeded: w.exceeded === true || (Number.isFinite(used) && Number.isFinite(cap) && cap > 0 && used >= cap),
  };
}
function parseCcg(creditsBody, usage, subscriptions) {
  // 真实 /alpha/billing/credits 把额度嵌在 .credits、窗口嵌在 .windowLimits；
  // 兼容旧/扁平形状：字段已在顶层时原样用。
  const credits = (creditsBody?.credits && typeof creditsBody.credits === 'object')
    ? creditsBody.credits : creditsBody;
  const windows = creditsBody?.windowLimits ?? credits?.windows ?? credits ?? {};
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
    fiveHour: windowData(windows, 'fiveHour'),
    weekly: windowData(windows, 'weekly'),
    periodStart: item(subscriptions, 'periodStart', 'currentPeriodStart', 'startAt') ?? null,
    periodEnd: item(subscriptions, 'periodEnd', 'currentPeriodEnd', 'endAt') ?? null,
  };
}
function parseOcgDirect(data, now) {
  const usage = data?.usage;
  const rolling = usage?.rolling;
  const weekly = usage?.weekly;
  const monthly = usage?.monthly;
  const windows = [rolling, weekly, monthly];
  const valid = windows.every((window) => Number.isFinite(window?.percent)
    && Number.isFinite(Date.parse(window?.resetsAt || '')));
  const monthlyResetMs = Date.parse(monthly?.resetsAt || '');
  const monthProgress = Number.isFinite(monthlyResetMs)
    ? 100 * (1 - (monthlyResetMs - now) / OCG_MONTH_PERIOD_MS)
    : null;
  const rollingPercent = Number.isFinite(rolling?.percent) ? rolling.percent : null;
  const weeklyPercent = Number.isFinite(weekly?.percent) ? weekly.percent : null;
  const monthlyPercent = Number.isFinite(monthly?.percent) ? monthly.percent : null;
  return {
    known: valid,
    degraded: !valid,
    monthlyPercent,
    monthProgress,
    periodEnd: monthly?.resetsAt || null,
    fiveHour: { used: rollingPercent, cap: 100, resetAt: rolling?.resetsAt || null, exceeded: rollingPercent !== null && rollingPercent >= 100 },
    weekly: { used: weeklyPercent, cap: 100, resetAt: weekly?.resetsAt || null, exceeded: weeklyPercent !== null && weeklyPercent >= 100 },
  };
}

function parseOcg(data, backend) {
  const accounts = data?.accounts || [];
  const match = accounts.find((entry) => entry.name === (backend.account || backend.name)) || accounts[0];
  const raw = match?.usage || match || {};
  const month = Number(item(raw, 'monthly_percent', 'monthlyPercent'));
  const w5 = Number(item(raw, 'rolling_percent', 'fiveHourPercent'));
  const weekly = Number(item(raw, 'weekly_percent', 'weeklyPercent'));
  const monthProgress = Number(item(match, 'month_progress', 'monthProgress'));
  return {
    known: Number.isFinite(month) && Number.isFinite(monthProgress), degraded: !Number.isFinite(month) || !Number.isFinite(monthProgress),
    monthlyPercent: Number.isFinite(month) ? month : null,
    monthProgress,
    periodStart: raw.monthly_start || raw.periodStart || null,
    periodEnd: raw.monthly_resets_at || raw.periodEnd || null,
    fiveHour: { used: Number.isFinite(w5) ? w5 : null, cap: 100, resetAt: raw.rolling_resets_at || raw.rollingResetAt || null, exceeded: w5 >= 100 },
    weekly: { used: Number.isFinite(weekly) ? weekly : null, cap: 100, resetAt: raw.weekly_resets_at || raw.weeklyResetAt || null, exceeded: weekly >= 100 },
  };
}

export class UsageSnapshots {
  constructor({ backends = [], env = process.env, intervalMs = 60_000, fetchImpl = fetch, now = Date.now, logger = console } = {}) {
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
  peek() {
    const now = this.now();
    const snapshots = Object.fromEntries(Object.entries(this.values).map(([name, value]) => {
      const ageMs = Number.isFinite(value.fetchedAt) ? now - value.fetchedAt : null;
      return [name, { ...structuredClone(value), ageMs, stale: ageMs === null || ageMs >= this.intervalMs * 2 }];
    }));
    const stale = (this.backends.length > 0 && Object.keys(snapshots).length === 0) || Object.values(snapshots).some((value) => value.stale);
    return { snapshots, fetchedAt: this.fetchedAt, ageMs: this.fetchedAt === null ? null : now - this.fetchedAt, stale, degraded: Object.values(snapshots).some((value) => value.degraded), lastError: { ...this.lastError } };
  }
  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this._refresh();
    try { return await this.inflight; } finally { this.inflight = null; }
  }
  async _refresh() {
    const next = { ...this.values };
    await Promise.all(this.backends.map(async (backend) => {
      try {
        let value;
        if (backend.family === 'ccg') {
          const base = backend.usage_base_url || new URL(backend.base_url).origin;
          const headers = { accept: 'application/json' };
          const key = this.env[backend.key_env];
          if (key) headers.authorization = `Bearer ${key}`;
          const root = `${base.replace(/\/+$/, '')}/alpha`;
          const [credits, usage, subscriptions] = await Promise.all([
            getJson(this.fetchImpl, `${root}/billing/credits`, headers),
            getJson(this.fetchImpl, `${root}/usage/summary`, headers),
            getJson(this.fetchImpl, `${root}/billing/subscriptions`, headers),
          ]);
          value = parseCcg(credits, usage, subscriptions?.data ?? subscriptions);
        } else if (backend.family === 'ocg' && backend.direct === true) {
          const headers = {
            accept: 'application/json',
            'user-agent': OCG_BROWSER_UA,
          };
          const key = this.env[backend.key_env];
          if (key) headers.authorization = `Bearer ${key}`;
          let base = backend.base_url;
          while (base.endsWith('/')) base = base.slice(0, -1);
          value = parseOcgDirect(await getJson(this.fetchImpl, `${base}/usage`, headers), this.now());
        } else {
          const url = backend.status_url || backend.admin_url || `${new URL(backend.base_url).origin}/api/route/status`;
          const headers = { accept: 'application/json' };
          const key = backend.admin_key_env && this.env[backend.admin_key_env];
          if (key) headers.authorization = `Bearer ${key}`;
          value = parseOcg(await getJson(this.fetchImpl, url, headers), backend);
        }
        value.fetchedAt = this.now();
        next[backend.name] = value;
        delete this.lastError[backend.name];
      } catch (error) {
        this.lastError[backend.name] = error.message;
        next[backend.name] = { ...(this.values[backend.name] || {}), known: false, degraded: true, lastError: error.message };
        this.logger.warn?.(`[snapshots] ${backend.name}: ${error.message}; routing by priority`);
      }
    }));
    this.values = next;
    this.fetchedAt = this.now();
    return this.peek();
  }
  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
