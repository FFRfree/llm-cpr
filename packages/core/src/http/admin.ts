// 管理口（127.0.0.1 专用，绝不暴露公网）：静态看板分发 + 只读 API 面。
// 接口 = createAdminServer(deps)：deps 是网关运行时的只读视图（账本/事件/快照/捕获），
// 本模块不做鉴权——隔离靠「只绑 127.0.0.1」与 nginx/SSO 反代，行为约定见 vps-services 登记卡。
// 唯一的写操作是 POST /api/snapshots/refresh（快照轮询的手动触发器）。
import http, { type Server } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { json, messageOf } from './respond.ts';
import { rankBackends, monthlyDebtScore } from '../policy/selection.ts';
import type { UsageAudit } from '../store/audit.ts';
import type { SystemEventStore, EventKind } from '../store/events.ts';
import type { UsageSnapshots } from '../store/snapshots.ts';
import type { CaptureStore } from '../store/capture.ts';
import type { EfficiencyRates } from '../observability/cache-efficiency.ts';
import { DEFAULT_RATES } from '../observability/cache-efficiency.ts';
import type { RouterPolicy } from '../policy/contract.ts';

// ---- 后台 v2 静态分发（多页 Admin）：static/ 目录白名单扩展名，路径解析后必须仍落在
// static/ 内（防穿越）；HTML no-store、资产 60s。旧单页 dashboard.html 已废弃删除。
const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'static');
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};
function serveStatic(url: URL, res: http.ServerResponse): boolean {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const type = STATIC_TYPES[path.extname(pathname).toLowerCase()];
  if (!type) return false;
  let rel = '';
  try { rel = path.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, ''); } catch { return false; }
  const abs = path.join(STATIC_ROOT, rel);
  if (!rel || !abs.startsWith(STATIC_ROOT + path.sep)) return false;
  try {
    const bytes = fs.readFileSync(abs);
    res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': pathname.endsWith('.html') ? 'no-store' : 'max-age=60' });
    res.end(bytes);
    return true;
  } catch { return false; }
}

// /api/events 的 kind 白名单（非法值 → 不过滤，不把枚举面打开）。
const EVENT_KINDS: ReadonlySet<string> = new Set(['route.bind', 'route.rebind', 'route.hold', 'policy.error', 'privacy.hit', 'policy.reload', 'policy.reload.error']);

// ---- 版本信息（工单 07）：打开看板才现查 npm registry，缓存 1 小时；进程其余时间零 registry 请求 ----
const PKG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { name?: string; version?: string };
const RUNTIME_VERSION = PKG.version ?? 'unknown';
const REGISTRY_BASE = process.env.CPR_REGISTRY_URL || 'https://registry.npmjs.org';
const LATEST_TTL_MS = Number(process.env.CPR_LATEST_TTL_MS ?? 3_600_000);
let latestCache: { at: number; latest: string | null } | null = null;

