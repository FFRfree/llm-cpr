// pages/app.js —— SPA 壳：顶栏（导航/快照状态点/租户筛选/刷新/版本）+ 无 hash 路由（pushState + popstate）。
// 服务端 SPA fallback（core admin serveStatic）：无扩展名且非 /api 的路径回落 index.html 壳页。
// 顶栏数据（routeStatus/version）全站拉一次；租户切换与刷新走 reloadKey 无刷新重取，不再 location.reload()。
// trajectory 仍是独立整页（MPA 混部），导航里它是普通 <a> 不拦截。
import { useState, useEffect } from 'preact/hooks';
import { render, Fragment } from 'preact';
import { html } from '../lib/html.js';
import { View as Overview } from './overview.js';
import { View as Requests } from './requests.js';
import { View as Sessions } from './sessions.js';
import { View as Observability } from './observability.js';
import { View as Trajectory } from './trajectory.js';

const ROUTES = [
  ['/', '概览', Overview],
  ['/requests', '请求', Requests],
  ['/sessions', '会话', Sessions],
  ['/trajectory', '轨迹', Trajectory],
  ['/observability', '观测', Observability],
];
const TITLES = Object.fromEntries(ROUTES.map(([p, l]) => [p, `${l} · LLM CPR 后台`]));
/* 旧的 .html 地址进壳时改写到新路由（保查询串；服务端 /requests 等无扩展名路径已回落壳页） */
const LEGACY = { '/index.html': '/', '/requests.html': '/requests', '/sessions.html': '/sessions', '/trajectory.html': '/trajectory', '/observability.html': '/observability' };

function currentPath() {
  const legacy = LEGACY[location.pathname];
  if (legacy !== undefined) {
    history.replaceState(null, '', legacy + location.search + location.hash);
    return legacy;
  }
  return location.pathname;
}

function Chrome({ path, snap, version, routeStatus, onNavigate, onTenant, onRefresh }) {
  return html`<header>
    <h1>LLM CPR</h1>
    <nav>${ROUTES.map(([href, label]) => html`
      <a key=${href} href=${href} aria-current=${path === href ? 'page' : undefined}
         onClick=${(e) => { e.preventDefault(); onNavigate(href); }}>${label}</a>`)}
    </nav>
    <span id="status" class=${snap.cls}><span class="dot"></span><span id="status-text">${snap.text}</span></span>
    <span id="ver" class="muted" style="font-size:12px">${version}</span>
    <span class="spacer"></span>
    <select aria-label="按租户筛选" title="按租户筛选（调用方）" value=${tenantFilter.get()}
            onChange=${(e) => onTenant(e.target.value)}>
      <option value="">全部租户</option>
      ${(routeStatus?.tenants || []).map((t) => html`<option key=${t.name} value=${t.name}>租户：${t.name}</option>`)}
    </select>
    <button type="button" onClick=${onRefresh}>刷新</button>
  </header>`;
}

function App() {
  const [path, setPath] = useState(currentPath);
  const [routeStatus, setRouteStatus] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [snap, setSnap] = useState({ cls: '', text: '加载中…' });
  const [version, setVersion] = useState('');

  /* 顶栏数据：快照状态点 + 租户列表 + 版本（reloadKey 变化 = 租户切换或手动刷新） */
  useEffect(() => {
    let alive = true;
    Promise.allSettled([fetchJson('/api/route/status'), fetchJson('/api/version')]).then(([st, v]) => {
      if (!alive) return;
      if (st.status === 'fulfilled') {
        setRouteStatus(st.value);
        const snaps = st.value.snapshots ?? {};
        const ages = Object.values(snaps.snapshots ?? {}).map((s) => s.fetchedAt).filter(num);
        if (!ages.length) setSnap({ cls: 'nodata', text: '快照 尚无' });
        else {
          const newest = Math.max(...ages);
          setSnap({ cls: Date.now() - newest > (snaps.intervalMs ?? 300000) ? 'stale' : '', text: `快照 ${rel(newest)}` });
        }
      } else setSnap({ cls: 'stale', text: '状态未知' });
      if (v.status === 'fulfilled') {
        const ver = v.value;
        setVersion(ver.latest && ver.latest !== ver.version ? `v${ver.version}（可更新 ${ver.latest}）` : `v${ver.version}`);
      }
    });
    return () => { alive = false; };
  }, [reloadKey]);

  /* 浏览器前进/后退：按地址栏重定位视图 */
  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /* 全局链接接管：指向本 SPA 路由（含老 .html 地址）的 <a> 改走 pushState，跨页互跳不再整页刷新。
     普通拦截规则：同源 + 目标在路由表/legacy 表 + 无修饰键 + 无 target。 */
  useEffect(() => {
    const onClick = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const a = e.target.closest && e.target.closest('a');
      if (!a || a.target) return;
      let u;
      try { u = new URL(a.href, location.origin); } catch { return; }
      if (u.origin !== location.origin) return;
      const to = LEGACY[u.pathname] ?? (ROUTES.some(([p]) => p === u.pathname) ? u.pathname : null);
      if (to == null) return;
      e.preventDefault();
      history.pushState(null, '', to + u.search + u.hash);
      setPath(to);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  /* 每次路由变化同步页面标题 */
  useEffect(() => { document.title = TITLES[path] ?? 'LLM CPR 后台'; }, [path]);

  const navigate = (to) => {
    if (to !== location.pathname) history.pushState(null, '', to);
    setPath(to);
  };
  const onTenant = (v) => { tenantFilter.set(v); setReloadKey((k) => k + 1); };

  const route = ROUTES.find(([p]) => p === path);
  const View = route ? route[2] : () => html`<div class="empty">页面不存在（${path}）——从顶栏回概览吧</div>`;
  return html`<${Fragment}>
    <${Chrome} path=${path} snap=${snap} version=${version} routeStatus=${routeStatus}
      onNavigate=${navigate} onTenant=${onTenant} onRefresh=${() => setReloadKey((k) => k + 1)} />
    <${View} routeStatus=${routeStatus} reloadKey=${reloadKey} />
  <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
