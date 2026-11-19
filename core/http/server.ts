import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { endToEndHeaders } from './headers.ts';
import { chatCompletions } from '../protocols/chat-completions.ts';
import { resolveIdentity } from '../store/identity.ts';
import { createSystemEventStore, type SystemEventStore, type RouteEventDetail, type EventKind } from '../store/events.ts';
import { openDatabase } from '../store/db.ts';
import { runMigrations } from '../store/migrate.ts';
import { CaptureStore } from '../store/capture.ts';
import { defaultDbPath } from '../paths.ts';
import { UsageSnapshots } from '../store/snapshots.ts';
import { rankBackends, monthlyDebtScore } from '../policy/selection.ts';
import { builtinDecide } from '../policy/builtin-decide.ts';
import { resolveListenEndpoints } from '../policy/config.ts';
import { decisionCtx, routeScope } from '../policy/ctx.ts';
import { UsageAudit } from '../store/audit.ts';
import type { AuditEntry, Backend, ChatBody, ChatUsage, Environment, Headers, Logger, Model, SnapshotView } from '../contracts.ts';
import type { BackendRecent, Decision, DecisionCtx, RouterPolicy } from '../policy/contract.ts';

interface ForwardTimings {
  ttftMs: number | null;
  streamMs: number | null;
}
type CompleteHandler = (status: number, payload: string | ChatUsage | null, timings?: ForwardTimings) => void;

function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
  res.end(bytes);
}

