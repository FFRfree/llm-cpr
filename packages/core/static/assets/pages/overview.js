// pages/overview.js —— 概览页：订阅额度快照 + 账本消耗（日切柱状）。原 index.html 内联脚本的状态驱动版。
// 复用经典脚本 app.js 的全局工具（fetchJson/withTenant/num/clamp/fmtTok/rel/subLabel/familyLabel/initChrome）。
import { useState, useEffect } from 'preact/hooks';
import { render, Fragment } from 'preact';
import { html } from '../lib/html.js';

/* 额度窗口行（对齐 app.js 的 windowRow 字符串版） */
function WindowRow({ label, used, cap, timePct, resetText, unit }) {
  const p = num(used) && num(cap) && cap > 0 ? clamp(100 * used / cap) : null;
  return html`<div class="window">
    <div class="row1"><span class="lbl">${label}</span>
      <span class="pct">${p === null ? '额度不可用' : html`<b>${used.toFixed(2)}</b> / ${cap.toFixed(0)}${unit} · ${p.toFixed(1)}%`}</span></div>
    <div class="track">
      ${p !== null && html`<div class="fill${p >= 100 ? ' over' : ''}" style="width:${p}%"></div>`}
      ${num(timePct) && html`<div class="marker" title="周期时间已过 ${timePct.toFixed(1)}%" style="left:${timePct}%"></div>`}
    </div>
    <div class="reset">${resetText || ''}</div>
  </div>`;
}

/* CCG: 月额度 $；OCG: 月度百分比 */
function monthlyOf(s) {
  if (num(s.monthlyCap) && num(s.monthlySpent)) return { used: s.monthlySpent, cap: s.monthlyCap, unit: '$' };
  if (num(s.monthlyPercent)) return { used: s.monthlyPercent, cap: 100, unit: '%' };
  return null;
}

const toMs = (v) => (num(v) && v > 1e12 ? v : (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null));

function SubCard({ st, x }) {
  const s = x.snapshot || {};
  const monthProgress = num(s.monthProgress) ? clamp(s.monthProgress)
    : (s.periodStart && s.periodEnd ? clamp(100 * (Date.now() - Date.parse(s.periodStart)) / (Date.parse(s.periodEnd) - Date.parse(s.periodStart))) : null);
  const badges = [];
  if (!s.known) badges.push(html`<span class="badge err">余量未知</span>`);
  else if (s.degraded) badges.push(html`<span class="badge warn">快照降级</span>`);
  else if (s.stale) badges.push(html`<span class="badge warn">已过期</span>`);
  const mon = monthlyOf(s);
  return html`<article>
    <div class="sub-head"><span class="name">${x.alias || x.name}</span><span class="badge">${familyLabel(x.family)}</span>
      ${badges}<span class="remain">${num(s.monthlyRemaining) && html`月余 <b>$${s.monthlyRemaining.toFixed(2)}</b>`}</span></div>
    <${WindowRow} label="5 小时" used=${s.fiveHour?.used} cap=${s.fiveHour?.cap} timePct=${null}
      resetText=${countdown(toMs(s.fiveHour?.resetAt))} unit=${x.family === 'ccg' ? '$' : '%'} />
    <${WindowRow} label="每周" used=${s.weekly?.used} cap=${s.weekly?.cap} timePct=${null}
      resetText=${countdown(toMs(s.weekly?.resetAt))} unit=${x.family === 'ccg' ? '$' : '%'} />
    <${WindowRow} label="每月" used=${mon?.used} cap=${mon?.cap} timePct=${monthProgress}
      resetText=${s.periodEnd ? countdown(toMs(s.periodEnd)) : ''} unit=${mon?.unit || '%'} />
    <div class="sub-foot">快照 ${s.fetchedAt ? rel(s.fetchedAt) : '尚无'} · 内部名 <span class="mono">${x.name}</span>
      <details class="models"><summary>可用模型（${(x.models || []).length}）</summary>
      <div class="chips">${(x.models || []).map((m) => html`<span key=${m}>${m}</span>`)}</div></details></div>
  </article>`;
}

