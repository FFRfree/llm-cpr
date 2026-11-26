// pages/trajectory.js —— 轨迹工作台（SPA 视图）。原 trajectory.html（v7，MR#5）的组件化版：
// 领域逻辑（buildForest/visibleGraph/hiddenSet/drawRail 几何/turn-diffs 渐进填充）原样保留，
// 手写状态机（state 对象 + innerHTML 重绘 + 事件委托）换成 st 可变引用 + bump 版本重渲——
// DOM 由 Preact diff 复用，滚动位/展开态不再丢（原 renderMain 的 scrollY 补偿不再需要）。
import { useState, useEffect, useRef } from 'preact/hooks';
import { Fragment } from 'preact';
import { html } from '../lib/html.js';

/* ---- 常量与纯函数（与原版一致） ---- */
const RAILS = ['#3fae7a', '#d29a3a', '#5b8def', '#9a6fd0', '#d05b6a', '#3a9ad2', '#7aa23f', '#b06fd0'];
const LANE_W = 22, DOT_R = 6, RAIL_PAD = 14, MAX_LANES = 8;
const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const fmtGap = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const stCol = (s) => s == null ? 'var(--muted)' : (s < 300 ? 'var(--success)' : s === 499 ? 'var(--muted)' : 'var(--danger)');
const retryColor = (list) => {
  const stt = list.map((t) => t.status);
  if (stt.length && stt.every((s) => s != null && s < 300)) return 'var(--success)';
  if (stt.length && stt.every((s) => s != null && s >= 400 && s !== 499)) return 'var(--danger)';
  return 'var(--warning)';
};
const railCol = (l) => RAILS[l % RAILS.length];
const roleOf = (n) => String(n.addedRoles?.[0] ?? (n.parent ? '?' : 'S')).toLowerCase();
const subtreeCache = new Map();
function subtreeOf(root) {
  if (subtreeCache.has(root.id)) return subtreeCache.get(root.id);
  const ids = new Set(); const stack = [root];
  while (stack.length) { const n = stack.pop(); if (ids.has(n.id)) continue; ids.add(n.id); n.children.forEach((c) => stack.push(c)); }
  subtreeCache.set(root.id, ids); return ids;
}

