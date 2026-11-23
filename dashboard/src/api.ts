// 管理口 API 类型 + 取数 + 展示格式化（与 core 的响应形状一一对应）
export interface SubWindow { used: number | null; cap: number | null; resetAt: string | number | null; exceeded?: boolean | null }
export interface Snapshot {
  fiveHour?: SubWindow; weekly?: SubWindow;
  monthlyPercent?: number | null; monthlyCap?: number | null; monthlySpent?: number | null; monthlyRemaining?: number | null;
  periodEnd?: string | null; fetchedAt?: number | null; known?: boolean; degraded?: boolean;
}
export interface SubDef { name: string; family: 'ocg' | 'ccg'; alias: string; account?: string; models?: string[]; snapshot?: Snapshot }
export interface RouteStatus { subscriptions: SubDef[] }

export interface UsageAgg { requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number }
export interface UsageDay { days: string[]; subscriptions: { subscription: string; by_day: Record<string, UsageAgg>; total: UsageAgg }[]; day_boundary: string }
export interface UsageHour { hours: string[]; subscriptions: { subscription: string; by_hour: Record<string, UsageAgg>; total: UsageAgg }[]; granularity: 'hour'; day_boundary: string }
export interface Summary { requests: number | null; sessions: number | null; subscriptions: { subscription: string; requests: number; errors: number; total_tokens: number; avg_ttft_ms: number | null; tps: number | null }[] }

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const toMs = (x: string | number | null | undefined): number | null =>
  x == null ? null : (typeof x === 'number' ? x : Date.parse(x));

const p2 = (x: number) => String(x).padStart(2, '0');

export const fmtTok = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
};

export function countdown(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.max(0, (ms - Date.now()) / 1000);
  if (s >= 86400 * 2) return Math.floor(s / 86400) + '天后';
  if (s >= 86400) return Math.floor(s / 86400) + '天' + Math.floor((s % 86400) / 3600) + '小时后';
  if (s >= 3600) return Math.floor(s / 3600) + '小时' + Math.floor((s % 3600) / 60) + '分后';
  if (s >= 60) return Math.floor(s / 60) + '分后';
  return Math.floor(s) + '秒后';
}

export const bjStamp = (ts: number | null | undefined): string => {
  if (ts == null) return '尚无';
  const d = new Date(ts);
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// 小时桶标签（UTC 形式 YYYY-MM-DDTHH = BJT 时刻）→ 展示文案
export const hourTick = (l: string): string => l.slice(11) === '00' ? `${+l.slice(5, 7)}/${+l.slice(8, 10)}` : `${l.slice(11)}:00`;
export const dayTick = (l: string): string => `${+l.slice(5, 7)}/${+l.slice(8, 10)}`;
export const hourTip = (l: string): string => `${+l.slice(5, 7)}/${+l.slice(8, 10)} ${l.slice(11)}:00`;