async function npmLatestCached(): Promise<string | null> {
  if (latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) return latestCache.latest;
  let latest: string | null = null;
  try {
    const res = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(PKG.name ?? '@ffrfree/llm-cpr')}/latest`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) latest = ((await res.json()) as { version?: string }).version ?? null;
  } catch { latest = null; } // 离线/registry 不可达：徽标降级只报当前版，不影响端点本身
  latestCache = { at: Date.now(), latest };
  return latest;
}

// 看板用租户视图（/api/route/status 的 tenants 清单）：backends/models 缺省 = 全池/全部模型。
export interface AdminTenantView {
  name: string;
  backends?: string[];
  models?: string[];
}

export interface AdminDeps {
  policy: RouterPolicy;
  // policy 热更新面（工单 policy-hot-reload）：状态现查 + 手动 reload 的执行器由 server.ts 提供
  // （daemon 是唯一验真者，本模块不 import/validate）。admin 读 policy 的 backends/models 属冷区
  // 字段（热换守卫拒绝变更），与 current() 等价。
  policyAdmin: { statusView(): Record<string, unknown>; manualReload(): Promise<unknown> };
  tenants: AdminTenantView[];
  snapshots: UsageSnapshots;
  audit: UsageAudit;
  events: SystemEventStore;
  capture: CaptureStore | null;
}

export function createAdminServer({ policy, policyAdmin, tenants, snapshots, audit, events, capture }: AdminDeps): Server {
  return http.createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return json(res, 400, { error: { message: 'invalid URL', type: 'invalid_request_error' } }); }
    // 写操作两处：快照手动刷新 + policy 热更新（工单 policy-hot-reload，文件拾取是另一处入口）。
    if (req.method === 'POST' && url.pathname === '/api/snapshots/refresh') {
      try { await snapshots.refresh(); } catch (error) {
        return json(res, 502, { error: { message: `snapshot refresh failed: ${messageOf(error)}`, type: 'server_error' } });
      }
      return json(res, 200, snapshots.peek());
    }
    // policy 手动 reload：同一套懒检查/冷区守卫，trigger=manual 进审计事件。
    if (req.method === 'POST' && url.pathname === '/api/policy/reload') {
      return json(res, 200, await policyAdmin.manualReload());
    }
    if (req.method !== 'GET') return json(res, 405, { error: { message: 'method not allowed', type: 'method_not_allowed_error' } });
    if (serveStatic(url, res)) return;
    // policy 现查：当前生效声明的 source/sha256/loadedAt 与最近一次失败现场。
    if (url.pathname === '/api/policy') return json(res, 200, policyAdmin.statusView());
    if (url.pathname === '/api/snapshots') return json(res, 200, snapshots.peek());
    if (url.pathname === '/api/version') {
      // 工单 07：只在看板/用户交互时现查（服务端缓存 1h）；无人访问时进程零网络请求。
      const latest = await npmLatestCached();
      return json(res, 200, { version: RUNTIME_VERSION, latest, checkedAt: latestCache?.at ?? null });
    }
    if (url.pathname === '/api/route/status') {
      const p = policy;
      const current = snapshots.peek();
      // 租户清单（看板下拉用）：声明了 tenants 列真实租户；未声明时只有隐式 default。
      const tenantViews = tenants.length ? tenants : [{ name: 'default' }];
      // 「当前优先」：如果现在来一个新会话，内置月欠账会挑谁。policy 自定义决定不在此列
      // （它每请求都可能不同），看板对钉死模型显示的优先序仅供参考。
      let preference: { name: string; score: number | null }[] | null = null;
      try {
        const modelMap = p.models[0]?.backends;
        preference = rankBackends({ backends: p.backends, snapshots: current.snapshots, model: modelMap })
          .map((candidate) => ({ name: candidate.name, score: monthlyDebtScore(current.snapshots[candidate.name]) }));
      } catch { preference = null; }
      return json(res, 200, { subscriptions: p.backends.map((candidate) => ({
        name: candidate.name, family: candidate.family, alias: candidate.alias ?? candidate.name,
        account: candidate.account ?? candidate.name,
        models: p.models.filter((model) => model.backends?.[candidate.family]).map((model) => model.id),
        snapshot: current.snapshots[candidate.name] ?? { known: false, degraded: true, stale: true },
      })), tenants: tenantViews, preference, mappings: events.mappingOverview(), snapshots: current });
    }
    if (url.pathname === '/api/audit/requests') {
      // page 参数在 → 分页响应（带 total，后台 v2）；不在 → 旧 limit 形态（兼容既有调用方）。
      if (url.searchParams.has('page')) {
        return json(res, 200, audit.listRequestsPaged({
          page: url.searchParams.get('page'), pageSize: url.searchParams.get('page_size'),
          sort: url.searchParams.get('sort'), order: url.searchParams.get('order'), days: url.searchParams.get('days'),
          identity: url.searchParams.get('identity') ?? undefined, tenant: url.searchParams.get('tenant') ?? undefined,
          model: url.searchParams.get('model') ?? undefined, status: url.searchParams.get('status'),
        }));
      }
      return json(res, 200, { requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity: url.searchParams.get('identity') ?? undefined, tenant: url.searchParams.get('tenant') ?? undefined }) });
    }
    if (url.pathname === '/api/audit/sessions') {
      // 同上：page 参数在 → 分页响应；不在 → 旧形态。
      if (url.searchParams.has('page')) {
        return json(res, 200, audit.listSessionsPaged({
          page: url.searchParams.get('page'), pageSize: url.searchParams.get('page_size'),
          sort: url.searchParams.get('sort'), order: url.searchParams.get('order'), days: url.searchParams.get('days'),
          tenant: url.searchParams.get('tenant') ?? undefined,
        }));
      }
      return json(res, 200, { sessions: audit.listSessions({ limit: url.searchParams.get('limit'), tenant: url.searchParams.get('tenant') ?? undefined }) });
    }
    // 订阅实际消耗聚合（后台 v2）：按订阅×北京时间日，与上游快照（还剩多少）互补。
    if (url.pathname === '/api/audit/usage') {
      return json(res, 200, audit.usageByDay({ days: url.searchParams.get('days'), tenant: url.searchParams.get('tenant') ?? undefined }));
    }
    // 系统事件流（后台 v2）：改绑/hold/泄漏命中等，观测页时间线用。kind 白名单外一律不过滤。
    if (url.pathname === '/api/events') {
      const kindParam = url.searchParams.get('kind') ?? undefined;
      return json(res, 200, { events: events.listEvents({
        kind: kindParam !== undefined && EVENT_KINDS.has(kindParam) ? kindParam as EventKind : undefined,
        tenant: url.searchParams.get('tenant') ?? undefined,
        limit: url.searchParams.get('limit'),
      }) });
    }
    if (url.pathname === '/api/audit/summary') {
      const identity = url.searchParams.get('identity');
      const tenant = url.searchParams.get('tenant') ?? undefined;
      const p = policy;
      // 汇总只看当前声明的订阅；已下线的（如历史 ocg-main/first/second）留在库里不上板
      return json(res, 200, identity === null
        ? { summary: audit.summary({ subscriptionNames: p.backends.map((candidate) => candidate.name), tenant }) }
        : { summary: audit.sessionSummary(identity, { tenant }), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity, tenant }) });
    }
    const detail = url.pathname.match(/^\/api\/audit\/sessions\/(.+)$/);
    if (detail) {
      let identity: string;
      let tenant: string;
      try { identity = decodeURIComponent(detail[1]); tenant = url.searchParams.get('tenant') ?? 'default'; }
      catch { return json(res, 400, { error: { message: 'invalid session URL', type: 'invalid_request_error' } }); }
      return json(res, 200, { session: audit.sessionSummary(identity, { tenant }), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity, tenant }) });
    }
    // 观测层读侧（observability 票 01）：捕获轮次清单 / 单轮还原正文 / 侧库状态。只读聚合，不加重热路径。
    if (url.pathname === '/api/capture/turns') {
      return json(res, 200, { turns: capture ? capture.listTurns({ limit: url.searchParams.get('limit'), tenant: url.searchParams.get('tenant') ?? undefined, identity: url.searchParams.get('identity') ?? undefined }) : [] });
    }
    const captureTurn = url.pathname.match(/^\/api\/capture\/turns\/(\d+)$/);
    if (captureTurn) {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const found = capture.turnBody(Number(captureTurn[1]));
      return found ? json(res, 200, found) : json(res, 404, { error: { message: 'capture turn not found (or content missing in degraded state)', type: 'not_found_error' } });
    }
    // 轨迹聚合（trajectory 页，.scratch/trajectory-gitgraph/tree-aggregation-api.md）：
    // tree = 后端建树（parent 指针/×N 归并/thread_key/新增段元数据/摘要），refs 哈希不出网；
    // tree-diffs = 新增段正文 keyset 翻页。两接口只读，旧 /turns/<id> 保留作单轮兜底。
    if (url.pathname === '/api/capture/tree') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const identity = url.searchParams.get('identity');
      if (!identity) return json(res, 400, { error: { message: 'identity query parameter is required (pick a session from /api/audit/sessions)', type: 'invalid_request_error' } });
      const tenant = url.searchParams.get('tenant') ?? undefined;
      const limitParam = Number(url.searchParams.get('limit') ?? 500);
      const tree = capture.buildTree(tenant, identity, Number.isFinite(limitParam) ? limitParam : undefined);
      const caps = tree.nodes.flatMap((n) => n.turns.map((t) => t.capture_id));
      const statuses = audit.statusByCaptureIds(caps);
      for (const node of tree.nodes) for (const t of node.turns) {
        const s = statuses.get(t.capture_id);
        t.status = s?.status ?? null; t.ms = s?.ms ?? null; t.ttft_ms = s?.ttft_ms ?? null;
      }
      let summary: Record<string, unknown> | null = null;
      try { // 效率摘要复用 cache-efficiency 口径（core 已有实现，前端不再自己算）
        const usage = audit.usageByCaptureIds(caps);
        const windowTurns = capture.turnRefsWindow(tenant, identity, Number.isFinite(limitParam) ? limitParam : undefined);
        const eff = capture.cacheEfficiency(windowTurns, usage, DEFAULT_RATES);
        summary = {
          turns: windowTurns.length,
          threads: Object.keys(tree.thread_labels).length,
          efficiency: eff.totals?.efficiency ?? null,
          waste_share: eff.totals?.waste_share ?? null,
          read_multiplier: eff.totals?.read_multiplier ?? null,
          corpus_tokens_est: eff.totals?.corpus_tokens_est ?? null,
          turns_skipped_no_usage: eff.totals?.turns_skipped_no_usage ?? null,
        };
      } catch { /* 效率条失败不挡轨迹（summary=null，前端退回基础行） */ }
      return json(res, 200, { ...tree, summary });
    }
    if (url.pathname === '/api/capture/tree-diffs') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const identity = url.searchParams.get('identity');
      if (!identity) return json(res, 400, { error: { message: 'identity query parameter is required (pick a session from /api/audit/sessions)', type: 'invalid_request_error' } });
      const num = (key: string) => { const v = Number(url.searchParams.get(key) ?? NaN); return Number.isFinite(v) ? v : undefined; };
      const limitTurns = num('limit_turns');
      if (limitTurns !== undefined && (limitTurns < 1 || limitTurns > 200)) {
        return json(res, 400, { error: { message: 'invalid limit_turns (expected 1..200)', type: 'invalid_request_error' } });
      }
      return json(res, 200, capture.treeDiffs(url.searchParams.get('tenant') ?? undefined, identity, {
        afterTs: num('after_ts'), afterId: num('after_id'),
        sinceTs: num('since_ts'), sinceId: num('since_id'), uptoTs: num('upto_ts'),
        limitTurns,
      }));
    }
    if (url.pathname === '/api/capture/status') {
      return json(res, 200, capture ? capture.status() : { enabled: false, turns: 0, contents: 0, bytes: 0, dropped: 0, degraded: false });
    }
    // 缓存取证（票 03）：需 identity（会话从 /api/audit/sessions 挑）。输出相邻轮对比链，
    // 并把时间窗口内的 route.rebind 事件并排进每一轮——归因措辞是「证据指向」，不下断言。
    // tenant 缺省 = 全租户（identity 由调用方指定，缺省写死 'default' 会查空）。
    if (url.pathname === '/api/capture/cache-forensics') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const identity = url.searchParams.get('identity');
      const tenant = url.searchParams.get('tenant') ?? undefined;
      if (!identity) return json(res, 400, { error: { message: 'identity query parameter is required (pick a session from /api/audit/sessions)', type: 'invalid_request_error' } });
      const limitParam = Number(url.searchParams.get('limit') ?? 100);
      const { chain, threads } = capture.cacheChain(tenant, identity, Number.isFinite(limitParam) ? limitParam : undefined);
      const rebinds = events.listEvents({ kind: 'route.rebind', tenant, limit: 500 })
        .map((event) => ({ ts: event.ts, backend: event.backend_name, detail: event.detail ? JSON.parse(event.detail) as Record<string, unknown> : {} }));
      return json(res, 200, {
        tenant: tenant ?? null, identity, chain, threads,
        rebinds,
        // 哈希结论与 chars 口径互校的说明随响应给出（observability 票 03 验收「不一致要能解释」）：
        // 断裂判定看**线程内**前缀（common_prefix_in_thread）；boundary='thread-switch' 是 deleg
        // 家族切孩子的交错边界（时间序上一轮是另一个孩子的轮次），不是前缀断裂。
        hint: '前缀断裂看 common_prefix_in_thread 骤降（证据指向改绑/改提示词/压缩，以同时间窗 rebind 与 first_diff_in_thread_role 定位）；boundary=thread-switch 只是切了孩子（deleg 家族共享会话身份）不算断裂；chars_delta 与哈希结论不一致时以哈希结论为准（chars 还受非消息字段影响）',
      });
    }
    // 缓存效率（family-observability 票 03）：理想消耗/实际消耗（口径见 core/observability/
    // cache-efficiency.ts 头注）。usage 三分量 + 原始 usage_json 按轮次锚点直查（audit.
    // usageByCaptureIds，不与「最新 N 行」窗口错位）。capture 未启用 404、缺 identity 400、
    // rates 越界 400（对齐 cache-forensics 的守卫口径；rates 经 ?fresh=/?write=/?read= 覆盖）。
    if (url.pathname === '/api/capture/cache-efficiency') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const identity = url.searchParams.get('identity');
      const tenant = url.searchParams.get('tenant') ?? undefined;
      if (!identity) return json(res, 400, { error: { message: 'identity query parameter is required (pick a session from /api/audit/sessions)', type: 'invalid_request_error' } });
      const limitParam = Number(url.searchParams.get('limit') ?? 100);
      const limit = Number.isFinite(limitParam) ? limitParam : undefined;
      const rates: Partial<EfficiencyRates> = {};
      for (const [name, hi] of [['fresh', 10], ['write', 10], ['read', 1]] as const) {
        const raw = url.searchParams.get(name);
        if (raw === null) continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > hi) {
          return json(res, 400, { error: { message: `invalid ${name} rate (expected 0..${hi})`, type: 'invalid_request_error' } });
        }
        rates[name] = value;
      }
      const turns = capture.turnRefsWindow(tenant, identity, limit);
      const usage = audit.usageByCaptureIds(turns.map((turn) => turn.capture_id));
      return json(res, 200, capture.cacheEfficiency(turns, usage, { ...DEFAULT_RATES, ...rates }));
    }
    // 工具/skill 分析（票 05）：读侧聚合，按需慢查询（默认 7 天 / 500 轮上限）。
    // tenant 缺省 = 全租户合计（与 /api/audit/* 口径一致；review 后修正——缺省写死 'default'
    // 会让多租户部署的看板永远空表）。
    if (url.pathname === '/api/capture/tools') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      return json(res, 200, capture.toolStats({
        tenant: url.searchParams.get('tenant') ?? undefined,
        identity: url.searchParams.get('identity') ?? undefined,
        days: Number(url.searchParams.get('days') ?? 7),
        maxTurns: Number(url.searchParams.get('max_turns') ?? 500),
      }));
    }
    // 泄漏取证定位（票 04）：privacy.hit 事件清单 + 借 item_hash/capture_id 回查捕获库，
    // 给出「哪一轮、哪个角色、第几条消息、该内容第一次出现在哪一轮」。原文不可得（从未落过）。
    if (url.pathname === '/api/capture/privacy') {
      if (!capture) return json(res, 404, { error: { message: 'capture is not enabled for any tenant', type: 'not_found_error' } });
      const tenant = url.searchParams.get('tenant') ?? undefined;
      const hits = events.listEvents({ kind: 'privacy.hit', tenant, limit: url.searchParams.get('limit') }).map((event) => {
        const detail = event.detail ? JSON.parse(event.detail) as Record<string, unknown> : {};
        const itemHash = typeof detail.item_hash === 'string' ? detail.item_hash : null;
        const turn = typeof detail.capture_id === 'string' ? capture!.turnByCaptureId(detail.capture_id) : null;
        const firstSeen = itemHash && turn ? capture!.turnsContaining(turn.tenant, itemHash, 1)[0] ?? null : null;
        return {
          id: event.id, ts: event.ts, tenant: event.tenant, identity_hash: event.identity_hash, rule: detail.rule ?? null,
          message_index: detail.message_index ?? null, role: detail.role ?? null,
          hit_turn: turn ? { capture_id: turn.capture_id, ts: turn.ts, identity: turn.identity, model: turn.model } : null,
          first_seen_turn: firstSeen ? { capture_id: firstSeen.capture_id, ts: firstSeen.ts, identity: firstSeen.identity, model: firstSeen.model } : null,
        };
      });
      return json(res, 200, { hits });
    }
    return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
  });
}