/* ---- 前缀森林：树由后端 /api/capture/tree 建好，前端只组装展示结构 ---- */
function buildForest(tree) {
  const nodes = tree.nodes.map((n) => ({
    id: n.id,
    turns: n.turns.map((t) => ({ ...t, id: t.turn_id })),
    parent: null, children: [],
    threadKey: n.thread_key, refsLen: n.parent_len + n.added_count,
    parentLen: n.parent_len, addedCount: n.added_count, addedBytes: n.added_bytes,
    addedRoles: n.added_roles || [],
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const dto of tree.nodes) {
    if (dto.parent == null) continue;
    const node = byId.get(dto.id), p = byId.get(dto.parent);
    if (node && p) { node.parent = p; p.children.push(node); }
  }
  const sizes = new Map();
  const sizeOf = (n) => {
    if (sizes.has(n.id)) return sizes.get(n.id);
    sizes.set(n.id, 1);
    const total = 1 + n.children.reduce((s, c) => s + sizeOf(c), 0);
    sizes.set(n.id, total);
    return total;
  };
  const roots = nodes.filter((n) => !n.parent);
  const trunks = new Map();
  for (const root of roots) {
    sizeOf(root);
    const path = [];
    let cur = root;
    while (cur) { path.push(cur.id); const kids = cur.children.slice().sort((a, b) => sizes.get(b.id) - sizes.get(a.id)); cur = kids[0] || null; }
    trunks.set(root.id, path);
  }
  const branches = [];
  const walk = (n, treeRoot, depth) => {
    const kk = n.children.slice().sort((a, b) => sizes.get(b.id) - sizes.get(a.id));
    kk.forEach((c, i) => {
      if (i > 0) branches.push({ id: String(c.id), parent: n, node: c, treeRoot, forkAt: n.refsLen + 1, count: sizes.get(c.id), ts: c.turns[0].ts, depth: depth + 1 });
      walk(c, treeRoot, i > 0 ? depth + 1 : depth);
    });
  };
  const threadLabels = new Map(Object.entries(tree.thread_labels || {}));
  for (const root of roots) {
    const label = threadLabels.get(root.threadKey) ?? root.threadKey.slice(0, 12);
    branches.push({ id: 'trunk-' + root.id, trunk: true, node: root, treeRoot: root, count: trunks.get(root.id).length, ts: root.turns[0].ts, depth: 0, label });
    walk(root, root, 0);
  }
  branches.sort((a, b) => (a.trunk ? -1 : b.trunk ? 1 : a.ts - b.ts));
  const forest = { nodes, roots, sizes, trunks, byId, turnNode: new Map(nodes.flatMap((n) => n.turns.map((t) => [t.id, n]))) };
  const outOfWindow = tree.out_of_window || 0;
  const turns = nodes.flatMap((n) => n.turns);
  return { forest, branches, outOfWindow, turns };
}

function hiddenSet(sel, branches, forest) {
  const hide = new Set();
  for (const [id, on] of Object.entries(sel)) {
    if (on) continue;
    const b = branches.find((x) => x.id === id);
    if (!b) continue;
    if (b.trunk) { for (const nid of forest.trunks.get(b.treeRoot.id)) hide.add(nid); continue; }
    const stack = [b.node];
    while (stack.length) { const n = stack.pop(); if (hide.has(n.id)) continue; hide.add(n.id); n.children.forEach((c) => stack.push(c)); }
  }
  return hide;
}

/* ---- 可见图：泳道全局分配（跨树连续、≤8 道钳位），行序按 ts 正序，git graph 式列回收 ---- */
function visibleGraph(forest, branches, sel) {
  const hide = hiddenSet(sel, branches, forest);
  const visible = forest.nodes.filter((n) => !hide.has(n.id));
  const visIds = new Set(visible.map((n) => n.id));
  const kids = new Map();
  for (const n of visible) if (n.parent && visIds.has(n.parent.id)) { if (!kids.has(n.parent.id)) kids.set(n.parent.id, []); kids.get(n.parent.id).push(n); }
  const roots = visible.filter((n) => !n.parent || !visIds.has(n.parent.id));
  const sizes = forest.sizes;
  const order = [];
  for (const treeRoot of forest.roots) {
    const treeIds = subtreeOf(treeRoot);
    const treeRoots = roots.filter((r) => treeIds.has(r.id)).sort((a, b) => a.turns[0].ts - b.turns[0].ts);
    if (!treeRoots.length) continue;
    const tn = [], stack = treeRoots.slice().reverse();
    while (stack.length) {
      const n = stack.pop();
      if (tn.some((x) => x.id === n.id)) continue;
      tn.push(n);
      (kids.get(n.id) || []).slice().reverse().forEach((c) => stack.push(c));
    }
    order.push(...tn);
  }
  order.sort((a, b) => a.turns[0].ts - b.turns[0].ts);
  const kidIdx = new Map();
  for (const [pid, kk] of kids) kk.slice().sort((a, b) => sizes.get(b.id) - sizes.get(a.id)).forEach((c, i) => kidIdx.set(c.id, i));
  const bOf = new Map();
  const branchOf = (n) => {
    if (bOf.has(n.id)) return bOf.get(n.id);
    let bid;
    if (!n.parent) bid = 'trunk-' + n.id;
    else if (!visIds.has(n.parent.id)) bid = String(n.id);
    else bid = (kidIdx.get(n.id) || 0) > 0 ? String(n.id) : branchOf(n.parent);
    bOf.set(n.id, bid);
    return bid;
  };
  const rowOfNode = new Map();
  order.forEach((n, i) => rowOfNode.set(n.id, i));
  const headOfBid = new Map(), bMeta = new Map();
  for (const n of order) {
    const b = branchOf(n);
    const isHead = !n.parent || !visIds.has(n.parent.id) || (kidIdx.get(n.id) || 0) > 0;
    if (!bMeta.has(b)) bMeta.set(b, { birth: Infinity, last: -1 });
    const m = bMeta.get(b);
    m.last = Math.max(m.last, rowOfNode.get(n.id));
    if (!isHead || headOfBid.has(b)) continue;
    headOfBid.set(b, n.id);
    m.birth = n.parent && visIds.has(n.parent.id) ? rowOfNode.get(n.parent.id) : rowOfNode.get(n.id);
  }
  const laneFreeAt = [], laneOfBranch = new Map(), laneOf = new Map();
  const bids = [...bMeta.keys()].sort((x, y) => {
    const mx = bMeta.get(x), my = bMeta.get(y);
    return mx.birth - my.birth || (kidIdx.get(headOfBid.get(x)) || 0) - (kidIdx.get(headOfBid.get(y)) || 0) || String(x).localeCompare(String(y));
  });
  for (const b of bids) {
    const m = bMeta.get(b);
    let l = 0;
    while (l < laneFreeAt.length && laneFreeAt[l] >= m.birth) l++;
    if (l === laneFreeAt.length) laneFreeAt.push(m.last);
    laneFreeAt[l] = m.last;
    laneOfBranch.set(b, l);
  }
  for (const n of order) laneOf.set(n.id, laneOfBranch.get(bOf.get(n.id)) ?? 0);
  const branchInfo = new Map(), branchColor = new Map();
  bids.forEach((b, i) => {
    const head = headOfBid.get(b), hn = forest.byId.get(Number(String(head).replace(/^trunk-/, '')));
    const info = { head, parent: hn && hn.parent && visIds.has(hn.parent.id) ? hn.parent.id : null, lane: laneOfBranch.get(b), lastNode: null, color: RAILS[i % RAILS.length] };
    branchInfo.set(b, info);
    branchColor.set(b, info.color);
  });
  for (const [bid, bi] of branchInfo) {
    let best = null, bestRow = -1;
    for (const n of order) if (bOf.get(n.id) === bid) { const r = rowOfNode.get(n.id); if (r > bestRow) { bestRow = r; best = n.id; } }
    bi.lastNode = best;
  }
  return { order, laneOf, kids, branchOf: bOf, branchInfo, branchColor, nLanes: Math.max(1, laneFreeAt.length) };
}

const railW = (g) => RAIL_PAD * 2 + Math.min(g.nLanes, MAX_LANES) * LANE_W;
const laneX = (l) => RAIL_PAD + Math.min(l, MAX_LANES - 1) * LANE_W + LANE_W / 2;

/* ---- 消息卡（bubble）：LLM 侧左绿 / harness 侧右蓝灰；折叠态局部状态 ----
   外壳只判空（tree-diffs 半截降级会给 null 占位），hooks 全在内壳——hook 数恒定不受判空影响 */
function MsgCard({ m, idx }) {
  if (m == null) return html`<div class="mcard m-h r-tool"><div class="mh"><span class="mr">harness · 已清理</span><span class="mi">#${idx + 1}</span></div><div class="mtext">[正文已被 TTL 清理]</div></div>`;
  return html`<${CardInner} m=${m} idx=${idx} />`;
}
function CardInner({ m, idx }) {
  const [fold, setFold] = useState(true);   // system/tool 回显默认折叠
  const [clamped, setClamped] = useState(true); // 长文钳 10 行
  const [tcsOpen, setTcsOpen] = useState(false); // 工具调用参数展开（逐 chip）
  const role = String(m.role ?? '?').toLowerCase();
  const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  const text = m.content == null ? '' : typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? (m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') || JSON.stringify(m.content, null, 2))
    : JSON.stringify(m.content, null, 2);
  const side = role === 'assistant' ? 'm-llm' : 'm-h';
  const who = role === 'assistant' ? 'LLM · assistant' : `harness · ${role}`;
  const respond = m.tool_call_id ? html`<span class="mi">回应 ${String(m.tool_call_id)}</span>` : '';
  const tc = toolCalls.length ? html`<div class="tcalls">${toolCalls.map((tcall, i) => {
    let pretty = tcall.function?.arguments ?? '';
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch {}
    return html`<${Fragment} key=${i}>
      <button class="tcl${tcsOpen ? ' open' : ''}" onClick=${() => setTcsOpen(!tcsOpen)}>🔧 ${tcall.function?.name ?? '?'}</button>
      <div class="targs" style=${tcsOpen ? 'display:block' : null}><pre>${pretty}</pre></div>
    <//>`;
  })}</div>` : '';
  const mh = html`<div class="mh"><span class="mr">${who}</span><span class="mi">#${idx + 1}</span>${respond}</div>`;
  if (role === 'system' || role === 'tool') {
    const brief = text.replace(/\s+/g, ' ').slice(0, 110);
    return html`<div class="mcard fold ${side} r-${role}">${mh}${tc}
      ${text && html`<button class="mfold" onClick=${() => setFold(!fold)}>${brief}${text.length > 110 ? '…' : ''} ${fold ? '▸' : '▾'}</button>
      <div class="mbody" style=${fold ? null : 'display:block'}><div class="mtext">${text}</div></div>`}
    </div>`;
  }
  const long = text.length > 800;
  return html`<div class="mcard ${side} r-${role}">${mh}${tc}
    ${text && html`<div class="mtext${long && clamped ? ' clamp' : ''}">${text}</div>
    ${long && html`<button class="mfold2" onClick=${() => setClamped(!clamped)}>${clamped ? '展开全文 ▾' : '收起 ▴'}</button>`}`}
  </div>`;
}