function authorized(req: IncomingMessage, key: string | undefined): boolean {
  return typeof key === 'string' && key.length > 0 && req.headers.authorization === `Bearer ${key}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown, fallback: number): number {
  const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' && status ? status : fallback;
}

// ---- 后台 v2 静态分发（多页 Admin）：static/ 目录白名单扩展名，路径解析后必须仍落在
// static/ 内（防穿越）；HTML no-store、资产 60s。旧单页 dashboard.html 已废弃删除。
const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'static');
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
};
function serveStatic(url: URL, res: ServerResponse): boolean {
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
const EVENT_KINDS: ReadonlySet<string> = new Set(['route.bind', 'route.rebind', 'route.hold', 'policy.error', 'privacy.hit']);

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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function retryAfterMs(value: unknown, now = Date.now()): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function sleep(ms: number, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve(false);
    const finish = (active: boolean) => { clearTimeout(timer); res.off('close', cancel); resolve(active); };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(!res.destroyed), ms);
    res.once('close', cancel);
  });
}

interface ForwardedResult {
  status: number;
  forwarded: true;
}
interface QuotaResult {
  status: number;
  forwarded: false;
  headers: IncomingHttpHeaders;
  responseHeaders: Headers;
  body: Buffer;
}
type AttemptResult = ForwardedResult | QuotaResult;

interface ForwardOptions {
  res: ServerResponse;
  backend: Backend;
  body: string;
  headers: Headers;
  startedAt: number;
  onComplete?: CompleteHandler;
  timeoutMs: number;
}

function forwardAttempt({ res, backend, body, headers, startedAt, onComplete, timeoutMs }: ForwardOptions): Promise<AttemptResult> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      try { onComplete?.(499, null); } catch {}
      return resolve({ status: 499, forwarded: true });
    }
    const target = chatCompletions.target(backend.base_url);
    const transport = target.protocol === 'https:' ? https : http;
    const outgoingHeaders = endToEndHeaders(headers);
    outgoingHeaders['content-type'] = 'application/json';
    outgoingHeaders['content-length'] = Buffer.byteLength(body);
    let finished = false;
    let incoming: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(timer); res.off('close', cancel); };
    const fail = (error: Error & { code?: string }) => {
      if (finished) return;
      finished = true;
      cleanup();
      const status = error.code === 'ECANCELED' ? 499 : error.code === 'ETIMEDOUT' ? 504 : 502;
      try { onComplete?.(status, null); } catch {}
      incoming?.unpipe(res);
      incoming?.destroy();
      upstream.destroy(error);
      if (!res.destroyed) {
        if (!res.headersSent) json(res, status === 499 ? 502 : status, { error: { message: `upstream request failed: ${error.message}`, type: 'gateway_error' } });
        else res.destroy(error);
      }
      resolve({ status, forwarded: true });
    };
    // Header wait is absolute (includes connection establishment); successful
    // bodies use inactivity, not total lifetime, so active long SSE is untouched.
    const armTimeout = (ms = timeoutMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })), ms);
      timer.unref?.();
    };
    // A single terminal path owns audit and teardown. Response abort/error and the
    // request error can all fire for one failure; none may turn it into a false 499.
    const cancel = () => {
      if (res.writableEnded || res.writableFinished) return;
      fail(Object.assign(new Error('client cancelled'), { code: 'ECANCELED' }));
    };
    const upstream = transport.request(target, { method: 'POST', headers: outgoingHeaders }, (response) => {
      incoming = response;
      response.on('aborted', () => fail(new Error('upstream response aborted')));
      response.on('error', fail);
      const status = response.statusCode || 502;
      const responseHeaders = endToEndHeaders(response.headers);
      if (status === 403 || status === 429) {
        // Quota bodies gate retries: a drip must not cause an error while the body is still open.
        armTimeout(Math.min(timeoutMs, 5000));
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) return fail(new Error('upstream quota response too large'));
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (finished) return;
          finished = true; cleanup();
          resolve({ status, forwarded: false, headers: response.headers, responseHeaders, body: Buffer.concat(chunks) });
        });
        return;
      }
      armTimeout();
      // pipe() pauses this readable when the client applies backpressure. While
      // paused we cannot observe upstream activity, so it is not an idle period.
      // Resume starts a fresh idle window; cancellation/abort still use fail().
      response.on('pause', () => clearTimeout(timer));
      response.on('resume', () => { if (!finished) armTimeout(); });
      let firstByteAt: number | null = null;
      const streaming = chatCompletions.isStreaming(response.headers);
      const collector = chatCompletions.usageCollector(streaming);
      response.on('data', (chunk: Buffer) => {
        if (finished) return;
        armTimeout();
        // Until a body byte arrives, keep the option of a structured 502/504.
        if (firstByteAt === null) { firstByteAt = Date.now(); res.writeHead(status, responseHeaders); }
        collector.write(chunk);
      });
      response.on('end', () => {
        if (finished) return;
        finished = true; cleanup();
        if (!res.headersSent) res.writeHead(status, responseHeaders);
        const timings: ForwardTimings = {
          ttftMs: firstByteAt !== null ? firstByteAt - startedAt : null,
          streamMs: streaming && firstByteAt !== null ? Math.max(0, Date.now() - firstByteAt) : null,
        };
        try { onComplete?.(status, collector.end(), timings); } catch {}
      });
      response.pipe(res);
      resolve({ status, forwarded: true });
    });
    upstream.on('error', fail);
    res.once('close', cancel);
    armTimeout();
    upstream.end(body);
  });
}

function passthroughError(res: ServerResponse, result: QuotaResult, onComplete?: CompleteHandler): void {
  res.writeHead(result.status, result.responseHeaders);
  res.end(result.body);
  try { onComplete?.(result.status, result.body.toString('utf8')); } catch {}
}

function healthyBackend(backend: Backend, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };
    const target = new URL(backend.base_url);
    const socket = net.connect({ host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80) });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function firstHealthyBackend(backends: Backend[]): Promise<Backend | undefined> {
  for (const backend of backends) if (await healthyBackend(backend)) return backend;
  return undefined;
}

// 内存健康追踪：record() 记账路径顺手喂入，decide ctx 的 candidates[].recent 从这里取。
// 只在内存里（重启归 undefined = 窗口内没观察到失败 ≠ 健康，观察盲区语义同快照未知）；零查询成本。
const HEALTH_WINDOW_MS = 10 * 60_000;
const HEALTH_RING_CAP = 50;
function createHealthTracker() {
  const rings = new Map<string, { ts: number; status: number }[]>();
  return {
    note(name: string, status: number, now = Date.now()): void {
      // 499 = 客户端取消，与后端服务质量无关，不计入。
      if (status < 400 || status === 499) return;
      const ring = rings.get(name) ?? [];
      ring.push({ ts: now, status });
      if (ring.length > HEALTH_RING_CAP) ring.splice(0, ring.length - HEALTH_RING_CAP);
      rings.set(name, ring);
    },
    view(name: string, now = Date.now()): BackendRecent | undefined {
      const windowed = (rings.get(name) ?? []).filter((entry) => now - entry.ts < HEALTH_WINDOW_MS);
      if (!windowed.length) return undefined;
      const last = windowed[windowed.length - 1];
      return { fails: windowed.length, lastStatus: last.status, lastErrorAt: last.ts };
    },
  };
}

export interface CreateGatewayOptions {
  env?: Environment;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}
export interface Gateway {
  forwardServer: Server;
  adminServer: Server;
  snapshots: UsageSnapshots;
  audit: UsageAudit;
  // 路由事件账（system_events）：bind/rebind/hold/policy.error，测试与排障读这里。
  events: SystemEventStore;
  // 正文捕获侧库（observability 票 01）：无租户 opt-in 时为 null（capture.db 不落盘）。
  capture: CaptureStore | null;
}

export function createGatewayServers(policy: RouterPolicy, { env = process.env, fetchImpl = fetch, logger = console }: CreateGatewayOptions = {}): Gateway {
  const identityHeaderOf = (p: RouterPolicy): string => String(p.identity_header || p.identityHeader || 'x-session-id').trim().toLowerCase();
  const masterKeyOf = (p: RouterPolicy): string | undefined => env[p.masterKeyEnv || p.master_key_env || 'CPR_MASTER_KEY'];
  // 租户 = 一类调用方的身份键（ADR-0007）。声明了 tenants：Bearer 命中哪个租户的 key 就归属哪个租户，
  // master_key_env 不再参与鉴权（main 租户显式写 key_env 即可）；未声明：隐式 default 租户 + master key，v0.1.0 行为不变。
  interface ResolvedTenant { name: string; keyEnv?: string; backends?: string[]; models?: string[] }
  const DEFAULT_TENANT: ResolvedTenant = { name: 'default' };
  const declaredTenants: ResolvedTenant[] = (policy.tenants ?? []).map((tenant) => ({ name: tenant.name, keyEnv: tenant.key_env, backends: tenant.backends, models: tenant.models }));
  // 凭据冲突 fail fast：两个租户解析出同一个 key 值 → 归属歧义（authenticate 命中最先声明者，后声明者被静默遮蔽）。
  // 这不是可用性问题而是隔离失效（账本分不出人），拒绝启动；缺 env 的租户不在此列（自然 401，不拦启动）。
  {
    const byKey = new Map<string, string>();
    for (const tenant of declaredTenants) {
      const key = tenant.keyEnv !== undefined ? env[tenant.keyEnv] : undefined;
      if (typeof key !== 'string' || key.length === 0) continue;
      if (byKey.has(key)) throw new Error(`tenant credential conflict: ${byKey.get(key)} and ${tenant.name} resolve to the same key value (check ${tenant.keyEnv})`);
      byKey.set(key, tenant.name);
    }
  }
  const authenticate = (req: IncomingMessage): ResolvedTenant | null => {
    if (declaredTenants.length) {
      for (const tenant of declaredTenants) {
        const key = tenant.keyEnv !== undefined ? env[tenant.keyEnv] : undefined;
        if (typeof key === 'string' && key.length > 0 && req.headers.authorization === `Bearer ${key}`) return tenant;
      }
      return null;
    }
    return authorized(req, masterKeyOf(policy)) ? DEFAULT_TENANT : null;
  };
  const dbPath = env.CPR_DB_FILE || policy.db_file || env.CPR_SESSIONS_DB || policy.sessions_db
    || defaultDbPath(env);
  // v0.2.0：无显式路径时默认 ~/.llm-cpr/data.db（defaultDbPath 含 CPR_DATA_DIR 接缝）。
  // 旧兜底「代码目录上两层」已废——release/npm 目录整体替换，旧兜底会让新进程安静开一套空库。
  // SQLite 打开库不自建父目录：写库路径的父目录由这里负责建。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath, { baseline: false });
  // v0.2.0 迁移三件套（工单 04）：版本机在启动路径——只升不降、有存量先备份（备份先于基线 DDL）、失败 fail-fast 拒启动。
  const migration = runMigrations(db, { dbFile: dbPath });
  if (migration.status !== 'current') {
    logger.log?.(`schema: ${migration.status === 'fresh' ? '新库' : `v${migration.from}`} → v${migration.to}${migration.applied.length ? `（${migration.applied.join('、')}）` : ''}${migration.backupDir ? `；已备份 → ${migration.backupDir}` : ''}`);
  }
  const audit = new UsageAudit({ db, logger });
  // 路由事件账：bind/rebind/hold/policy.error，归属与冷却全是它的派生查询。
  const events = createSystemEventStore(db, logger);
  // decide ctx 的 candidates[].recent 数据源：record() 挂钩喂入。
  const health = createHealthTracker();
  // 配置即代码：policy 为进程内静态实例（无热重载），快照轮询器随启动一次构建。
  const snapshots = new UsageSnapshots({ backends: policy.backends, env, intervalMs: policy.routing?.snapshot_interval_ms ?? 300_000, fetchImpl, logger });

  // 观测层正文捕获（observability 票 01）：租户级 opt-in，默认关；无 opt-in 租户不建侧库
  // （capture.db 连文件都不落，对外用户零感知）。显式 opt-in 却打不开侧库 = 声明错误，fail fast 拒启动。
  const captureTenantNames = new Set((policy.tenants ?? []).filter((tenant) => tenant.capture === true).map((tenant) => tenant.name));
  let capture: CaptureStore | null = null;
  if (captureTenantNames.size > 0) {
    const capturePath = env.CPR_CAPTURE_DB_FILE || path.join(path.dirname(dbPath), 'capture.db');
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    // 泄漏取证白名单（票 04）：自带 key（master/租户/订阅）的真实值 + 用户前缀豁免。
    // 只进内存比对，绝不打日志、绝不落库。
    const allowValues: string[] = [...(policy.capture?.privacy?.extra_allow ?? [])];
    for (const envName of [policy.masterKeyEnv || policy.master_key_env, ...(policy.tenants ?? []).map((tenant) => tenant.key_env), ...policy.backends.map((backend) => backend.key_env)]) {
      const value = typeof envName === 'string' ? env[envName] : undefined;
      if (typeof value === 'string' && value.length > 0) allowValues.push(value);
    }
    capture = new CaptureStore({
      dbFile: capturePath,
      ttlDays: Number(policy.capture?.ttl_days ?? 14),
      maxBodyBytes: Number(policy.capture?.max_body_bytes ?? 5_000_000),
      logger,
      privacy: {
        allow: allowValues,
        onHit: (hit) => {
          try {
            events.append({ kind: 'privacy.hit', tenant: hit.tenant, identity: { kind: hit.identityKind as 'session' | 'fingerprint' | 'address', key: hit.identity ?? 'unknown' }, detail: { rule: hit.rule, item_hash: hit.itemHash, capture_id: hit.captureId, message_index: hit.messageIndex, role: hit.role } });
          } catch (error) {
            logger.warn?.(`[capture] privacy.hit append failed: ${messageOf(error)}`);
          }
        },
      },
    });
    logger.log?.(`capture: on for tenants ${[...captureTenantNames].join(', ')} → ${capturePath}（TTL ${Number(policy.capture?.ttl_days ?? 14)} 天，正文不进 data.db）`);
    logger.log?.(`capture: leak scan on（allow 清单 ${allowValues.length} 项，含用户豁免 ${(policy.capture?.privacy?.extra_allow ?? []).length} 项）`);
  }

  const forwardServer = http.createServer(async (req, res) => {
    const p = policy;
    const tenant = authenticate(req);
    if (!tenant) return json(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
    // 租户后端池：租户带 backends 子集时收缩；亲和目标落到池外按 stale-pin 处理（与「订阅下线」同语义）。
    const tenantBackends: Backend[] = tenant.backends ? p.backends.filter((candidate) => tenant.backends!.includes(candidate.name)) : p.backends;
    if (req.method === 'GET' && req.url === '/v1/models') {
      const listed = tenant.models ? p.models.filter((entry) => tenant.models!.includes(entry.id)) : p.models;
      return json(res, 200, { object: 'list', data: listed.map(({ id }) => ({ id, object: 'model' })) });
    }
    if (!chatCompletions.matches(req.method, req.url)) return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
    try {
      const bytes = await readBody(req);
      if (res.destroyed) return;
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return json(res, 400, { error: { message: 'invalid JSON request body', type: 'invalid_request_error' } }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
      const body = parsed as ChatBody;
      const requestedModel = p.models.find((entry) => entry.id === body.model);
      if (!requestedModel) return json(res, 400, { error: { message: `model not allowed: ${String(body.model ?? '')}`, type: 'invalid_request_error' } });
      if (tenant.models && !tenant.models.includes(requestedModel.id)) return json(res, 400, { error: { message: `model not allowed for tenant ${tenant.name}: ${requestedModel.id}`, type: 'invalid_request_error' } });
      const identity = resolveIdentity({ headers: req.headers, body, remoteAddress: req.socket.remoteAddress ?? 'unknown', identityHeader: identityHeaderOf(p) });
      const pinnedName = events.affinity(tenant.name, identity.kind, identity.key);
      let backend: Backend | undefined = pinnedName ? tenantBackends.find((candidate) => candidate.name === pinnedName) : undefined;
      const stalePin = Boolean(pinnedName && !backend);
      if (stalePin) logger.warn?.(`[routing] pinned backend "${pinnedName}" no longer available for tenant ${tenant.name}; re-selecting for identity ${identity.kind}`);
      const snaps = snapshots;
      if (!backend && snaps.peek().fetchedAt === null) {
        await snaps.refresh();
        if (res.destroyed) return;
      }
      const longSessionMin = Number(p.routing?.long_session_min_requests ?? 10);
      // 数值参数兜底：validateConfig 校验声明，直传实例的测试不经它——非法值回落默认，不让 NaN 破坏比较。
      const nonNeg = (value: number | undefined, fallback: number): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; };
      const rebindCooldownMs = nonNeg(p.routing?.rebind_cooldown_ms ?? p.routing?.migration_cooldown_ms, 3_600_000);
      const wallRetryMaxAttempts = nonNeg(p.routing?.wall_retry_max_attempts, 3);
      const wallRetryMaxAfterMs = nonNeg(p.routing?.wall_retry_max_after_ms, 2000);
      const configuredTimeout = Number(p.routing?.upstream_timeout_ms);
      const upstreamTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(300_000, Math.max(1, configuredTimeout)) : 120_000;
      const current = snaps.peek();
      // 候选过滤同源（policy/ctx.ts routeScope）：租户池 + 模型支持，一处定义两处消费（server + 回放）。
      const candidates: Backend[] = routeScope(tenantBackends, undefined, requestedModel);
      if (!candidates.length) return json(res, 400, { error: { message: 'model is not available on configured backends', type: 'invalid_request_error' } });
      const requestView = { model: requestedModel.id, chars: bytes.length, messages: Array.isArray(body.messages) ? body.messages.length : 0 };
      // 决策点 ctx 同源构造（observability 票 02 抽取；回放沙盘 2026-11-19 经用户拍板移除，
      // 同源构造器保留）：正常路由与改绑决策共用这一个工厂，别在别处手搓第二份。
      const buildCtx = (view: SnapshotView, now: number, affinity: string | undefined, error?: { backend: string; status: number; retryAfterMs: number | null }): DecisionCtx =>
        decisionCtx({ now, tenant: tenant.name, model: requestView.model, chars: requestView.chars, messages: requestView.messages, affinity, candidates, snapshots: view, health, error });
      // 硬护栏：policy 只能在支持该模型的候选里挑；返回野名字/缺映射的目标一律判非法、回落内置。
      const policyErrorEvent = (error: string): void => {
        try { events.append({ kind: 'policy.error', tenant: tenant.name, identity, detail: { error } }); }
        catch (cause) { logger.warn?.(`[events] policy.error append failed: ${messageOf(cause)}`); }
      };
      const askPolicy = (ctx: DecisionCtx): Decision => {
        if (typeof p.decide !== 'function') return null;
        try { return p.decide(ctx) ?? null; }
        catch (error) {
          logger.warn?.(`[policy] decide failed: ${messageOf(error)}; falling back to builtin`);
          policyErrorEvent(`decide threw: ${messageOf(error)}`);
          return null;
        }
      };
      const resolvePolicyPick = (decision: Decision, baseModel: Model): { backend: Backend; model: Model } | null => {
        if (!decision || decision === 'keep') return null;
        const target = tenantBackends.find((candidate) => candidate.name === decision.backend);
        if (!target || !candidates.some((candidate) => candidate.name === decision.backend)) return null;
        const model = decision.model === undefined ? baseModel : p.models.find((entry) => entry.id === decision.model);
        if (!model || !model.backends[target.family]) return null;
        return { backend: target, model };
      };
      let effectiveModel: Model = requestedModel;
      // attempt = 本次路由的决定来源与解释，写进路由事件 detail（source/note）；账本行不再记注记。
      // decided = policy 已给出可执行决定（含 keep），内置兜底不再介入。
      let attempt: { source: 'policy' | 'builtin'; note?: string } | null = null;
      let decided = false;
      const ctx: DecisionCtx = buildCtx(current, Date.now(), pinnedName);
      {
        const decision = askPolicy(ctx);
        if (decision === 'keep') {
          if (!backend || stalePin || !candidates.includes(backend)) {
            logger.warn?.('[policy] keep ignored: no usable affinity for this request; using builtin');
          } else {
            decided = true; // 归属不变：无事件、无注记，后端沿用钉死亲和
          }
        } else if (decision) {
          const pick = resolvePolicyPick(decision, requestedModel);
          if (pick) {
            decided = true;
            if (!backend || stalePin) {
              // 无亲和（或亲和已失效）时的 policy 首选：不健康即 503，不做备选回退（钉死语义）。
              if (!await healthyBackend(pick.backend)) {
                if (res.destroyed) return;
                return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
              }
              if (res.destroyed) return;
              backend = pick.backend;
              effectiveModel = pick.model;
              attempt = { source: 'policy', note: decision.reason };
            } else if (pick.backend.name !== backend.name) {
              // 有亲和时的逐请求覆写：目标不健康则保亲和并告警（不为坏目标作废可用会话）。
              if (await healthyBackend(pick.backend)) {
                backend = pick.backend;
                effectiveModel = pick.model;
                attempt = { source: 'policy', note: decision.reason };
              } else {
                decided = false;
                attempt = null;
                logger.warn?.(`[policy] override target ${pick.backend.name} unhealthy; keeping affinity on ${backend.name}`);
              }
            } else {
              // 同后端换模型：归属不变（无事件），模型变化看账本 model/translated_model 两列。
              effectiveModel = pick.model;
              attempt = { source: 'policy', note: decision.reason };
            }
          } else {
            logger.warn?.(`[policy] invalid decision ignored: ${JSON.stringify(decision)}; falling back to builtin`);
            policyErrorEvent(`invalid decision: ${JSON.stringify(decision)}`);
          }
        }
      }
      if (!decided) {
        // policy 未做有效决定：内置兜底（月欠账/尊重亲和/重选），行为 = config 时代原逻辑。
        let built;
        try {
          built = builtinDecide(ctx, { backends: tenantBackends, model: requestedModel, snapshots: current.snapshots, longSessionMin });
        } catch (error) {
          return json(res, statusOf(error, 500), { error: { message: messageOf(error), type: statusOf(error, 500) === 429 ? 'routing_error' : 'invalid_request_error' } });
        }
        if (built.decision === 'keep') {
          // builtin keep 仅在亲和合法时出现（ctx.session.affinity 有效且支持模型）。
          backend = tenantBackends.find((candidate) => candidate.name === pinnedName);
        } else if (built.decision) {
          const picked = await firstHealthyBackend(built.orderedBackends ?? []);
          if (res.destroyed) return;
          if (!picked) return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
          backend = picked;
          attempt = { source: 'builtin', note: built.note };
        }
      }
      if (!backend) return json(res, 500, { error: { message: 'routing produced no backend', type: 'configuration_error' } });
      // 归属变更落事件：bind = 新身份首绑，事务内复查防并发双绑（两个并发新请求都读到
      // undefined 时，后到者发现已有归属则放弃写事件——首绑归属=先落库者，等价旧 INSERT OR IGNORE）；
      // rebind = stale 重选或 policy 覆写。正常路径此时账本行尚未落（响应完成后才写），事件不带 request_id。
      if (pinnedName === undefined) {
        const bindDetail: RouteEventDetail = { trigger: 'new-session', source: attempt?.source ?? 'builtin', ...(attempt?.note ? { note: attempt.note } : {}) };
        const bindTarget = backend; // 闭包内保持收窄：事务回调里 TS 不会保留 let 的收窄
        audit.transaction(() => {
          if (events.affinity(tenant.name, identity.kind, identity.key) !== undefined) return false; // 并发请求已首绑，不覆盖
          events.append({ kind: 'route.bind', tenant: tenant.name, identity, backendName: bindTarget.name, detail: bindDetail });
          return true;
        });
      } else if (backend.name !== pinnedName) {
        try { events.append({ kind: 'route.rebind', tenant: tenant.name, identity, backendName: backend.name, detail: { trigger: stalePin ? 'stale-pin' : 'policy-override', source: attempt?.source ?? 'builtin', ...(attempt?.note ? { note: attempt.note } : {}) } }); }
        catch (error) { logger.warn?.(`[events] route.rebind append failed: ${messageOf(error)}`); }
      }
      const startedAt = Date.now();
      // 正文捕获（observability 票 01）：仅租户 opt-in 且请求已走到转发路径时捕获客户端
      // 原始 body（转发前、路由决策后——未发出的请求不占存储）。锚点 captureId 随账本行落
      // capture_id 列，02-05 的关联查询靠它；侧库降级/队列满时 turn 可能缺行（不可宣称完整）。
      let captureId: string | null = null;
      if (capture && captureTenantNames.has(tenant.name)) {
        const outcome = capture.capture({ tenant: tenant.name, identity: identity.key, identityKind: identity.kind, model: requestedModel.id, body: parsed, rawBytes: bytes.length });
        captureId = outcome.captureId;
        if (outcome.skipped === 'oversize') logger.warn?.(`[capture] request body ${bytes.length} bytes exceeds capture.max_body_bytes; turn skipped`);
      }
      let quotaRetries = 0;
      let lastResult: QuotaResult | undefined;
      while (true) {
        // Narrowed per iteration: migration reassigns `backend` between attempts.
        const active: Backend = backend;
        const upstreamKey = env[active.key_env];
        if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${active.key_env}`, type: 'configuration_error' } });
        const translated = chatCompletions.prepareRequest({ config: { models: p.models, identityHeader: identityHeaderOf(p) }, model: effectiveModel, body, headers: req.headers, backend: active, upstreamKey, identity });
        const translatedModel = translated.body.model;
        const record: (status: number, payload: string | ChatUsage | null, timings?: ForwardTimings) => void = (status, payload, timings) => {
          audit.record({
            ts: startedAt, tenant: tenant.name, identity: identity.key, identity_kind: identity.kind, subscription: active.name,
            account: active.account ?? active.name, model: requestedModel.id, translated_model: typeof translatedModel === 'string' ? translatedModel : null,
            path: req.url, status, ms: Date.now() - startedAt, ttft_ms: timings?.ttftMs, stream_ms: timings?.streamMs,
            capture_id: captureId,
          } satisfies AuditEntry, typeof payload === 'string' ? chatCompletions.responseUsage(payload) : payload);
          health.note(active.name, status);
        };
        // 错误路径的失败笔条目（无 usage/timings）：与路由事件同事务成对落地用。
        const failEntry = (status: number): AuditEntry => ({
          ts: startedAt, tenant: tenant.name, identity: identity.key, identity_kind: identity.kind, subscription: active.name,
          account: active.account ?? active.name, model: requestedModel.id, translated_model: typeof translatedModel === 'string' ? translatedModel : null,
          path: req.url, status, ms: Date.now() - startedAt, capture_id: captureId,
        });
        const result = await forwardAttempt({ res, backend: active, body: JSON.stringify(translated.body), headers: translated.headers, startedAt, onComplete: record, timeoutMs: upstreamTimeoutMs });
        if (result.forwarded) return;
        if (res.destroyed) { record(499, null); return; }
        lastResult = result;
        if (result.status === 429) {
          const delay = retryAfterMs(result.headers['retry-after']);
          // 原地短重试：引擎自治，policy 不可见、不落账本。参数化见 routing.wall_retry_*。
          if (delay !== null && delay <= wallRetryMaxAfterMs && quotaRetries < wallRetryMaxAttempts) {
            quotaRetries++;
            if (!await sleep(delay, res)) { record(499, null); return; }
            continue;
          }
        }
        if ((result.status === 403 || result.status === 429) && !events.coolingDown(tenant.name, identity.kind, identity.key, Date.now(), rebindCooldownMs)) {
          // 改绑决策点。护栏前置（policy 不可见、不可覆写）：冷却已在入口条件拦掉；
          // keep-affinity 长会话保亲和：轮数达阈值的会话不改绑——换后端作废上游 prompt cache，
          // 宁可让 agent 稍后重试原后端。账本读不出/降级也当长会话（宁保缓存的保守取舍）。
          const history = audit.sessionSummary(identity.key, { tenant: tenant.name });
          const stickyLong = longSessionMin > 0 && (history?.degraded === true
            || typeof history?.requests !== 'number' || history.requests >= longSessionMin);
          // 失败账本行与路由事件同事务成对落地：任一步失败即整体回滚并放弃改绑（返回 false）——
          // 路由状态与账本保持一致，degraded 账本下宁可透传错误也不做无账的改绑。
          // 健康观察独立于账本事务成败（旧行为 record() 恒喂 health.note）。
          const failWith = (event: { kind: 'route.rebind' | 'route.hold'; backendName?: string; detail: RouteEventDetail }): boolean => {
            const ok = audit.transaction(() => {
              const requestId = audit.insertRow(failEntry(lastResult!.status), chatCompletions.responseUsage(lastResult!.body.toString('utf8')));
              events.append({ kind: event.kind, tenant: tenant.name, identity, backendName: event.backendName, requestId, detail: event.detail });
              return requestId;
            }) !== null;
            health.note(active.name, lastResult!.status);
            return ok;
          };
          // 出错重试也是一次 decide：带 error 标记问 policy（刚失败的后端与状态码），null 交内置。
          const fresh = snaps.peek();
          const errorCtx: DecisionCtx = buildCtx(fresh, Date.now(), active.name, {
            backend: active.name, status: result.status, retryAfterMs: retryAfterMs(result.headers['retry-after']),
          });
          const rebindTo = (target: Backend, info: { source: 'policy' | 'builtin'; note?: string }): boolean => {
            const ok = failWith({ kind: 'route.rebind', backendName: target.name, detail: { trigger: 'quota-wall', source: info.source, ...(info.note ? { note: info.note } : {}) } });
            if (ok) { backend = target; quotaRetries = 0; }
            return ok;
          };
          const giveUp = (cause: NonNullable<RouteEventDetail['cause']>): void => {
            failWith({ kind: 'route.hold', detail: { cause, status: lastResult!.status } });
          };
          if (stickyLong) { giveUp('keep-affinity'); return passthroughError(res, lastResult!); }
          const decision = askPolicy(errorCtx);
          if (decision === 'keep' || (decision !== null && typeof decision === 'object' && decision.backend === active.name)) {
            giveUp('policy-keep');
            return passthroughError(res, lastResult!);
          }
          if (decision !== null && typeof decision === 'object') {
            const target = tenantBackends.find((candidate) => candidate.name === decision.backend);
            if (!target || !candidates.some((candidate) => candidate.name === decision.backend)) {
              // 非法决定（野名字/缺候选）与合法但探活失败的目标要区分：只对前者落 policy.error。
              policyErrorEvent(`invalid decision: ${JSON.stringify(decision)}`);
            }
            const pick = resolvePolicyPick(decision, requestedModel);
            if (pick && pick.backend.name !== active.name && await healthyBackend(pick.backend)) {
              if (rebindTo(pick.backend, { source: 'policy', note: decision.reason })) continue;
              return passthroughError(res, lastResult!); // 事务失败（degraded）：放弃改绑，保持原亲和透传
            }
            logger.warn?.('[policy] error-path decision unusable; falling back to builtin alternates');
          }
          // 内置兜底：备选月欠账排序 → 逐个探活（keep-affinity 已被护栏前置处理）。
          let built;
          try {
            built = builtinDecide(errorCtx, { backends: tenantBackends, model: requestedModel, snapshots: fresh.snapshots, longSessionMin, sessionUsage: { requests: history?.requests ?? null, degraded: history?.degraded === true } });
          } catch { built = { decision: 'keep' as const, hold: 'no-alternate' as const }; }
          if (built.decision === 'keep') {
            giveUp(built.hold ?? 'no-alternate');
            return passthroughError(res, lastResult!);
          }
          const replacement = await firstHealthyBackend(built.orderedBackends ?? []);
          if (res.destroyed) { record(499, null); return; }
          if (replacement) {
            if (rebindTo(replacement, { source: 'builtin', note: built.note })) continue;
            return passthroughError(res, lastResult!); // 事务失败（degraded）：放弃改绑，保持原亲和透传
          }
          giveUp('no-alternate');
          return passthroughError(res, lastResult!);
        }
        // 冷却短路（403/429 但冷却中）与一般错误：失败笔落账；冷却短路附 hold 事件，一般错误无事件。
        if (lastResult.status === 403 || lastResult.status === 429) {
          audit.transaction(() => {
            const requestId = audit.insertRow(failEntry(lastResult!.status), chatCompletions.responseUsage(lastResult!.body.toString('utf8')));
            events.append({ kind: 'route.hold', tenant: tenant.name, identity, requestId, detail: { cause: 'cooldown', status: lastResult!.status } });
            return requestId;
          });
          return passthroughError(res, lastResult);
        }
        record(lastResult.status, lastResult.body.toString('utf8'));
        return passthroughError(res, lastResult);
      }
    } catch (error) {
      return json(res, statusOf(error, 400), { error: { message: messageOf(error), type: statusOf(error, 400) === 429 ? 'routing_error' : 'invalid_request_error' } });
    }
  });
  const adminServer = http.createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return json(res, 400, { error: { message: 'invalid URL', type: 'invalid_request_error' } }); }
    // 唯一的写操作：手动触发一轮额度快照刷新（轮询默认 5 分钟一次，看板按钮也走这里）
    if (req.method === 'POST' && url.pathname === '/api/snapshots/refresh') {
      try { await snapshots.refresh(); } catch (error) {
        return json(res, 502, { error: { message: `snapshot refresh failed: ${messageOf(error)}`, type: 'server_error' } });
      }
      return json(res, 200, snapshots.peek());
    }
    if (req.method !== 'GET') return json(res, 405, { error: { message: 'method not allowed', type: 'method_not_allowed_error' } });
    if (serveStatic(url, res)) return;
    if (url.pathname === '/api/snapshots') return json(res, 200, snapshots.peek());
    if (url.pathname === '/api/version') {
      // 工单 07：只在看板/用户交互时现查（服务端缓存 1h）；无人访问时进程零网络请求。
      const latest = await npmLatestCached();
      return json(res, 200, { version: RUNTIME_VERSION, latest, checkedAt: latestCache?.at ?? null });
    }
    if (url.pathname === '/api/route/status') {
      const p = policy;
      const snaps = snapshots;
      const current = snaps.peek();
      // 租户清单（看板下拉用）：声明了 tenants 列真实租户；未声明时只有隐式 default。
      const tenantViews = declaredTenants.length
        ? declaredTenants.map((tenant) => ({ name: tenant.name, ...(tenant.backends ? { backends: tenant.backends } : {}), ...(tenant.models ? { models: tenant.models } : {}) }))
        : [{ name: 'default' }];
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
      const chain = capture.cacheChain(tenant, identity, Number.isFinite(limitParam) ? limitParam : undefined);
      const rebinds = events.listEvents({ kind: 'route.rebind', tenant, limit: 500 })
        .map((event) => ({ ts: event.ts, backend: event.backend_name, detail: event.detail ? JSON.parse(event.detail) as Record<string, unknown> : {} }));
      return json(res, 200, {
        tenant: tenant ?? null, identity, chain,
        rebinds,
        // 哈希结论与 chars 口径互校的说明随响应给出（票 03 验收「不一致要能解释」）：
        hint: 'common_prefix 骤降 ↔ 前缀断裂（证据指向改绑/改提示词/插消息，以同时间窗 rebind 与 first_diff_role 定位）；chars_delta 与 common_prefix 不一致时以哈希结论为准（chars 还受非消息字段影响）',
      });
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
  snapshots.start();
  forwardServer.once('close', () => { audit.close(); snapshots.stop(); capture?.close(); });
  return {
    forwardServer,
    adminServer,
    get snapshots() { return snapshots; },
    audit,
    get events() { return events; },
    capture,
  };
}

export async function startGateway(policy: RouterPolicy, { env = process.env, logger = console }: CreateGatewayOptions = {}): Promise<Gateway> {
  // 配置即代码：声明在启动入口（main.ts）经 validateConfig 校验，坏声明拒绝启动。
  const gateway = createGatewayServers(policy, { env, logger });
  const { forwardServer, adminServer } = gateway;
  const { listen, admin } = resolveListenEndpoints(policy, env);
  forwardServer.listen(listen.port, listen.host);
  adminServer.listen(admin.port, '127.0.0.1');
  await Promise.all([once(forwardServer, 'listening'), once(adminServer, 'listening')]);
  logger.log?.(`forward listening on http://${listen.host}:${(forwardServer.address() as AddressInfo).port}`);
  logger.log?.(`admin listening on http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`);
  return gateway;
}
