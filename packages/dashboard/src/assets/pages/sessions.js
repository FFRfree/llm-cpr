// pages/sessions.js —— 会话/缓存页：服务端分页/排序 + 点行展开请求明细与缓存取证链 + 复制 ID + identity 深链。
// 原 sessions.html 内联脚本的状态驱动版；复用 app.js 全局工具（fetchJson/withTenant/num/rel/fmtClock/initChrome）。
import { useState, useEffect } from 'preact/hooks';
import { render, Fragment } from 'preact';
import { html } from '../lib/html.js';
import { SortTh, Pager } from './shared.js';

/* 行展开明细：请求列表（倒序、丢失轮标黄）+ 缓存取证链（相邻轮哈希对比） */
function SessionDetail({ identity, tenant }) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await fetchJson(`/api/audit/sessions/${encodeURIComponent(identity)}?tenant=${encodeURIComponent(tenant)}`);
        const forensics = await fetchJson(`/api/capture/cache-forensics?identity=${encodeURIComponent(identity)}&tenant=${encodeURIComponent(tenant)}&limit=50`).catch(() => null);
        if (alive) setSt({ loading: false, data, forensics });
      } catch (e) { if (alive) setSt({ loading: false, err: String(e.message || e) }); }
    })();
    return () => { alive = false; };
  }, [identity, tenant]);
  if (st.loading) return '加载中…';
  if (st.err) return `明细加载失败：${st.err}`;
  const lossTs = new Set((st.data.session?.loss_events || []).map((e) => e.ts));
  const rows = (st.data.requests || []).slice().reverse();
  const chain = st.forensics && (st.forensics.chain || []).length > 1 ? st.forensics : null;
  const rebindAt = chain ? new Map((st.forensics.rebinds || []).map((r) => [r.ts, r])) : null;
  return html`<table>
    <thead><tr><th>时间</th><th>订阅</th><th>模型</th><th>状态</th><th>prompt</th><th>cache hit</th><th>TTFT</th><th>tok/s</th><th>耗时</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((r, i) => {
      const tps = num(r.stream_ms) && r.stream_ms > 0 && num(r.completion_tokens) ? (r.completion_tokens * 1000 / r.stream_ms).toFixed(0) : '—';
      return html`<tr key=${i} style=${lossTs.has(r.ts) ? 'color:var(--warning)' : null}>
        <td class="num">${fmtClock(r.ts)}</td><td>${r.subscription ?? '—'}</td><td>${r.model ?? '—'}</td>
        <td class="num">${r.status}</td><td class="num">${r.prompt_tokens ?? '—'}</td>
        <td class="num">${r.cache_hit_tokens ?? '—'}</td>
        <td class="num">${num(r.ttft_ms) ? (r.ttft_ms / 1000).toFixed(2) + 's' : '—'}</td>
        <td class="num">${tps}</td>
        <td class="num">${num(r.ms) ? r.ms + 'ms' : '—'}</td>
        <td>${lossTs.has(r.ts) ? '⚠ cache 丢失' : ''}</td></tr>`;
    }) : html`<tr><td colspan="10" class="empty">无请求记录</td></tr>`}</tbody>
  </table>
  ${chain && html`<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">缓存取证链（${chain.chain.length - 1} 个相邻轮对比）</summary>
    <table style="margin-top:6px"><thead><tr><th>轮</th><th>时间</th><th>模型</th><th class="num">公共前缀</th><th>分歧点</th><th class="num">chars Δ</th><th>同窗改绑</th></tr></thead><tbody>
    ${chain.chain.map((c, i) => {
      const rb = rebindAt.get(c.ts);
      const diff = c.first_diff_index == null ? '' : `第 ${c.first_diff_index + 1} 条（${c.first_diff_role || '?'}）`;
      return html`<tr key=${i}><td class="num">#${i + 1}</td><td class="num">${fmtClock(c.ts)}</td><td>${c.model ?? '—'}</td>
        <td class="num">${c.common_prefix}/${c.message_count}</td><td>${diff || html`<span class="muted">—</span>`}</td>
        <td class="num">${c.chars_delta}</td>
        <td>${rb && html`⚠ ${rb.backend}（证据指向改绑）`}</td></tr>`;
    })}
    </tbody></table></details>`}`;
}

