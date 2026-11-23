// 网关编排：鉴权/租户解析、建库迁移、正文捕获接线、转发请求的路由环。
// 管道细节在 ./forward.ts（流式透传/超时/透传），健康观察在 ./health.ts，打点在 ./perf.ts，
// 管理口 HTTP 面在 ./admin.ts——本文件只保留「每个请求发给谁」的决策流程与状态接线。
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { chatCompletions } from '../protocols/chat-completions.ts';
import { resolveIdentity } from '../store/identity.ts';
import { createSystemEventStore, type SystemEventStore, type RouteEventDetail } from '../store/events.ts';
import { openDatabase } from '../store/db.ts';
import { runMigrations } from '../store/migrate.ts';
import { CaptureStore } from '../store/capture.ts';
import { dataDir, defaultDbPath } from '../paths.ts';
import { UsageSnapshots } from '../store/snapshots.ts';
import { builtinDecide } from '../policy/builtin-decide.ts';
import { resolveListenEndpoints } from '../policy/config.ts';
import { decisionCtx, routeScope } from '../policy/ctx.ts';
import { createPolicyReloader, type ReloadTrigger } from '../policy/reload.ts';
import { UsageAudit } from '../store/audit.ts';
import { json, messageOf, statusOf } from './respond.ts';
import { forwardAttempt, passthroughError, retryAfterMs, sleep, type ForwardTimings, type QuotaResult } from './forward.ts';
import { createPerfSpan } from './perf.ts';
import { healthyBackend, createHealthTracker } from './health.ts';
import { createAdminServer, type AdminTenantView } from './admin.ts';
import type { AuditEntry, Backend, ChatBody, ChatUsage, Environment, Logger, Model, SnapshotView } from '../contracts.ts';
import type { Decision, DecisionCtx, RouterPolicy } from '../policy/contract.ts';

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

function authorized(req: IncomingMessage, key: string | undefined): boolean {
  return typeof key === 'string' && key.length > 0 && req.headers.authorization === `Bearer ${key}`;
}