/* ---- 行体：气泡流；收起钳 2 条 + 「还有 N 条」；正文未到时占位/按需拉 ---- */
function RowBody({ st, n, bump, open }) {
  const want = st.attempt.get(n.id) ?? n.turns[n.turns.length - 1].id;
  const data = st.bodies.get(want);
  const loading = st.loadingRows?.has(want);
  useEffect(() => {
    if (data || !open || loading) return;
    if (!st.loadingRows) st.loadingRows = new Set();
    st.loadingRows.add(want);
    getBody(st, want).then(() => { st.loadingRows.delete(want); bump(); })
      .catch((e) => { st.loadingRows.delete(want); st.errors = st.errors || new Map(); st.errors.set(want, String(e.message || e)); bump(); });
  }, [want, open, !!data]);
  if (!data) {
    if (st.errors?.has(want)) return html`<div class="tload">正文加载失败：${st.errors.get(want)}</div>`;
    return html`<div class="tload">${n.parent ? `[${roleOf(n)}] 第 ${n.parentLen + 1} 条起 +${n.addedCount}` : '[S] 线程起点'}</div>`;
  }
  const added = data.messages;
  if (!added.length) return html`<div class="tload">（本轮无新增消息——同前缀的另一次尝试）</div>`;
  const cards = added.map((m, j) => html`<${MsgCard} key=${j} m=${m} idx=${data.start + j} />`);
  return html`<${Fragment}>${(!open && cards.length > 3)
    ? html`${cards.slice(0, 2)}<button class="morehint" onClick=${() => st.onExpand(n.id)}>⋯ 还有 ${cards.length - 2} 条 · 点行展开</button>`
    : cards}<//>`;
}

/* ---- 单轮正文兜底（turn-diffs 没盖住的） ---- */
async function getBody(st, turnId) {
  if (st.bodies.has(turnId)) return st.bodies.get(turnId);
  const data = await fetchJson(`/api/capture/turns/${turnId}`);
  const n = st.forest?.turnNode?.get(turnId);
  const parentLen = n && n.parent ? n.parent.refsLen : 0;
  const out = { start: parentLen, messages: (data.body?.messages || []).slice(parentLen) };
  st.bodies.set(turnId, out);
  return out;
}

