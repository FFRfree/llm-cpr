import { useEffect, useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Tabs from '@radix-ui/react-tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { getJson, toMs, fmtTok, countdown, bjStamp, hourTick, dayTick, hourTip } from './api';
import type { RouteStatus, UsageHour, UsageDay, Summary, Snapshot, SubDef, UsageAgg } from './api';

// ── 主题色（与 Tailwind @theme 对齐）──
const LINE_COLORS = ['#1a6fe8', '#1a9e55', '#c77c11', '#9a6fd0', '#d05b6a'];
const severity = (pct: number | null): string =>
  pct == null ? 'var(--color-muted)' : pct >= 80 ? 'var(--color-bad)' : pct >= 50 ? 'var(--color-warn)' : 'var(--color-ok)';

const useMedia = (q: string): boolean => {
  const [on, setOn] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const fn = () => setOn(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [q]);
  return on;
};

// ── 订阅额度：每窗口「用量条 + 时间刻度」双条 ──
interface Win { k: string; pct: number | null; timePct: number | null; color: string; reset: string }

function windowsOf(s: Snapshot): Win[] {
  const now = Date.now();
  const wins = [
    { k: '5小时', len: 5 * 3_600_000, end: toMs(s.fiveHour?.resetAt), used: s.fiveHour?.used, cap: s.fiveHour?.cap },
    { k: '每周', len: 7 * 86_400_000, end: toMs(s.weekly?.resetAt), used: s.weekly?.used, cap: s.weekly?.cap },
  ];
  const mon = s.monthlyCap != null && s.monthlySpent != null
    ? { used: s.monthlySpent, cap: s.monthlyCap }
    : s.monthlyPercent != null ? { used: s.monthlyPercent, cap: 100 } : null;
  if (mon) wins.push({ k: '每月', len: 30 * 86_400_000, end: toMs(s.periodEnd), used: mon.used, cap: mon.cap });
  return wins.map((w) => {
    const pct = w.cap != null && w.used != null ? Math.max(0, Math.min(100, w.used / w.cap * 100)) : null;
    // 滚动窗：resetAt = 终点；月窗上游只给 periodEnd，按 30 天周期近似
    const timePct = w.end != null ? Math.max(0, Math.min(100, (now - (w.end - w.len)) / w.len * 100)) : null;
    return { k: w.k, pct, timePct, color: severity(pct), reset: w.end != null ? countdown(w.end) : '' };
  });
}

function DualBar({ pct, timePct, color }: { pct: number; timePct: number | null; color: string }) {
  return (
    <div className="relative h-2 rounded-full bg-line/70">
      <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 1.5)}%`, background: color }} />
      {timePct != null && (
        <span className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded bg-ink/40" style={{ left: `${timePct}%` }} />
      )}
    </div>
  );
}

function StatusTag({ pct, timePct }: { pct: number; timePct: number | null }) {
  if (timePct == null) return null;
  return pct > timePct
    ? <span className="rounded bg-bad-soft px-1.5 py-px text-[10px] font-medium text-bad">超前</span>
    : <span className="rounded bg-ok-soft px-1.5 py-px text-[10px] font-medium text-ok">有余</span>;
}

function SubCard({ sub, defaultOpen }: { sub: SubDef; defaultOpen: boolean }) {
  const wins = windowsOf(sub.snapshot ?? {}).filter((w) => w.pct != null);
  const worst = wins.length ? wins.reduce((a, b) => (b.pct! > a.pct! ? b : a)) : null;
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group rounded-xl border border-line bg-card shadow-sm">
      <Collapsible.Trigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left">
        <span className="font-semibold">{sub.alias}</span>
        <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${sub.family === 'ccg' ? 'bg-ok-soft text-ok' : 'bg-line/80 text-muted'}`}>
          {sub.family === 'ccg' ? 'CCG' : 'OCG'}
        </span>
        {worst && (
          <span className="ml-auto text-sm font-semibold">
            <span className="mr-1 text-xs font-normal text-muted">{worst.k}</span>
            <span style={{ color: worst.color }}>{worst.pct!.toFixed(0)}%</span>
          </span>
        )}
        <ChevronRight size={15} className="text-muted transition-transform group-data-[state=open]:rotate-90" />
      </Collapsible.Trigger>
      <div className="px-3.5 pb-1">{worst && <DualBar pct={worst.pct!} timePct={worst.timePct} color={worst.color} />}</div>
      <Collapsible.Content className="border-t border-dashed border-line px-3.5 pb-3 pt-2.5 data-[state=closed]:hidden">
        {wins.map((w) => (
          <div key={w.k} className="mb-3 last:mb-0">
            <div className="mb-1.5 flex items-baseline gap-2 text-xs">
              <span className="font-semibold">{w.k}{w.reset && <span className="ml-1.5 text-[11px] font-normal text-muted">{w.reset}重置</span>}</span>
              <span className="ml-auto whitespace-nowrap">
                {w.timePct != null && <span className="text-muted">时间 {w.timePct.toFixed(0)}% · </span>}
                <b style={{ color: w.color }}>用量 {w.pct!.toFixed(0)}%</b>
                <span className="ml-1.5 align-middle"><StatusTag pct={w.pct!} timePct={w.timePct} /></span>
              </span>
            </div>
            <DualBar pct={w.pct!} timePct={w.timePct} color={w.color} />
          </div>
        ))}
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          <span>快照 {bjStamp(sub.snapshot?.fetchedAt ?? null)}</span>
          <span className="font-mono">{sub.name}</span>
        </div>
        {!!sub.models?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sub.models.map((m) => <span key={m} className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] text-muted">{m}</span>)}
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

// ── 实际消耗：Recharts 折线 ──
const RANGES = [
  { v: '1', label: '24h', bucket: 'hour' as const },
  { v: '3', label: '3 天', bucket: 'hour' as const },
  { v: '7', label: '7 天', bucket: 'hour' as const },
  { v: '30', label: '30 天', bucket: 'day' as const },
];

function ChartTip(props: { active?: boolean; label?: string; hour: boolean; payload?: { name: string; value: number; color: string }[] }) {
  const { active, label, hour, payload } = props;
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-[11px] shadow-md">
      <b className="block">{hour && label ? hourTip(String(label)) : label}</b>
      {payload.map((p) => (
        <div key={p.name} className="mt-0.5 flex items-center gap-1.5 text-muted">
          <span className="size-2 rounded-sm" style={{ background: p.color }} />
          {p.name} <b className="text-ink">{fmtTok(p.value)} tok</b>
        </div>
      ))}
    </div>
  );
}

