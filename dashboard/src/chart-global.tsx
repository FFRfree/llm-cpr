// CPRChart：Recharts 的薄壳（vanilla 页面用的全局组件）。
// 页面只给纯数据配置，React/Recharts 全部封在这个 bundle 里——原型页自身仍然零框架。
import { createRoot } from 'react-dom/client';
import { LineChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './chart.css';

export interface SeriesDef { name: string; alias: string; color: string; vals: (number | null)[] }
export interface ChartOpts {
  labels: string[]; // API 原样：最新在前（UTC 形式小时桶 YYYY-MM-DDTHH / 日桶 YYYY-MM-DD）
  hour: boolean;
  height?: number;
  kind?: 'line' | 'bar'; // bar = 堆叠柱（默认 line）
  series: SeriesDef[];
}

const fmtTok = (n: number | null | undefined): string => {
  if (n == null) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
};

const hourTip = (l: string): string => `${+l.slice(5, 7)}/${+l.slice(8, 10)} ${l.slice(11)}:00`;
const hourTick = (l: string): string => l.slice(11) === '00' ? `${+l.slice(5, 7)}/${+l.slice(8, 10)}` : `${l.slice(11)}:00`;
const dayTick = (l: string): string => `${+l.slice(5, 7)}/${+l.slice(8, 10)}`;

export function render(el: HTMLElement, opts: ChartOpts): void {
  el.innerHTML = '';
  const hour = opts.hour;
  const labels = opts.labels;
  // 横轴锚整点：24h 每 6h、3 天每 12h、7 天每日 00:00；日桶均匀取 ~7 个
  const ticks = hour
    ? labels.filter((l) => +l.slice(11) % (labels.length <= 30 ? 6 : labels.length <= 72 ? 12 : 24) === 0)
    : (() => { const step = Math.ceil(labels.length / 7); return labels.filter((_, i) => i % step === 0); })();
  // API 最新在前 → 最旧在左
  const rows = labels.slice().reverse().map((l, ri) => {
    const i = labels.length - 1 - ri;
    const row: Record<string, string | number | null> = { label: l };
    for (const s of opts.series) row[s.name] = s.vals[i] ?? 0;
    return row;
  });
  const aliasOf = Object.fromEntries(opts.series.map((s) => [s.name, s.alias]));
  const bar = opts.kind === 'bar';

  const Tip = (props: { active?: boolean; label?: string; payload?: { name?: string; value?: number; color?: string }[] }) => {
    const { active, label, payload } = props;
    if (!active || !payload?.length) return null;
    return (
      <div className="cpr-tip">
        <b>{hour && label ? hourTip(String(label)) : label}</b>
        {payload.map((p, i) => (
          <div key={i} className="cpr-tip-row">
            <span className="cpr-tip-dot" style={{ background: p.color }} />
            <span>{aliasOf[String(p.name)] ?? String(p.name)}</span>
            <b>{fmtTok(p.value)} tok</b>
          </div>
        ))}
      </div>
    );
  };

  const common = (
    <>
      <CartesianGrid stroke="#e4e8ee" vertical={false} />
      <XAxis dataKey="label" ticks={ticks} interval={0} tickFormatter={hour ? hourTick : dayTick}
        tick={{ fontSize: 11, fill: '#69788a' }} tickLine={false} axisLine={false} />
      <YAxis tickFormatter={(v: number) => fmtTok(v)} width={52}
        tick={{ fontSize: 11, fill: '#69788a' }} tickLine={false} axisLine={false} />
      <Tooltip content={<Tip />} cursor={bar ? { fill: 'rgba(105,120,138,.08)' } : { stroke: '#69788a', strokeDasharray: '3 3' }} />
    </>
  );

  createRoot(el).render(
    <ResponsiveContainer width="100%" height={opts.height ?? 260}>
      {bar ? (
        <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {common}
          {opts.series.map((s, i) => (
            <Bar key={s.name} dataKey={s.name} stackId="a" fill={s.color}
              maxBarSize={28} radius={i === opts.series.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
          ))}
        </BarChart>
      ) : (
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {common}
          {opts.series.map((s) => (
            <Line key={s.name} dataKey={s.name} stroke={s.color} strokeWidth={2} type="monotone"
              dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>,
  );
}