export function View({ reloadKey }) {
  const [q, setQ] = useState({ sort: { key: 'last_ts', dir: 'desc' }, page: 1, days: '' });
  const [expanded, setExpanded] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const buildQuery = (s) => {
    const p = new URLSearchParams({ page: String(s.page), page_size: '50', sort: s.sort.key, order: s.sort.dir });
    if (s.days) p.set('days', s.days);
    return withTenant(`/api/audit/sessions?${p}`);
  };
  const load = async (next) => {
    try {
      const d = await fetchJson(buildQuery(next));
      setData(d); setErr('');
    } catch (e) { setErr(`加载失败：${e.message}`); }
  };
  const apply = (patch) => { const next = { ...q, ...patch }; setQ(next); load(next); };

  useEffect(() => {
    /* 带 identity 进入：自动展开该会话 */
    const identity = new URLSearchParams(location.search).get('identity');
    if (identity) setExpanded(`${tenantFilter.get() || 'default'}|${identity}`);
    load(q);
  }, [reloadKey]);

  const onSort = (k) => apply({ sort: { key: k, dir: q.sort.key === k && q.sort.dir === 'desc' ? 'asc' : 'desc' }, page: 1 });

  const sessions = data?.sessions || [];
  return html`<${Fragment}>
    <h2>会话 / 缓存（服务端分页 / 排序）</h2>
    <div class="toolbar">
      <select value=${q.days} onChange=${(e) => apply({ days: e.target.value, page: 1 })}>
        <option value="">时间：全部</option><option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option>
      </select>
      <span class="hint muted">点行展开请求明细 + 缓存取证；「轨迹」进逐轮正文浏览</span>
    </div>
    ${err && html`<div id="err">${err}</div>`}
    <table>
      <thead><tr>
        <${SortTh} k="identity" label="会话" sort=${q.sort} onSort=${onSort} />
        <${SortTh} k="requests" label="请求" sort=${q.sort} onSort=${onSort} num />
        <${SortTh} k="full_miss_rate" label="cache miss" sort=${q.sort} onSort=${onSort} num />
        <${SortTh} k="full_misses" label="丢失" sort=${q.sort} onSort=${onSort} num />
        <${SortTh} k="last_ts" label="最后活跃" sort=${q.sort} onSort=${onSort} />
        <th>轨迹</th>
      </tr></thead>
      <tbody>${sessions.length ? sessions.map((s) => {
        const miss = s.full_miss_rate;
        const tenant = s.tenant || 'default';
        const key = `${tenant}|${s.identity}`;
        const isExpanded = expanded === key;
        return html`<${Fragment} key=${key}>
          <tr class="data${isExpanded ? ' expanded' : ''}"
              onClick=${(e) => { if (!e.target.closest('a') && !e.target.closest('.copy')) setExpanded((prev) => (prev === key ? null : key)); }}>
            <td data-l="会话"><div class="idcell" title=${s.identity}>${s.identity}
              <button class="copy" title="复制完整 ID" onClick=${(e) => { e.stopPropagation(); navigator.clipboard?.writeText(s.identity); }}>⧉</button></div>
              <span class="kind">${s.identity_kind ?? ''}${tenant !== 'default' && ` · ${tenant}`}</span></td>
            <td class="num" data-l="请求">${s.requests ?? '—'}</td>
            <td class="num" data-l="cache miss">${miss == null ? html`<span class="muted">—</span>` : html`<span class=${miss >= 0.5 ? 'lost' : miss >= 0.2 ? 'warnmiss' : ''}>${(100 * miss).toFixed(1)}%</span>`}</td>
            <td class="num" data-l="丢失">${(s.loss_events || []).length ? html`<span class="lost">⚠ ${s.loss_events.length}</span>` : html`<span class="muted">0</span>`}</td>
            <td class="num" data-l="最后活跃">${rel(s.last_ts)}</td>
            <td data-l="轨迹"><a href="/trajectory?identity=${encodeURIComponent(s.identity)}&tenant=${encodeURIComponent(tenant)}">看轨迹</a></td>
          </tr>
          ${isExpanded && html`<tr class="detail-row"><td colspan="6"><${SessionDetail} identity=${s.identity} tenant=${tenant} /></td></tr>`}
        <//>`;
      }) : html`<tr><td colspan="6" class="empty">没有匹配的会话</td></tr>`}</tbody>
    </table>
    <${Pager} data=${data} go=${(p) => apply({ page: p })} />
  <//>`;
}

