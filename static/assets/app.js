'use strict';
/* llm-cpr 后台 v2 —— 全站共享工具：转义/时间/字节格式化、fetchJson、顶栏注入、租户选择。
   各页面的 <script> 里直接用；无框架、无构建，本文件只依赖浏览器原生 API。 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v) => Math.max(0, Math.min(100, v));

const rel = (ts) => { // ts: epoch ms → 「x分钟前」
  if (!num(ts)) return '时间未知';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};
const fmtClock = (ts) => num(ts) ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtBytes = (n) => !num(n) ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const fmtTok = (n) => !num(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const fmtCost = (n) => !num(n) ? '—' : `$${n.toFixed(2)}`;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let message = `${r.status}`;
    try { message = (await r.json())?.error?.message ?? message; } catch {}
    throw new Error(message);
  }
  return r.json();
}

/* 租户筛选跨页记忆：'' = 全部租户 */
const tenantFilter = {
  get: () => sessionStorage.getItem('cpr-tenant') || '',
  set: (v) => sessionStorage.setItem('cpr-tenant', v),
};
const withTenant = (path, tenant = tenantFilter.get()) =>
  tenant ? `${path}${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(tenant)}` : path;

/* 顶栏注入 + 状态点 + 租户下拉（订阅快照是否新鲜）。每页 onReady 后再拉自己的数据。 */
const NAV_PAGES = [
  ['index.html', '概览'], ['requests.html', '请求'], ['sessions.html', '会话'],
  ['trajectory.html', '轨迹'], ['observability.html', '观测'],
];
function initChrome(activePage) {
  const header = document.createElement('header');
  header.innerHTML = `
    <h1>LLM CPR</h1>
    <nav>${NAV_PAGES.map(([href, label]) => `<a href="/${href}" ${href === activePage ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <span id="status"><span class="dot"></span><span id="status-text">加载中…</span></span>
    <span id="ver" class="muted" style="font-size:12px"></span>
    <span class="spacer"></span>
    <select id="tenant-sel" aria-label="按租户筛选" title="按租户筛选（调用方）"><option value="">全部租户</option></select>
    <button id="refresh-btn" type="button">刷新</button>`;
  document.body.prepend(header);
  const status = $('#status');
  const setStatus = (cls, text) => { status.className = cls; $('#status-text').textContent = text; };
  const tenantSel = $('#tenant-sel');
  tenantSel.value = tenantFilter.get();
  tenantSel.addEventListener('change', () => { tenantFilter.set(tenantSel.value); location.reload(); });
  $('#refresh-btn').addEventListener('click', () => location.reload());
  const loadVersion = fetchJson('/api/version').then((v) => {
    const el = $('#ver');
    el.textContent = v.latest && v.latest !== v.version ? `v${v.version}（可更新 ${v.latest}）` : `v${v.version}`;
  }).catch(() => {});
  const loadRouteStatus = fetchJson('/api/route/status').then((st) => {
    for (const t of st.tenants ?? []) {
      const option = document.createElement('option');
      option.value = t.name; option.textContent = `租户：${t.name}`;
      tenantSel.appendChild(option);
    }
    tenantSel.value = tenantFilter.get();
    const snaps = st.snapshots ?? {};
    const ages = Object.values(snaps.snapshots ?? {}).map((s) => s.fetchedAt).filter(num);
    if (!ages.length) setStatus('nodata', '快照 尚无');
    else setStatus(Date.now() - Math.max(...ages) > (snaps.intervalMs ?? 300000) ? 'stale' : '', `快照 ${rel(Math.max(...ages))}`);
    return st;
  });
  return Promise.allSettled([loadRouteStatus, loadVersion]);
}

/* 订阅显示名：内部名 → 「alias（家族全名）」 */
const FAMILY_LABEL = { ocg: 'OpenCode Go', ccg: 'CommandCode GOAT' };
const familyLabel = (f) => FAMILY_LABEL[f] || f;
function subLabel(routeStatus, name) {
  const sub = (routeStatus?.subscriptions || []).find((x) => x.name === name);
  if (!sub) return name;
  const alias = sub.alias || sub.name;
  return alias === sub.name ? alias : `${alias}（${familyLabel(sub.family)}）`;
}

/* 额度窗口行（hermes-home 同款：填充柱 + 周期标记 + 重置倒计时） */
function windowRow({ label, used, cap, timePct, resetText, unit }) {
  const p = num(used) && num(cap) && cap > 0 ? clamp(100 * used / cap) : null;
  const shown = p === null ? '额度不可用' : `<b>${used.toFixed(2)}</b> / ${cap.toFixed(0)}${unit} · ${p.toFixed(1)}%`;
  return `<div class="window">
    <div class="row1"><span class="lbl">${esc(label)}</span><span class="pct">${shown}</span></div>
    <div class="track">${p === null ? '' : `<div class="fill ${p >= 100 ? 'over' : ''}" style="width:${p}%"></div>`}${num(timePct) ? `<div class="marker" title="周期时间已过 ${timePct.toFixed(1)}%" style="left:${timePct}%"></div>` : ''}</div>
    <div class="reset">${esc(resetText || '')}</div>
  </div>`;
}
const toMs = (v) => (num(v) && v > 1e12 ? v : (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null));
const countdown = (msUntil) => {
  if (!num(msUntil)) return '重置时间不可用';
  const d = msUntil - Date.now();
  if (d <= 0) return '即将重置';
  const h = Math.floor(d / 3600000), m = Math.floor(d % 3600000 / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}天 ${h%24}小时后重置` : `${h}小时 ${m}分后重置`;
};

/* 分页控件：total/page/pageSize + 回调 */
function renderPager(el, { total, page, page_size }, go) {
  const last = Math.max(1, Math.ceil(total / page_size));
  el.innerHTML = total === 0 ? '<span>0 条</span>' :
    `<button ${page <= 1 ? 'disabled' : ''} data-go="${page - 1}">‹ 上一页</button>
     <span>第 <b class="num">${page}</b> / ${last} 页 · 共 <b class="num">${total}</b> 条</span>
     <button ${page >= last ? 'disabled' : ''} data-go="${page + 1}">下一页 ›</button>`;
  $$('button[data-go]', el).forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
}

/* 排序表头：th.sortable 点击 → (sortKey) 回调，箭头状态自管 */
function bindSortHeaders(table, current, onChange) {
  $$('th.sortable', table).forEach((th) => {
    const key = th.dataset.key;
    const update = () => { $('.arrow', th).textContent = current.key === key ? (current.dir === 'asc' ? '▲' : '▼') : ''; };
    update();
    th.addEventListener('click', () => {
      current.dir = current.key === key && current.dir === 'desc' ? 'asc' : 'desc';
      current.key = key;
      $$('th.sortable', table).forEach(update);
      onChange();
    });
  });
}
