// pages/requests.js —— 请求明细页：服务端分页/排序/筛选 + 点行展开明细 + capture_id 深链。
// 原 requests.html 内联脚本的状态驱动版；复用 app.js 全局工具（fetchJson/withTenant/num/fmtClock/esc/subLabel/initChrome）。
import { useState, useEffect } from 'preact/hooks';
import { render, Fragment } from 'preact';
import { html } from '../lib/html.js';
import { SortTh, Pager } from './shared.js';

/* 行展开后的明细：拉该会话请求列表找本条（对齐原 showDetail；原版此处不带 tenant 参数，保持一致） */
function RequestDetail({ id, identity }) {
  const [req, setReq] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    fetchJson(withTenant(`/api/audit/sessions/${encodeURIComponent(identity)}`))
      .then((data) => { if (alive) setReq((data.requests || []).find((r) => String(r.id) === String(id)) ?? {}); })
      .catch((e) => { if (alive) setErr(String(e.message || e)); });
    return () => { alive = false; };
  }, [id, identity]);
  if (err) return html`明细加载失败：${err}`;
  if (!req) return '加载中…';
  return html`<table><tbody>
    <tr><th>request id</th><td class="mono">${id}</td></tr>
    <tr><th>路径</th><td class="mono">${req.path ?? '—'}</td></tr>
    <tr><th>capture 锚点</th><td class="mono">${req.capture_id ? html`${req.capture_id}（轨迹页可还原该轮正文）` : 'null（未捕获 / 租户未开 capture）'}</td></tr>
    <tr><th>cache outcome</th><td>${req.cache_outcome ?? '未观察到'}</td></tr>
    <tr><th>tokens</th><td class="num">prompt ${req.prompt_tokens ?? '—'} · completion ${req.completion_tokens ?? '—'} · cache hit ${req.cache_hit_tokens ?? '—'} · miss ${req.cache_miss_tokens ?? '—'} · write ${req.cache_write_tokens ?? '—'}</td></tr>
  </tbody></table>`;
}

function RequestRow({ r, subs, expanded, onToggle }) {
  const missBad = num(r.cache_hit_tokens) && num(r.prompt_tokens) && r.prompt_tokens > 0 && r.cache_hit_tokens === 0;
  const isExpanded = expanded === `${r.tenant}|${r.id}`;
  return html`<${Fragment}>
    <tr class="data${isExpanded ? ' expanded' : ''}" onClick=${(e) => { if (!e.target.closest('a')) onToggle(`${r.tenant}|${r.id}`); }}>
      <td class="num" data-l="时间">${fmtClock(r.ts)}</td>
      <td data-l="模型">${r.model ?? '—'}${r.translated_model && r.translated_model !== r.model && html`<span class="kind"> → ${r.translated_model}</span>`}</td>
      <td data-l="订阅">${subLabel({ subscriptions: subs }, r.subscription ?? '—')}</td>
      <td class="num" data-l="状态">${r.status >= 400 ? html`<span class="lost">${r.status}</span>` : r.status}</td>
      <td data-l="会话">${r.identity ? html`<div class="idcell" title=${r.identity}>${r.identity}</div><span class="kind">${r.identity_kind ?? ''}</span>` : html`<span class="muted">—</span>`}</td>
      <td class="num" data-l="prompt">${r.prompt_tokens ?? '—'}</td>
      <td class="num" data-l="completion">${r.completion_tokens ?? '—'}</td>
      <td class="num" data-l="cache hit">${r.cache_hit_tokens ?? '—'}${missBad && html`<span class="lost">⚠</span>`}</td>
      <td class="num" data-l="TTFT">${num(r.ttft_ms) ? (r.ttft_ms / 1000).toFixed(2) + 's' : '—'}</td>
      <td class="num" data-l="耗时">${num(r.ms) ? r.ms + 'ms' : '—'}</td>
      <td data-l="轨迹">${r.capture_id ? html`<a href="/trajectory?identity=${encodeURIComponent(r.identity || '')}&tenant=${encodeURIComponent(r.tenant)}&capture_id=${encodeURIComponent(r.capture_id)}">看轨迹</a>` : html`<span class="muted">未捕获</span>`}</td>
    </tr>
    ${isExpanded && html`<tr class="detail-row"><td colspan="11"><${RequestDetail} id=${String(r.id)} identity=${r.identity || ''} /></td></tr>`}
  <//>`;
}

