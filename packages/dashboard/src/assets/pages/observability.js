// pages/observability.js —— 观测页：正文捕获状态 / 工具灌入分析 / 泄漏取证命中 / 系统事件流。
// 原 observability.html 内联脚本的状态驱动版；四块各自取数互不阻塞；复用 app.js 全局工具。
import { useState, useEffect } from 'preact/hooks';
import { render, Fragment } from 'preact';
import { html } from '../lib/html.js';

/* 正文捕获状态：拉不到接口或未开启 → 显示关闭提示 */
function CaptureStatus() {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    fetchJson('/api/capture/status')
      .then((status) => alive && setSt({ loading: false, status }))
      .catch(() => alive && setSt({ loading: false, off: true }));
    return () => { alive = false; };
  }, []);
  if (st.loading) return null;
  const status = st.status;
  const on = status && status.enabled !== false && status.turns !== undefined;
  if (!on) return html`<div class="empty">正文捕获未开启（租户声明 capture: true 才落正文侧库）</div>`;
  const degraded = status.degraded ? html` · <span class="badge err">侧库降级，缺行不完整</span>` : '';
  return html`<div class="muted" style="font-size:12px">捕获 <b class="num">${status.turns}</b> 轮 · 唯一正文 <b class="num">${status.contents}</b> 条 · ${fmtBytes(status.bytes)}${status.dropped > 0 ? html` · 丢弃 ${status.dropped} 轮` : ''}${degraded}（TTL 保留期后自动清理；原文只进本机 capture.db）</div>`;
}

/* 工具 / skill 灌上下文分析 */
function CaptureTools() {
  const [days, setDays] = useState('7');
  const [st, setSt] = useState({});
  useEffect(() => {
    let alive = true;
    fetchJson(withTenant(`/api/capture/tools?days=${days}`))
      .then((t) => alive && setSt(t || {}))
      .catch((e) => alive && setSt({ error: e.message }));
    return () => { alive = false; };
  }, [days]);
  const rows = (st.tools || []).map((t) => html`
    <tr key=${t.tool}><td>${t.tool}</td><td class="num">${t.calls}</td><td class="num">${t.results}</td>
      <td class="num">${t.errors ? html`<span class="lost">${t.errors}</span>` : '0'}</td><td class="num">${t.result_chars}</td><td class="num">≈${t.result_tokens_est}</td></tr>`);
  return html`<${Fragment}>
    <div class="toolbar">
      <label>天数 <select value=${days} onChange=${(e) => setDays(e.target.value)}><option value="1">1</option><option value="7">7</option><option value="30">30</option></select></label>
      <span class="hint muted">灌入量按结果字符折算（≈3.5 字符/token）；「卡住候选」= 同工具同参数连续多轮</span>
    </div>
    <table>
      <thead><tr><th>工具</th><th class="num">调用</th><th class="num">结果</th><th class="num">报错</th><th class="num">灌入字符</th><th class="num">≈tokens</th></tr></thead>
      <tbody>${st.error ? html`<tr><td colspan="6" class="empty">加载失败：${st.error}</td></tr>`
        : rows.length ? rows : html`<tr><td colspan="6" class="empty">窗口内没有工具调用</td></tr>`}</tbody>
    </table>
    <div class="muted" style="font-size:12px;margin-top:8px">${(st.loops || []).length ? html`⚠ 卡住候选：${st.loops.slice(0, 5).map((l, i) => html`<span key=${i}>${l.identity} · ${l.tool} ×${l.streak} 轮${i < 4 && i < st.loops.slice(0, 5).length - 1 ? '；' : ''}</span>`)}` : ''}</div>
  <//>`;
}

/* 泄漏取证命中 */
function CapturePrivacy() {
  const [hits, setHits] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchJson(withTenant('/api/capture/privacy?limit=50'))
      .then((p) => alive && setHits(p?.hits || []))
      .catch(() => alive && setHits([]));
    return () => { alive = false; };
  }, []);
  return html`<table>
    <thead><tr><th>时间</th><th>租户</th><th>规则</th><th>位置</th><th>首次出现</th></tr></thead>
    <tbody>${hits === null ? html`<tr><td colspan="5" class="empty">加载中…</td></tr>`
      : hits.length ? hits.map((h, i) => {
        const first = h.first_seen_turn;
        return html`<tr key=${i}><td class="num">${fmtClock(h.ts)}</td><td>${h.tenant}</td><td><span class="badge warn">${h.rule ?? '?'}</span></td>
          <td>${h.role || '?'} · 第 ${num(h.message_index) ? h.message_index + 1 : '?'} 条</td>
          <td class="num">${first ? html`${first.identity} @ ${fmtClock(first.ts)}` : html`<span class="muted">侧库已清理</span>`}</td></tr>`;
      }) : html`<tr><td colspan="5" class="empty">没有泄漏命中（从未保存过命中原文）</td></tr>`}</tbody>
  </table>`;
}

/* 系统事件流 */
function Events() {
  const [kind, setKind] = useState('');
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    fetchJson(withTenant(`/api/events?limit=100${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`))
      .then((d) => { if (alive) { setEvents(d.events || []); setErr(''); } })
      .catch((e) => { if (alive) setErr(String(e.message || e)); });
    return () => { alive = false; };
  }, [kind]);
  return html`<${Fragment}>
    <div class="toolbar">
      <select value=${kind} onChange=${(e) => setKind(e.target.value)}>
        <option value="">全部事件</option>
        <option value="route.rebind">改绑（route.rebind）</option>
        <option value="route.hold">撞墙保持（route.hold）</option>
        <option value="route.bind">首绑（route.bind）</option>
        <option value="policy.error">policy 异常</option>
        <option value="privacy.hit">泄漏命中</option>
      </select>
    </div>
    <ul class="timeline">${err ? html`<li class="empty">加载失败：${err}</li>`
      : events === null ? html`<li class="empty">加载中…</li>`
      : events.length ? events.map((ev, i) => {
        let detail = ev.detail;
        try { detail = ev.detail ? JSON.stringify(JSON.parse(ev.detail)) : ''; } catch { detail = ev.detail || ''; }
        return html`<li key=${i}><span class=${`t-kind ${ev.kind.replace('.', '\\.')}`}>${ev.kind}</span>
          <span class="num">${fmtClock(ev.ts)}</span>
          <span>${ev.tenant ?? ''}</span>
          <span class="t-detail">${detail.slice(0, 160)}</span></li>`;
      }) : html`<li class="empty">没有事件</li>`}</ul>
  <//>`;
}

export function App() {
  return html`<${Fragment}>
    <h2>正文捕获状态</h2>
    <${CaptureStatus} />
    <h2>工具 / skill 灌上下文分析</h2>
    <${CaptureTools} />
    <h2>泄漏取证命中</h2>
    <${CapturePrivacy} />
    <h2>系统事件流</h2>
    <${Events} />
  <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