export interface CreateGatewayOptions {
  env?: Environment;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  // policy 声明文件路径（~/.llm-cpr/policy.ts）：给出才启用热更新懒检查（工单 policy-hot-reload）。
  // 缺省 = builtin/测试直传实例：零行为（不 stat、不建备份目录、无 reload 事件）。
  policyFile?: string;
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

export function createGatewayServers(policy: RouterPolicy, { env = process.env, fetchImpl = fetch, logger = console, policyFile }: CreateGatewayOptions = {}): Gateway {
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
  // 配置即代码：快照轮询器随启动一次构建（backends 与 snapshot_interval_ms 属冷区——
  // 热换的冷区守卫拒绝这两项变更，见 policy/reload.ts 的 COLD_POLICY_FIELDS）。
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


  // policy 热加载器（工单 policy-hot-reload）：启动定型物（declaredTenants/snapshots/capture/dbPath）
  // 继续用构造时捕获；每请求路径读 reloader.current()——热区（decide/routing 参数/identity_header）
  // 换实例即生效，冷区（backends/models/tenants/capture/db_file/listen 等，清单见 COLD_POLICY_FIELDS）
  // 有变更整份拒绝并提示重启。policyFile 缺省（builtin/测试直传）时零行为。
  const reloader = createPolicyReloader({
    policy,
    policyFile,
    // 备份锚到数据目录（CPR_DATA_DIR 正主，与 docs 口径一致；review-1 P3-4——dbPath 可能被
    // CPR_DB_FILE 指到 data/ 子目录，按 dirname 推会漂）。
    backupDir: policyFile ? path.join(dataDir(env), 'backups', 'policy') : undefined,
  });
  // 重载的审计与日志：成功必落 policy.reload（trigger + 新旧 sha256）；失败落 policy.reload.error
  // 仅当内容是新的（reloader 的 deduped 标记防同一坏文件每请求刷账）。事件归 'default' 租户（非请求事件）。
  let lastReloadTrigger: ReloadTrigger | undefined; // 语义 = 最近一次「实际生效换新」的 trigger（review-1 P3-5）
  let reloadInflight: Promise<unknown> | null = null;
  const applyReload = async (trigger: ReloadTrigger) => {
    // 合流（review-1 P2-1）：重载进行中后到者只复用结果，不重复落事件/日志——一次重载一条账。
    if (reloadInflight) return reloadInflight;
    const run = reloader.maybeReload(trigger).then((outcome) => {
      const event = (kind: 'policy.reload' | 'policy.reload.error', detail: RouteEventDetail): void => {
        try { events.append({ kind, tenant: 'default', detail }); }
        catch (cause) { logger.warn?.(`[events] ${kind} append failed: ${messageOf(cause)}`); }
      };
      if (outcome.kind === 'reloaded') {
        lastReloadTrigger = trigger;
        logger.log?.(`[policy] reloaded ${policyFile}（sha256 ${outcome.toHash.slice(0, 12)}${outcome.fromHash ? ` ← ${outcome.fromHash.slice(0, 12)}` : ''}）${outcome.backupError ? `；声明快照备份失败：${outcome.backupError}` : ''}`);
        event('policy.reload', { trigger, ...(outcome.fromHash ? { from_hash: outcome.fromHash } : {}), to_hash: outcome.toHash });
      } else if (outcome.kind === 'kept' && !outcome.deduped) {
        // 同一坏文件/缺失态重复触发：上次已报过，不再刷（deduped 只跳事件，结果照常返回）。
        logger.warn?.(`[policy] reload kept old policy（${outcome.reason}）: ${outcome.error}`);
        event('policy.reload.error', {
          trigger, reason: outcome.reason, error: outcome.error,
          ...(outcome.coldChanged ? { cold_changed: outcome.coldChanged } : {}),
        });
      }
      return outcome;
    });
    reloadInflight = run.finally(() => { reloadInflight = null; });
    return reloadInflight;
  };
  // /api/policy 的现查视图（GET 端点与手动 reload 响应共用）。
  const policyStatusView = (): Record<string, unknown> => {
    const status = reloader.status();
    return {
      source: policyFile ?? 'core/policy/mine.ts',
      sha256: status.sha256, loadedAt: status.loadedAt,
      reloads: status.reloads, failedReloads: status.failedReloads,
      lastError: status.lastError, lastErrorAt: status.lastErrorAt,
      lastColdChanged: status.lastColdChanged,
      lastTrigger: lastReloadTrigger ?? null,
    };
  };

  const forwardServer = http.createServer(async (req, res) => {
    await applyReload('file-change'); // 懒检查：签名未变即刻返回（一次 stat），变了才走重载流程
    const p = reloader.current();
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
      const span = createPerfSpan(res);
      span.attach(logger);
      const bytes = await span.runAsync('read', () => readBody(req));
      if (res.destroyed) { span.suppress(); return; }
      let parsed: unknown;
      try { parsed = span.run('parse', () => JSON.parse(bytes.toString('utf8'))); } catch { span.suppress(); return json(res, 400, { error: { message: 'invalid JSON request body', type: 'invalid_request_error' } }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { span.suppress(); return json(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } }); }
      const body = parsed as ChatBody;
      const requestedModel = p.models.find((entry) => entry.id === body.model);
      if (!requestedModel) { span.suppress(); return json(res, 400, { error: { message: `model not allowed: ${String(body.model ?? '')}`, type: 'invalid_request_error' } }); }
      if (tenant.models && !tenant.models.includes(requestedModel.id)) { span.suppress(); return json(res, 400, { error: { message: `model not allowed for tenant ${tenant.name}: ${requestedModel.id}`, type: 'invalid_request_error' } }); }
      span.meta({ bytes: bytes.length, model: requestedModel.id, tenant: tenant.name });
      const identity = span.run('identity', () => resolveIdentity({ headers: req.headers, body, remoteAddress: req.socket.remoteAddress ?? 'unknown', identityHeader: identityHeaderOf(p) }));
      const pinnedName = span.run('identity', () => events.affinity(tenant.name, identity.kind, identity.key));
      let backend: Backend | undefined = pinnedName ? tenantBackends.find((candidate) => candidate.name === pinnedName) : undefined;
      const stalePin = Boolean(pinnedName && !backend);
      if (stalePin) logger.warn?.(`[routing] pinned backend "${pinnedName}" no longer available for tenant ${tenant.name}; re-selecting for identity ${identity.kind}`);
      const snaps = snapshots;
      if (!backend && snaps.peek().fetchedAt === null) {
        await span.runAsync('snapshot', () => snaps.refresh());
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
      // perf（spec .scratch/perf-instrumentation/spec.md）：route 段从候选过滤后起、到改绑事件落定止；
      // 探活走本地包装另计 probe 段（分析时 route−probe = 纯决策开销）。
      const probeHealthy = async (target: Backend): Promise<boolean> => {
        const t0 = performance.now();
        try { return await healthyBackend(target); } finally { span.add('probe', performance.now() - t0); }
      };
      const firstHealthy = async (pool: Backend[]): Promise<Backend | undefined> => {
        for (const candidate of pool) if (await probeHealthy(candidate)) return candidate;
        return undefined;
      };
      span.routeStart();
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
              if (!await probeHealthy(pick.backend)) {
                if (res.destroyed) return;
                return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
              }
              if (res.destroyed) return;
              backend = pick.backend;
              effectiveModel = pick.model;
              attempt = { source: 'policy', note: decision.reason };
            } else if (pick.backend.name !== backend.name) {
              // 有亲和时的逐请求覆写：目标不健康则保亲和并告警（不为坏目标作废可用会话）。
              if (await probeHealthy(pick.backend)) {
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
          const picked = await firstHealthy(built.orderedBackends ?? []);
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
      span.routeEnd();
      const startedAt = Date.now();
      // 正文捕获（observability 票 01）：仅租户 opt-in 且请求已走到转发路径时捕获客户端
      // 原始 body（转发前、路由决策后——未发出的请求不占存储）。锚点 captureId 随账本行落
      // capture_id 列，02-05 的关联查询靠它；侧库降级/队列满时 turn 可能缺行（不可宣称完整）。
      let captureId: string | null = null;
      if (capture && captureTenantNames.has(tenant.name)) {
        const outcome = span.run('capture', () => capture.capture({ tenant: tenant.name, identity: identity.key, identityKind: identity.kind, model: requestedModel.id, body: parsed, rawBytes: bytes.length }));
        captureId = outcome.captureId;
        if (outcome.skipped === 'oversize') logger.warn?.(`[capture] request body ${bytes.length} bytes exceeds capture.max_body_bytes; turn skipped`);
      }
      let quotaRetries = 0;
      let lastResult: QuotaResult | undefined;
      while (true) {
        span.countAttempt();
        // Narrowed per iteration: migration reassigns `backend` between attempts.
        const active: Backend = backend;
        const upstreamKey = env[active.key_env];
        if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${active.key_env}`, type: 'configuration_error' } });
        const translated = span.run('prepare', () => chatCompletions.prepareRequest({ config: { models: p.models, identityHeader: identityHeaderOf(p) }, model: effectiveModel, body, headers: req.headers, backend: active, upstreamKey, identity }));
        const translatedModel = translated.body.model;
        const bodyStr = span.run('prepare', () => JSON.stringify(translated.body));
        const record: (status: number, payload: string | ChatUsage | null, timings?: ForwardTimings) => void = (status, payload, timings) => {
          span.setForward(timings);
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
        const result = await forwardAttempt({ res, backend: active, body: bodyStr, headers: translated.headers, startedAt, onComplete: record, timeoutMs: upstreamTimeoutMs });
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
            if (pick && pick.backend.name !== active.name && await probeHealthy(pick.backend)) {
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
          const replacement = await firstHealthy(built.orderedBackends ?? []);
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
  const adminServer = createAdminServer({
    policy,
    // policy 热更新面（工单 policy-hot-reload）：管理口读状态 + 手动触发；冷区字段（backends 等）
    // 热换被守卫拒绝，admin 读 policy 的 backends/models 与 current() 等价。
    policyAdmin: { statusView: policyStatusView, manualReload: async () => ({ outcome: await applyReload('manual'), status: policyStatusView() }) },
    // 看板租户视图：内部 ResolvedTenant（keyEnv 不出鉴权作用域）收窄成展示形。
    tenants: declaredTenants.map((tenant) => ({ name: tenant.name, ...(tenant.backends ? { backends: tenant.backends } : {}), ...(tenant.models ? { models: tenant.models } : {}) })) satisfies AdminTenantView[],
    snapshots,
    audit,
    events,
    capture,
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

export async function startGateway(policy: RouterPolicy, { env = process.env, logger = console, policyFile }: CreateGatewayOptions = {}): Promise<Gateway> {
  // 配置即代码：声明在启动入口（main.ts）经 validateConfig 校验，坏声明拒绝启动。
  // policyFile（工单 policy-hot-reload）：声明文件路径下传，启用热更新懒检查。
  const gateway = createGatewayServers(policy, { env, logger, policyFile });
  const { forwardServer, adminServer } = gateway;
  const { listen, admin } = resolveListenEndpoints(policy, env);
  forwardServer.listen(listen.port, listen.host);
  adminServer.listen(admin.port, '127.0.0.1');
  await Promise.all([once(forwardServer, 'listening'), once(adminServer, 'listening')]);
  logger.log?.(`forward listening on http://${listen.host}:${(forwardServer.address() as AddressInfo).port}`);
  logger.log?.(`admin listening on http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`);
  return gateway;
}