export function View({ routeStatus, reloadKey }) {
  const [q, setQ] = useState({ sort: { key: 'ts', dir: 'desc' }, page: 1, filters: { identity: '', model: '', status: '', days: '' } });
  const [expanded, setExpanded] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const subs = routeStatus?.subscriptions || [];

  const buildQuery = (s) => {
    const p = new URLSearchParams({ page: String(s.page), page_size: '50', sort: s.sort.key, order: s.sort.dir });
    for (const [k, v] of Object.entries(s.filters)) if (v) p.set(k, v);
    return withTenant(`/api/audit/requests?${p}`);
  };
  const load = async (next) => {
    try {
      const d = await fetchJson(buildQuery(next));
      setData(d); setErr('');
    } catch (e) { setErr(`加载失败：${e.message}`); }
  };
  const apply = (patch) => { const next = { ...q, ...patch }; setQ(next); load(next); };

  useEffect(() => {
    /* 带 capture_id 进入：先用默认筛选定位，再翻到所在页并展开 */
    const captureId = new URLSearchParams(location.search).get('capture_id');
    (async () => {
      let next = q;
      if (captureId) {
        try {
          const d = await fetchJson(buildQuery(q));
          const idx = (d.requests || []).findIndex((r) => r.capture_id === captureId);
          if (idx >= 0) {
            const target = d.requests[idx];
            next = { ...q, page: Math.floor(idx / d.page_size) + 1 };
            setQ(next);
            setExpanded(`${target.tenant}|${target.id}`);
          }
        } catch {}
      }
      load(next);
    })();
  }, [reloadKey]);

  const onSort = (k) => apply({ sort: { key: k, dir: q.sort.key === k && q.sort.dir === 'desc' ? 'asc' : 'desc' }, page: 1 });
  const onFilter = (k, v) => apply({ filters: { ...q.filters, [k]: v }, page: 1 });

  const rows = data?.requests || [];
  return html`<${Fragment}>
    <h2>请求明细（服务端分页 / 排序 / 筛选）</h2>
    <div class="toolbar">
      <input type="search" placeholder="按会话 ID 精确匹配…" autocomplete="off" value=${q.filters.identity} onChange=${(e) => onFilter('identity', e.target.value.trim())} />
      <input type="search" placeholder="按模型精确匹配…" autocomplete="off" style="max-width:180px" value=${q.filters.model} onChange=${(e) => onFilter('model', e.target.value.trim())} />
      <select value=${q.filters.status} onChange=${(e) => onFilter('status', e.target.value)}>
        <option value="">状态：全部</option><option value="200">2xx</option><option value="400">400</option><option value="403">403</option><option value="429">429</option><option value="499">499</option><option value="500">500</option><option value="502">502</option>
      </select>
      <select value=${q.filters.days} onChange=${(e) => onFilter('days', e.target.value)}>
        <option value="">时间：全部</option><option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option>
      </select>
      <span class="hint muted">点行展开明细；桌面端可点表头排序</span>
    </div>
    ${err && html`<div id="err">${err}</div>`}
    <table>
      <thead><tr>
        <${SortTh} k="ts" label="时间" sort=${q.sort} onSort=${onSort} />
        <${SortTh} k="model" label="模型" sort=${q.sort} onSort=${onSort} />
        <${SortTh} k="subscription" label="订阅" sort=${q.sort} onSort=${onSort} />
        <${SortTh} k="status" label="状态" sort=${q.sort} onSort=${onSort} num />
        <th>会话</th>
        <th class="num">prompt</th><th class="num">completion</th><th class="num">cache hit</th><th class="num">TTFT</th><th class="num">耗时</th>
        <th>轨迹</th>
      </tr></thead>
      <tbody>${rows.length ? rows.map((r) => html`<${RequestRow} key=${r.id} r=${r} subs=${subs} expanded=${expanded}
        onToggle=${(key) => setExpanded((prev) => (prev === key ? null : key))} />`)
        : html`<tr><td colspan="11" class="empty">没有匹配的请求</td></tr>`}</tbody>
    </table>
    <${Pager} data=${data} go=${(p) => apply({ page: p })} />
  <//>`;
}