/* ---- 行（轮）：行头单行制 + 展开气泡 + ×N 尝试条 ---- */
function Row({ st, n, prevTs, bump }) {
  const open = st.expanded.has(n.id);
  const ns = n.turns.length, tN = n.turns[ns - 1];
  const rc = retryColor(n.turns);
  const stripOpen = st.stripFor === n.id;
  return html`<div class="tblock" data-node=${n.id}>
    <div class="thead" onClick=${() => { st.expanded.has(n.id) ? st.expanded.delete(n.id) : st.expanded.add(n.id); bump(); }}>
      <div class="th2">
        <span class="caret">${open ? '▴' : '▾'}</span>
        <span class="tm">${fmtTime(tN.ts)}</span>
        ${prevTs != null && html`<span class="sp" title="距上一条请求的间隔">⏱${fmtGap(tN.ts - prevTs)}</span>`}
        <span class="stt" style=${`color:${stCol(tN.status)}`}>${tN.status ?? '—'}</span>
        <span class="sp">+${n.addedCount}</span>
        ${ns > 1 && html`<button class="xn" style=${`color:${rc};border-color:${rc}`}
          onClick=${(e) => { e.stopPropagation(); st.stripFor = stripOpen ? null : n.id; bump(); }}>×${ns} 尝试</button>`}
        ${!n.parent && html`<span class="troot">${String(n.addedRoles?.[1] ?? 'user').toLowerCase() !== 'user' ? '压缩续段' : '线程起点'}</span>`}
        <span class="tk">${String(n.threadKey ?? '').slice(0, 14)}</span>
      </div>
    </div>
    ${stripOpen && html`<div class="astrip">同一状态的尝试：${n.turns.map((t, i) => {
      const cur = st.attempt.get(n.id) ?? n.turns[n.turns.length - 1].id;
      return html`<button key=${t.id} class=${t.id === cur ? 'on' : ''}
        onClick=${() => { st.attempt.set(n.id, t.id); st.stripFor = null; bump(); }}>
        <i style=${`background:${stCol(t.status)}`}></i>#${i + 1} ${t.status ?? ''} ${fmtTime(t.ts)}</button>`;
    })}</div>`}
    <div class="tbody" onClick=${(e) => e.stopPropagation()}>
      <${RowBody} st=${st} n=${n} bump=${bump} open=${open} />
    </div>
  </div>`;
}