function UsageChart() {
  const [range, setRange] = useState('7');
  const [usage, setUsage] = useState<UsageHour | UsageDay | null>(null);
  const [route, setRoute] = useState<RouteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cfg = RANGES.find((r) => r.v === range)!;

  const load = () => {
    setError(null);
    Promise.all([
      getJson<UsageHour | UsageDay>(`/api/audit/usage?days=${range}&bucket=${cfg.bucket}`),
      getJson<RouteStatus>('/api/route/status').catch(() => null),
    ]).then(([u, r]) => { setUsage(u); setRoute(r); }).catch((e) => setError(String(e.message || e)));
  };
  useEffect(load, [range]);

  const { rows, series } = useMemo(() => {
    if (!usage) return { rows: [], series: [] as { key: string; alias: string; color: string }[] };
    const hour = 'hours' in usage;
    const labels = hour ? usage.hours : usage.days;
    type SubAgg = { subscription: string; by_bucket: Record<string, UsageAgg>; total: UsageAgg };
    const subs: SubAgg[] = usage.subscriptions.map((s) => ({
      subscription: s.subscription,
      by_bucket: ('by_hour' in s ? s.by_hour : s.by_day) as Record<string, UsageAgg>,
      total: s.total,
    }));
    const defs = route?.subscriptions ?? [];
    const byName = new Map(subs.map((s) => [s.subscription, s]));
    const series = defs.filter((d) => byName.has(d.name)).map((d, i) => ({
      key: d.name, alias: `${d.alias}·${d.family === 'ccg' ? 'CCG' : 'OCG'}`, color: LINE_COLORS[i % LINE_COLORS.length],
    }));
    const rows = labels.slice().reverse().map((l) => { // API 最新在前 → x 轴最旧在左、最新在右
      const row: Record<string, string | number> = { label: l };
      for (const s of series) row[s.key] = byName.get(s.key)!.by_bucket[l]?.total_tokens ?? 0;
      return row;
    });
    return { rows, series };
  }, [usage, route]);

  const hour = cfg.bucket === 'hour';
  const tickFmt = hour ? hourTick : dayTick;
  // 横轴锚整点：24h 每 6h、3 天每 12h、7 天每日 00:00；日桶均匀取 ~7 个
  const ticks = useMemo(() => {
    if (!usage) return [] as string[];
    const labels: string[] = 'hours' in usage ? usage.hours : usage.days;
    if (!hour) { const step = Math.ceil(labels.length / 7); return labels.filter((_, i) => i % step === 0); }
    const mod = labels.length <= 30 ? 6 : labels.length <= 72 ? 12 : 24;
    return labels.filter((l) => +l.slice(11) % mod === 0);
  }, [usage, hour]);

  return (
    <section className="mt-1">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-muted">实际消耗</h2>
        <Tabs.Root value={range} onValueChange={setRange} className="ml-auto">
          <Tabs.List className="flex gap-1 rounded-lg bg-line/60 p-0.5">
            {RANGES.map((r) => (
              <Tabs.Trigger key={r.v} value={r.v}
                className="rounded-md px-2.5 py-1 text-xs text-muted data-[state=active]:bg-card data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:shadow-sm">
                {r.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
        <button onClick={load} className="rounded-lg p-1.5 text-muted hover:bg-line/60" title="刷新">
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="rounded-xl border border-line bg-card p-3 shadow-sm">
        {error ? (
          <div className="py-10 text-center text-[13px] text-muted">拿不到 {error.includes('HTTP') ? '管理口接口' : '数据'}：{error}</div>
        ) : !usage ? (
          <div className="py-10 text-center text-[13px] text-muted">加载中…</div>
        ) : !series.length ? (
          <div className="py-10 text-center text-[13px] text-muted">这个范围里没有在役订阅的消耗</div>
        ) : (
          <ResponsiveContainer width="100%" height={window.innerWidth < 900 ? 220 : 280}>
            <LineChart data={rows} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis dataKey="label" ticks={ticks} interval={0} tickFormatter={tickFmt} tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v: number) => fmtTok(v)} width={52} tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTip hour={hour} />} cursor={{ stroke: 'var(--color-muted)', strokeDasharray: '3 3' }} />
              <Legend formatter={(v: string) => <span className="text-[11px] text-muted">{v}</span>} iconType="plainline" iconSize={14} />
              {series.map((s) => (
                <Line key={s.key} dataKey={s.key} name={s.alias} stroke={s.color} strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

// ── 页面 ──
export default function App() {
  const isDesk = useMedia('(min-width:900px)');
  const [route, setRoute] = useState<RouteStatus | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [today, setToday] = useState<UsageAgg | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setErr(null);
    Promise.all([
      getJson<RouteStatus>('/api/route/status'),
      getJson<{ summary: Summary }>('/api/audit/summary').catch(() => null),
      getJson<UsageDay>('/api/audit/usage?days=1').catch(() => null),
    ]).then(([r, s, u]) => {
      setRoute(r); setSummary(s?.summary ?? null);
      if (u) {
        const t: UsageAgg = { requests: 0, errors: 0, total_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 };
        for (const sub of u.subscriptions) {
          const d = sub.by_day[u.days[0]];
          if (d) for (const k of Object.keys(t) as (keyof UsageAgg)[]) t[k] += d[k];
        }
        setToday(t);
      }
    }).catch((e) => setErr(String(e.message || e)));
  };
  useEffect(load, []);

  const kpi: [string, string, boolean?][] = [
    ['今天 tokens', fmtTok(today?.total_tokens ?? null)],
    ['今天请求', today ? String(today.requests) : '—'],
    ['今天错误', today ? String(today.errors) : '—', (today?.errors ?? 0) > 0],
    ['累计请求', summary ? String(summary.requests ?? '—') : '—'],
    ['累计会话', summary ? String(summary.sessions ?? '—') : '—'],
    ['在役订阅', route ? String(route.subscriptions.length) : '—'],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 pt-4 md:px-6 md:pt-6">
      <header className="mb-4 flex items-center gap-2.5">
        <h1 className="text-lg font-bold">LLM CPR</h1>
        <span className="text-[11px] text-muted">概览 · React 版原型</span>
        <button onClick={load} className="ml-auto flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:bg-line/50">
          <RefreshCw size={13} /> 刷新
        </button>
      </header>

      {err && <div className="mb-3 rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-[13px] text-bad">{err}</div>}

      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {kpi.map(([label, value, bad]) => (
          <div key={label} className="rounded-xl border border-line bg-card px-2 py-3 text-center shadow-sm">
            <div className={`text-xl font-bold tabular-nums md:text-2xl ${bad ? 'text-bad' : ''}`}>{value}</div>
            <div className="mt-0.5 text-[11px] text-muted">{label}</div>
          </div>
        ))}
      </div>

      <h2 className="mb-2 mt-6 text-[13px] font-semibold text-muted">订阅额度</h2>
      <div className="grid gap-2.5 md:grid-cols-3">
        {(route?.subscriptions ?? []).map((s) => <SubCard key={s.name} sub={s} defaultOpen={isDesk} />)}
        {route && !route.subscriptions.length && <div className="text-[13px] text-muted">没有在役订阅</div>}
      </div>

      <UsageChart />
    </div>
  );
}