/* 账本消耗表（北京日切柱状） */
function UsageTable({ usage, st }) {
  if (!usage) return null;
  const max = Math.max(1, ...usage.subscriptions.flatMap((s) => Object.values(s.by_day).map((d) => d.total_tokens)));
  return html`<table>
    <thead><tr><th>订阅</th><th>近 N 天</th><th class="num">请求</th><th class="num">错误</th><th class="num">tokens</th><th class="num">cache 命中 tokens</th><th>每日 tokens</th></tr></thead>
    <tbody>${usage.subscriptions.length ? usage.subscriptions.map((s) => {
      const cells = usage.days.map((label) => {
        const d = s.by_day[label];
        const tokens = d ? d.total_tokens : 0;
        const h = tokens ? Math.max(3, Math.round(56 * tokens / max)) : 0;
        return html`<div key=${label} class=${tokens ? '' : 'zero'} style="height:${h}px"><span>${label.slice(5)} · ${fmtTok(tokens)} tok · ${d?.requests ?? 0} 请求</span></div>`;
      });
      return html`<tr key=${s.subscription}>
        <td>${subLabel(st, s.subscription)}</td>
        <td class="num">${usage.days.length}</td>
        <td class="num">${s.total.requests}</td>
        <td class="num">${s.total.errors ? html`<span class="lost">${s.total.errors}</span>` : '0'}</td>
        <td class="num">${fmtTok(s.total.total_tokens)}</td>
        <td class="num">${fmtTok(s.total.cache_hit_tokens)}</td>
        <td><div class="daygrid">${cells}</div><div class="daycols">${usage.days.map((l) => html`<span key=${l}>${l.slice(5)}</span>`)}</div></td>
      </tr>`;
    }) : html`<tr><td colspan="7" class="empty">窗口内没有请求</td></tr>`}</tbody>
  </table>`;
}

export function View({ routeStatus, reloadKey }) {
  const [summary, setSummary] = useState(null);
  const [usage, setUsage] = useState(null);
  const [days, setDays] = useState('7');
  const [err, setErr] = useState('');

  const loadUsage = async (d) => {
    const u = await fetchJson(withTenant(`/api/audit/usage?days=${d}`));
    setUsage(u);
  };

  useEffect(() => {
    (async () => {
      try {
        const [sum] = await Promise.all([fetchJson(withTenant('/api/audit/summary')), loadUsage(days)]);
        setSummary(sum?.summary);
      } catch (e) { setErr(`加载失败：${e.message}`); }
    })();
  }, [reloadKey]);

  const onDays = (e) => {
    const d = e.target.value;
    setDays(d);
    loadUsage(d).catch((ex) => setErr(`加载失败：${ex.message}`));
  };

  const subs = routeStatus?.subscriptions || [];
  const maps = routeStatus?.mappings || [];
  const live = new Set(subs.map((x) => x.name));
  return html`<${Fragment}>
    ${err && html`<div id="err">${err}</div>`}
    <div id="summary">
      <div><b class="num">${summary?.requests ?? '—'}</b><span>总请求</span></div>
      <div><b class="num">${summary?.sessions ?? '—'}</b><span>会话数</span></div>
      ${(summary?.subscriptions || []).map((x) => html`
        <div key=${x.subscription}><b class="num">${x.requests}</b><span>${subLabel(routeStatus, x.subscription)} · ${x.errors} 错 · ${fmtTok(x.total_tokens)} tok</span></div>`)}
    </div>

    <h2>订阅额度（上游快照）</h2>
    <div class="subs">${subs.length ? subs.map((x) => html`<${SubCard} key=${x.name} st=${routeStatus} x=${x} />`) : html`<div class="empty">没有订阅</div>`}</div>
    <div class="muted" style="margin-top:8px;font-size:12px">${maps.length > 0 && html`亲和会话：${maps.map((m, i) => html`<span key=${i}>${m.tenant && m.tenant !== 'default' ? `${m.tenant} · ` : ''}${subLabel(routeStatus, m.backend)} ${m.identities}${live.has(m.backend) ? '' : '（已下线，下次请求自动改绑）'}${i < maps.length - 1 ? ' · ' : ''}</span>`)}`}</div>

    <h2>订阅实际消耗（账本聚合 · 按北京时间日切）</h2>
    <div class="toolbar">
      <label>天数 <select value=${days} onChange=${onDays}><option value="7">7</option><option value="14">14</option><option value="30">30</option></select></label>
      <span class="hint muted">「额度快照」是上游说还剩多少；这张表是账本里实际烧掉的（请求数 / 错误 / tokens / cache 命中）。</span>
    </div>
    <${UsageTable} usage=${usage} st=${routeStatus} />
  <//>`;
}