/* ---- 视图主体 ---- */
export function View({ reloadKey }) {
  const [, setVer] = useState(0);
  const bump = () => setVer((v) => v + 1);
  const ref = useRef(null);
  if (!ref.current) ref.current = { identity: null, tenant: null, tree: null, forest: null, branches: [], sel: {},
    attempt: new Map(), bodies: new Map(), graph: null, expanded: new Set(), diffRun: 0, diffFailed: false,
    stripFor: null, onExpand: null };
  const st = ref.current;
  st.onExpand = (nodeId) => { st.expanded.add(nodeId); bump(); };
  const [sessions, setSessions] = useState([]);
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState(null);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const streamRef = useRef(null), listRef = useRef(null), layerRef = useRef(null);

  /* 会话清单 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const q = search.trim().toLowerCase();
        const data = await fetchJson(withTenant('/api/audit/sessions?page=1&page_size=200&sort=last_ts&order=desc'));
        if (alive) setSessions((data.sessions || []).filter((s) => !q || String(s.identity).toLowerCase().includes(q)));
      } catch (e) { if (alive) setErr(`会话列表加载失败：${e.message}`); }
    })();
    return () => { alive = false; };
  }, [search, reloadKey]);

  /* 装载会话（树接口一次拿树 + 摘要） */
  const loadTurns = async (identity, tenant) => {
    st.identity = identity; st.tenant = tenant;
    st.tree = null; st.forest = null; st.branches = []; st.sel = {};
    st.attempt = new Map(); st.bodies = new Map(); st.diffFailed = false;
    st.expanded = new Set(); st.stripFor = null; subtreeCache.clear(); st.diffRun++;
    const tree = await fetchJson(`/api/capture/tree?identity=${encodeURIComponent(identity)}&tenant=${encodeURIComponent(tenant)}&limit=500`);
    st.tree = tree;
    const built = buildForest(tree);
    st.forest = built.forest; st.branches = built.branches; st.outOfWindow = built.outOfWindow; st.turns = built.turns;
    setFamily(tree.summary);
    st.graph = visibleGraph(st.forest, st.branches, st.sel);
    setErr('');
    bump();
  };

  /* 后台渐进拉正文：turn-diffs 游标翻页，每页落地 bump 一次（diff 整体挂掉走单轮兜底，一次性闸门） */
  useEffect(() => {
    const tree = st.tree;
    if (!tree || !st.graph) return;
    const run = ++st.diffRun;
    const total = tree.nodes.reduce((s, n) => s + n.turns.length, 0);
    if (st.bodies.size >= total || st.diffFailed) return;
    setProgress(st.bodies.size >= total ? '' : `气泡填充 ${st.bodies.size}/${total}…`);
    (async () => {
      const q = (k, v) => `${k}=${encodeURIComponent(String(v))}`;
      let afterTs = 0, afterId = 0;
      const w = tree.window;
      while (run === st.diffRun) {
        let page;
        try {
          page = await fetchJson(`/api/capture/tree-diffs?${q('identity', st.identity)}&${q('tenant', st.tenant)}` +
            `&after_ts=${afterTs}&after_id=${afterId}&since_ts=${w.since_ts}&since_id=${w.since_id}&upto_ts=${w.upto_ts}&limit_turns=60`);
        } catch { st.diffFailed = true; break; }
        if (run !== st.diffRun) return;
        for (const it of page.items) if (!st.bodies.has(it.turn_id)) st.bodies.set(it.turn_id, { start: it.start, messages: it.messages });
        setProgress(st.bodies.size >= total ? '' : `气泡填充 ${st.bodies.size}/${total}…`);
        bump();
        if (page.done || !page.items.length) break;
        afterTs = page.next_after.ts; afterId = page.next_after.id;
      }
      if (run !== st.diffRun) return;
      /* 兜底：diff 流没盖住的轮走单轮接口，5 并发 */
      const missing = [];
      for (const n of st.forest.nodes) for (const t of n.turns) if (!st.bodies.has(t.id)) missing.push({ n, id: t.id });
      let i = 0;
      const worker = async () => {
        while (i < missing.length) {
          const m = missing[i++];
          try { await getBody(st, m.id); if (run === st.diffRun) bump(); } catch { /* 单轮失败：该行保持占位 */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker()]);
      if (run === st.diffRun) setProgress('');
    })();
  }, [st.graph, st.tree]);

  /* 泳道绘制：块位置量出来后画轨道线/分叉曲线/圆点（每次渲染后 rAF 一次；窗口/流高度变化跟随） */
  useEffect(() => {
    let queued = false;
    const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; drawRail(); }); };
    const drawRail = () => {
      /* 壳 header 是 sticky 顶栏：把它的实时高度写进 CSS 变量，本视图的 sticky 元素（work-bar/会话列）让出顶栏 */
      document.documentElement.style.setProperty('--shell-header-h', (document.querySelector('#app > header')?.offsetHeight || 0) + 'px');
      const stream = streamRef.current, list = listRef.current, layer = layerRef.current;
      const g = st.graph;
      if (!stream || !list || !layer || !g || !list.querySelector('.tblock')) { if (layer) layer.innerHTML = ''; return; }
      const RW = railW(g);
      list.style.marginLeft = RW + 'px';
      const stop = stream.getBoundingClientRect().top;
      const yOf = new Map();
      list.querySelectorAll('.tblock').forEach((el) => {
        const h = el.querySelector('.thead');
        if (!h) return;
        const r = h.getBoundingClientRect();
        yOf.set(Number(el.dataset.node), r.top - stop + r.height / 2);
      });
      const seg = (x, y1, y2, col) => `<i class="rl" style="left:${x - 0.75}px;top:${Math.round(y1)}px;height:${Math.round(y2 - y1)}px;background:${col}"></i>`;
      const stub = (x, y, col) => seg(x, y - DOT_R - 4, y + DOT_R + 4, col);
      /* mhutchie git graph 同款换道曲线：C x1,(y1+d) x2,(y2-d) x2,y2，d=0.8×跨度 */
      const bend = (x1, y1, x2, y2, col) => {
        const d = 0.8 * (y2 - y1);
        const L = Math.min(x1, x2) - 3, T = y1 - 3;
        const w = Math.abs(x2 - x1) + 6, h = Math.max(y2 - y1, 1) + 6;
        const lx1 = x1 - L, lx2 = x2 - L;
        return `<svg class="rsvg" style="left:${L}px;top:${T}px" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
          `<path d="M${lx1} 3 C${lx1} ${3 + d} ${lx2} ${h - 3 - d} ${lx2} ${h - 3}" stroke="${col}" stroke-width="1.5" fill="none" opacity="0.9"/></svg>`;
      };
      let s = '';
      const ys = [...yOf.values()].sort((a, b) => a - b);
      let ONE_ROW = 44;
      if (ys.length > 2) { const df = []; for (let i = 1; i < ys.length; i++) df.push(ys[i] - ys[i - 1]); df.sort((a, b) => a - b); ONE_ROW = Math.max(24, df[df.length >> 1] || 44); }
      for (const bi of g.branchInfo.values()) {
        const yh = yOf.get(bi.head), yl = yOf.get(bi.lastNode);
        if (yh == null || yl == null) continue;
        const x = laneX(bi.lane);
        if (bi.parent == null) {
          if (yl - yh > 6) s += seg(x, yh, yl, bi.color);
          else s += stub(x, yh, bi.color);
          continue;
        }
        const yp = yOf.get(bi.parent);
        if (yp == null) continue;
        const x1 = laneX(g.laneOf.get(bi.parent) ?? bi.lane);
        const yT = Math.min(yp + ONE_ROW, yh);
        const bent = yT - yp > 2 && Math.abs(x1 - x) > 1;
        if (bent) s += bend(x1, yp, x, yT, bi.color);
        else if (yl > yp) s += seg(x, Math.max(yp, yh), yl, bi.color);
        if (bent && yT < yl - 6) s += seg(x, yT, yl, bi.color);
        else if (bent && yl - yh < 6) s += stub(x, yl, bi.color);
      }
      for (const n of g.order) {
        const y = yOf.get(n.id);
        if (y == null) continue;
        const l = g.laneOf.get(n.id);
        if (l == null) continue;
        const col = g.branchColor.get(g.branchOf.get(n.id)) || RAILS[0];
        const rr = DOT_R + (n.turns.length > 1 ? 2 : 0);
        const fork = (g.kids.get(n.id) || []).length > 1;
        s += fork
          ? `<i class="rd rg" style="left:${laneX(l) - rr - 1.5}px;top:${y - rr - 1.5}px;width:${rr * 2 + 3}px;height:${rr * 2 + 3}px;border-color:${col}"></i>`
          : `<i class="rd" style="left:${laneX(l) - rr}px;top:${y - rr}px;width:${rr * 2}px;height:${rr * 2}px;background:${col}"></i>`;
      }
      layer.innerHTML = s;
    };
    schedule();
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    if (streamRef.current) ro.observe(streamRef.current);
    return () => { window.removeEventListener('resize', schedule); ro.disconnect(); };
  });

  /* 深链：/trajectory?identity=…&capture_id=… */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const identity = params.get('identity');
    if (!identity) return;
    const deepKey = `${identity}|${reloadKey}|${sessions.length}`;
    if (st.deepKey === deepKey) return; // 同一（identity, 租户代, 清单代）只装载一次——deps 双触发去重
    st.deepKey = deepKey;
    (async () => {
      const s = sessions.find((x) => x.identity === identity) ||
        (await fetchJson(withTenant('/api/audit/sessions?page=1&page_size=200&sort=last_ts&order=desc')).catch(() => null))?.sessions?.find((x) => x.identity === identity);
      if (!s) { setErr(`会话 ${identity} 不在最近 200 个会话里，请从列表里挑`); return; }
      try {
        await loadTurns(identity, s.tenant || 'default');
        const captureId = params.get('capture_id');
        if (captureId) {
          const turn = st.turns.find((t) => t.capture_id === captureId);
          const node = turn && st.forest ? st.forest.nodes.find((n) => n.turns.some((t) => t.id === turn.id)) : null;
          if (node) {
            st.attempt.set(node.id, turn.id);
            st.expanded.add(node.id);
            bump();
            requestAnimationFrame(() => {
              document.querySelector(`#app .tblock[data-node="${node.id}"]`)?.scrollIntoView({ block: 'center' });
            });
          } else setErr(`轮次 ${captureId.slice(0, 8)}… 不在最近 500 轮里（可能已过 TTL 清理）`);
        }
      } catch (e) { setErr(`轮次加载失败：${e.message}`); }
    })();
  }, [sessions.length > 0, reloadKey]); // 首次装载后跑一次；sessions 就绪即试；切租户（reloadKey）后按新租户重解深链

  const g = st.graph;
  let prevTs = null;
  return html`<${Fragment}>
    <style>${TRAJ_CSS}</style>
    <h2>轨迹工作台</h2>
    <p class="muted" style="font-size:12px;margin:0 0 4px">
      左列挑会话 → 右侧是这条会话的轮次流（从上到下按时间排）：一轮 = 一次发给模型的请求，行内以聊天气泡展示该轮新增消息——
      LLM 侧（assistant 回复）靠左绿，harness 侧（你的输入 / 工具结果 / 系统）靠右蓝灰；收起态只露前 2 条气泡，
      点行展开全量（工具调用可点开看参数，工具回显/系统提示再折叠一层，长文钳 10 行）。每条消息只出现一次（= 它被首次追加的那一轮）。
      树结构画在左缘泳道：一个圆点 = 一轮（同一前缀的重试收进 ×N），分叉 = 同一前缀拐出不同走向。
      顶栏 chips 显隐分支（主干 = 最长链，也是一条分支）；Hermes 压缩改写历史产生的续段会标「压缩续段」。
    </p>
    <div class="toolbar">
      <input type="search" placeholder="会话 ID 过滤…" autocomplete="off" value=${search} onInput=${(e) => setSearch(e.target.value)} />
    </div>
    ${err && html`<div id="err">${err}</div>`}
    <div class="traj">
      <section id="pane-sessions">
        <h3>会话（有捕获的）</h3>
        <ul id="traj-sessions">${sessions.length ? sessions.map((s) => html`
          <li key=${s.identity + '|' + (s.tenant || '')} class=${st.identity === s.identity ? 'active' : ''}
              onClick=${() => loadTurns(s.identity, s.tenant || 'default').catch((e2) => setErr(`轮次加载失败：${e2.message}`))}>
            <div class="who">${s.identity}</div>
            <div class="meta">${s.tenant || 'default'} · ${s.requests} 请求 · ${rel(s.last_ts)}</div>
          </li>`) : html`<li class="empty">没有匹配的会话</li>`}
        </ul>
      </section>
      <section id="pane-main">
        <div id="work-bar">
          <div class="fam"><${FamLine} st=${st} family=${family} progress=${progress} /></div>
          ${st.forest && html`<div>
            ${st.outOfWindow > 0 && html`<div class="traj-note2">${st.outOfWindow} 轮在 500 轮取证窗口外，未入图。</div>`}
            <div class="bh" style="padding:2px 0 0"><b>分支 ${st.branches.length}（含主干）</b>
              <button onClick=${() => { st.branches.forEach((b) => { st.sel[b.id] = true; }); st.graph = visibleGraph(st.forest, st.branches, st.sel); bump(); }}>全选</button>
              <button onClick=${() => { st.branches.forEach((b) => { st.sel[b.id] = !!b.trunk; }); st.graph = visibleGraph(st.forest, st.branches, st.sel); bump(); }}>只看主干</button></div>
            <div class="bchips">${st.branches.map((b) => {
              const dis = ancHidden(st, b);
              const on = !dis && st.sel[b.id] !== false;
              const label = b.trunk ? '★ 主干' : (b.label || `分支 ${b.id}`).slice(0, 14);
              const meta = b.trunk ? `主干（最长链）· ${b.count} 轮 · ${fmtTime(b.ts)} 起` : `⎇ 自第 ${b.forkAt} 条分出 · ${b.count} 轮 · ${fmtTime(b.ts)} 起`;
              const lane = g.laneOf.get(b.node.id);
              const col = on ? (g.branchColor.get(b.id) || (lane != null ? railCol(lane) : 'var(--muted)')) : 'var(--muted)';
              return html`<button key=${b.id} class="bchip${dis ? ' dis' : on ? ' on' : ' off'}" disabled=${dis} title=${meta}
                onClick=${() => { if (dis) return; st.sel[b.id] = st.sel[b.id] === false; st.graph = visibleGraph(st.forest, st.branches, st.sel); bump(); }}>
                <i style=${`background:${col}`}></i><span>${label}</span><em>${b.count}</em></button>`;
            })}</div>
          </div>`}
        </div>
        <div id="work-stream" ref=${streamRef}>
          <div id="rail-layer" aria-hidden="true" ref=${layerRef}></div>
          <div id="stream-list" ref=${listRef}>
            ${!st.forest && html`<div class="empty" style="padding:20px;text-align:center">选一个会话</div>`}
            ${st.forest && g && html`<${Fragment}>
              ${st.outOfWindow > 0 && html`<div class="traj-note2">${st.outOfWindow} 轮在 500 轮取证窗口外（编号按窗口内）。</div>`}
              ${!g.order.length && html`<div class="empty" style="padding:20px;text-align:center">没有可展示的轮次——至少勾一条分支。</div>`}
              ${g.order.map((n) => { const row = html`<${Row} key=${n.id} st=${st} n=${n} prevTs=${prevTs} bump=${bump} />`; prevTs = n.turns[n.turns.length - 1].ts; return row; })}
            <//>`}
          </div>
        </div>
      </section>
    </div>
  <//>`;
}

