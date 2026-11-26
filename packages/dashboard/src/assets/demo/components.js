// preact + htm 基座自检页组件：交互（useState）、真后台 API（useEffect + 全局 fetchJson）、
// 受控表单（settings 页预演）。本页仅证明管线，正式 settings 页另起后本页可删。
import { useState, useEffect } from 'preact/hooks';
import { html } from '../lib/html.js';

/* 交互自检：状态变了只 diff 那个数字节点，不重写整块 DOM */
export function Counter() {
  const [n, setN] = useState(0);
  return html`<p class="demo-row">交互自检：已点 <b class="num" id="demo-count">${n}</b> 次
    <button onClick=${() => setN(n + 1)}>+1</button></p>`;
}

/* 真 API 自检：/api/audit/summary（复用经典脚本 app.js 的全局 fetchJson/fmtTok/esc）。
   静态直开（无后台 API）时展示错误态而非白屏。 */
export function LiveSummary() {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    fetchJson(withTenant('/api/audit/summary'))
      .then((s) => alive && setSt({ loading: false, s }))
      .catch((e) => alive && setSt({ loading: false, err: String(e?.message || e) }));
    return () => { alive = false; };
  }, []);
  if (st.loading) return html`<p class="demo-row muted">加载中…</p>`;
  if (st.err) return html`<p class="demo-row"><span class="badge err">API 不可用：${st.err}</span><span class="muted">　（python http.server 直开时属预期，起后台实例再看这格）</span></p>`;
  const s = st.s.summary ?? st.s; // 端点返回 {summary:{...}} 包壳，兼容两种形状
  const subs = (s.subscriptions || []).map((x) => html`
    <div key=${x.subscription}><b class="num">${x.requests}</b><span>${esc(subLabelRoute(x.subscription))} · ${x.errors} 错 · ${fmtTok(x.total_tokens)} tok</span></div>`);
  return html`<div class="subs">
    <div><b class="num">${s.requests ?? '—'}</b><span>总请求</span></div>
    <div><b class="num">${s.sessions ?? '—'}</b><span>会话数</span></div>
    ${subs}
  </div>`;
}

/* 订阅显示名：走 route/status 的 alias 映射（拿不到就退回内部名） */
let routeStatusCache = null;
export function primeRouteStatus() {
  return fetchJson('/api/route/status').then((st) => { routeStatusCache = st; }).catch(() => {});
}
function subLabelRoute(name) {
  const sub = (routeStatusCache?.subscriptions || []).find((x) => x.name === name);
  if (!sub) return name;
  return sub.alias || sub.name;
}

/* 受控表单预演：value 绑状态 + 校验禁用 + 保存回显（demo 不落盘） */
export function NameForm() {
  const [val, setVal] = useState('');
  const [saved, setSaved] = useState(null);
  const dirty = val.trim() !== '' && val !== saved;
  return html`<div class="demo-row">
    <label>示例字段：<input value=${val} onInput=${(e) => setVal(e.target.value)} placeholder="随便输点什么" /></label>
    <button disabled=${!dirty} onClick=${() => setSaved(val.trim())}>保存</button>
    ${saved !== null && html`<span class="ok">已保存「${saved}」（demo 不落盘）</span>`}
  </div>`;
}