function ancHidden(st, b) {
  if (b.trunk) return false;
  let p = b.parent;
  while (p) { const ab = st.branches.find((x) => !x.trunk && x.node === p); if (ab && st.sel[ab.id] === false) return true; p = p.parent; }
  return false;
}

/* 家族徽标行：摘要用 tree.summary（后端算好）+ 气泡填充进度。
   注意：html`` 产物是 VNode，不能跟字符串做 + 拼接（会 toString 成 [object Object]），条件段全部留在模板里 */
function FamLine({ st, family, progress }) {
  const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const k = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (!st.forest) return html`挑一个会话`;
  return html`<b>${family && family.threads > 1 ? 'deleg 家族' : '单线程'}</b> · ${family ? family.threads : '?'} 线程 · ${family ? family.turns : (st.turns ? st.turns.length : 0)} 轮
  ${family && html` · 效率 <b>${pct(family.efficiency)}</b> · 浪费 ${pct(family.waste_share)} · 重读 ×${k(family.read_multiplier)} · ~${k(family.corpus_tokens_est)} tok`}
  ${family?.turns_skipped_no_usage ? html` · ${family.turns_skipped_no_usage} 轮无 usage` : ''}
  ${progress && html`<span class="muted" style="margin-left:10px">${progress}</span>`}`;
}

/* 轨迹页专属样式（原 trajectory.html <style> 块原样搬入，SPA 下随视图挂载/卸载） */
const TRAJ_CSS = `
.traj{grid-template-columns:260px 1fr;align-items:start}
#pane-main{min-width:0;max-height:none;overflow:visible}
#pane-sessions{position:sticky;top:calc(var(--shell-header-h, 56px) + 8px);max-height:calc(100vh - var(--shell-header-h, 56px) - 16px);overflow-y:auto}
#work-bar{position:sticky;top:var(--shell-header-h, 56px);z-index:30;background:var(--surface);border-bottom:1px solid var(--border)}
#work-bar .fam{padding:7px 12px 2px;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#work-bar .bchips{display:flex;flex-wrap:wrap;gap:5px;padding:2px 12px 7px}
.bchip{display:inline-flex;align-items:center;gap:5px;max-width:250px;background:none;border:1px solid var(--border);border-radius:20px;padding:1px 9px 1px 7px;cursor:pointer;font-size:11px;color:var(--text-2)}
.bchip i{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--muted)}
.bchip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bchip em{font-style:normal;font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0}
.bchip.on{border-color:var(--border-strong);color:var(--text)}
.bchip.off{opacity:.35}
.bchip.dis{opacity:.22;cursor:default}
.bh{display:flex;gap:6px;align-items:center}
.bh b{font-size:11px;color:var(--text-2)}
.bh button{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:1px 8px;cursor:pointer;font-size:11px}
.bh button:hover{color:var(--text);border-color:var(--border-strong)}
.traj-note2{padding:4px 12px;font-size:10px;color:var(--muted);border-bottom:1px solid var(--border)}
#work-stream{position:relative}
#rail-layer{position:absolute;top:0;left:0;bottom:0;pointer-events:none;z-index:0;overflow:visible}
#rail-layer .rl{position:absolute;width:1.5px;opacity:.5;border-radius:1px}
#rail-layer .rd{position:absolute;border-radius:50%;border:1.5px solid var(--surface);box-sizing:border-box}
#rail-layer .rd.rg{background:var(--surface);border-width:2px}
#rail-layer .rk{position:absolute;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid var(--warning)}
#rail-layer .rsvg{position:absolute;pointer-events:none;overflow:visible}
#stream-list{position:relative;z-index:1}
.tblock{border-bottom:1px solid var(--border)}
.thead{padding:7px 12px 7px 0;cursor:pointer;min-width:0}
.thead:hover{background:var(--hover)}
.th2{display:flex;gap:8px;align-items:center;height:18px;font-size:10px;color:var(--muted);font-family:var(--mono);min-width:0}
.th2 .caret{flex-shrink:0;color:var(--muted);font-size:10px;width:12px;text-align:center}
.th2 .tm,.th2 .stt,.th2 .sp{flex-shrink:0}
.th2 .stt{font-weight:700}
.th2 .xn{flex-shrink:0;background:none;border:1px solid var(--border);border-radius:6px;padding:0 7px;cursor:pointer;font-size:10px;font-family:var(--mono)}
.th2 .xn:hover{filter:brightness(1.15)}
.th2 .troot{flex-shrink:0;font-size:10px;border:1px solid var(--warning);color:var(--warning);border-radius:6px;padding:0 6px;font-family:var(--sans)}
.th2 .tk{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.astrip{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:2px 12px 6px 0;font-size:11px;color:var(--muted)}
.astrip button{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:1px 8px;cursor:pointer;font-size:11px;font-family:var(--mono)}
.astrip button.on{color:var(--text);border-color:var(--border-strong);background:var(--hover)}
.astrip i{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:3px}
.tbody{display:flex;flex-direction:column;gap:7px;padding:2px 12px 12px 0;cursor:default}
.tload{padding:2px 0;font-size:11px;color:var(--muted)}
.mcard{border:1px solid var(--border);border-radius:10px;padding:7px 10px;background:var(--surface);font-size:12px;min-width:0;align-self:flex-start;max-width:78%}
.mcard.m-llm{border-color:color-mix(in srgb,var(--success) 40%,var(--border));background:color-mix(in srgb,var(--success) 7%,var(--surface))}
.mcard.m-llm .mr{color:var(--success)}
.mcard.m-h{align-self:flex-end}
.mcard.m-h .mr{color:var(--muted)}
.mcard.m-h.r-user{border-color:color-mix(in srgb,var(--accent-bright,#5b8def) 40%,var(--border));background:color-mix(in srgb,var(--accent-bright,#5b8def) 7%,var(--surface))}
.morehint{align-self:center;background:none;border:1px dashed var(--border);color:var(--muted);border-radius:8px;padding:2px 10px;cursor:pointer;font-size:10px}
.mcard.r-user{border-left:3px solid var(--accent-bright,#5b8def)}
.mcard.r-assistant{border-left:3px solid var(--success)}
.mcard.r-tool,.mcard.r-system{border-left:3px solid var(--muted);color:var(--text-2)}
.mh{display:flex;gap:8px;align-items:baseline;font-size:10px;color:var(--muted);margin-bottom:3px;flex-wrap:wrap;min-width:0}
.mh .mr{text-transform:uppercase;font-weight:700;letter-spacing:.5px}
.mh .mi{font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.mcard.fold .mbody{display:none}
.mfold{display:block;width:100%;text-align:left;background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mfold:hover{color:var(--text)}
.mtext{white-space:pre-wrap;word-break:break-word;line-height:1.5}
.mtext.clamp{display:-webkit-box;-webkit-line-clamp:10;-webkit-box-orient:vertical;overflow:hidden}
.mfold2{background:none;border:none;color:var(--muted);font-size:10px;cursor:pointer;padding:2px 0 0}
.mfold2:hover{color:var(--text)}
.tcalls{display:flex;flex-wrap:wrap;gap:5px;margin:3px 0}
.tcl{background:var(--hover);border:1px solid var(--border);border-radius:6px;font-size:10px;font-family:var(--mono);color:var(--text-2);padding:1px 8px;cursor:pointer;flex-shrink:0}
.tcl:hover{color:var(--text);border-color:var(--border-strong)}
.targs{display:none;margin:5px 0 0}
.tcl.open + .targs{display:block}
.targs pre{max-height:220px;overflow:auto;font-size:10px;margin:0;padding:6px;background:var(--hover);border-radius:6px}
@media (max-width:760px){.traj{grid-template-columns:1fr}#pane-sessions{position:static;max-height:none}}
`;
