import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { endToEndHeaders } from './headers.ts';
import { chatCompletions } from './protocols/chat-completions.ts';
import { createIdentityStore, resolveIdentity } from './identity.ts';
import { UsageSnapshots, currentSnapshot } from './snapshots.ts';
import { rankBackends, monthlyDebtScore } from './selection.ts';
import { builtinDecide } from './builtin-decide.ts';
import { PolicyStore, StaticPolicyStore, resolveListenEndpoints, type PolicySource } from './policy-loader.ts';
import { UsageAudit } from './audit.ts';
import type { AuditEntry, Backend, ChatBody, ChatUsage, Endpoint, Environment, Headers, Logger, Model, SnapshotView } from './contracts.ts';
import type { CandidateView, Decision, DecisionCtx, RouterPolicy } from './policy-contract.ts';

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
  // 生产路径由 startGateway 接上 PolicyStore（mtime 热重载）；不接则静态实例永不重载。
  attachPolicySource(source: PolicySource): void;
}

export function createGatewayServers(policy: RouterPolicy, { env = process.env, fetchImpl = fetch, logger = console }: CreateGatewayOptions = {}): Gateway {
  const identityHeaderOf = (p: RouterPolicy): string => String(p.identity_header || p.identityHeader || 'x-session-id').trim().toLowerCase();
  const masterKeyOf = (p: RouterPolicy): string | undefined => env[p.masterKeyEnv || p.master_key_env || 'CPR_MASTER_KEY'];
  const dbPath = env.CPR_SESSIONS_DB || policy.sessions_db || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sessions.db');
  const identityStore = createIdentityStore(dbPath);
  const auditPath = env.CPR_USAGE_DB || path.join(path.dirname(dbPath), 'usage.db');
  const audit = new UsageAudit({ dbFile: auditPath, logger });
  // 派生状态随 policy 实例走：实例身份变（热重载出新对象）即重建快照轮询器。
  // UsageSnapshots 持有的是 backends 数组引用，光换数组内容会漏——必须换实例。
  let source: PolicySource = new StaticPolicyStore(policy);
  let snapshots: UsageSnapshots = new UsageSnapshots({ backends: policy.backends, env, intervalMs: policy.routing?.snapshot_interval_ms ?? 300_000, fetchImpl, logger });
  let snapshotsPolicy: RouterPolicy = policy;
  const snapshotsFor = (p: RouterPolicy): UsageSnapshots => {
    if (snapshotsPolicy !== p) {
      snapshots.stop();
      snapshots = new UsageSnapshots({ backends: p.backends, env, intervalMs: p.routing?.snapshot_interval_ms ?? 300_000, fetchImpl, logger });
      snapshotsPolicy = p;
      snapshots.start();
    }
    return snapshots;
  };
  const policyTag = (): string => {
    const meta = source.meta();
    return meta.source === 'file' && meta.mtimeMs !== null ? `policy@${meta.mtimeMs}` : 'policy';
  };

  const forwardServer = http.createServer(async (req, res) => {
    let p: RouterPolicy;
    try { p = await source.current(); } catch (error) {
      return json(res, 500, { error: { message: `policy unavailable: ${messageOf(error)}`, type: 'server_error' } });
    }
    const masterKey = masterKeyOf(p);
    if (!authorized(req, masterKey)) return json(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: p.models.map(({ id }) => ({ id, object: 'model' })) });
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
      const identity = resolveIdentity({ headers: req.headers, body, remoteAddress: req.socket.remoteAddress ?? 'unknown', identityHeader: identityHeaderOf(p) });
      const pinnedName = identityStore.get(identity.kind, identity.key);
      let backend: Backend | undefined = pinnedName ? p.backends.find((candidate) => candidate.name === pinnedName) : undefined;
      const stalePin = Boolean(pinnedName && !backend);
      if (stalePin) logger.warn?.(`[routing] pinned backend "${pinnedName}" no longer configured; re-selecting for identity ${identity.kind}`);
      const snaps = snapshotsFor(p);
      if (!backend && snaps.peek().fetchedAt === null) {
        await snaps.refresh();
        if (res.destroyed) return;
      }
      const longSessionMin = Number(p.routing?.long_session_min_requests ?? 10);
      const configuredTimeout = Number(p.routing?.upstream_timeout_ms);
      const upstreamTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(300_000, Math.max(1, configuredTimeout)) : 120_000;
      const current = snaps.peek();
      const candidates: Backend[] = p.backends.filter((candidate) => requestedModel.backends[candidate.family]);
      if (!candidates.length) return json(res, 400, { error: { message: 'model is not available on configured backends', type: 'invalid_request_error' } });
      const candidateView = (view: SnapshotView, backend2: Backend): CandidateView => {
        const raw = view.snapshots[backend2.name];
        const snapshot = raw === undefined ? undefined : currentSnapshot(raw, Date.now());
        return {
          name: backend2.name, family: backend2.family, alias: backend2.alias, account: backend2.account ?? null,
          priority: Number(backend2.priority ?? 0),
          walled: Boolean(snapshot?.fiveHour?.exceeded) || Boolean(snapshot?.weekly?.exceeded),
          snapshot,
        };
      };
      const requestView = { model: requestedModel.id, chars: bytes.length, messages: Array.isArray(body.messages) ? body.messages.length : 0 };
      // 硬护栏：policy 只能在支持该模型的候选里挑；返回野名字/缺映射的目标一律判非法、回落内置。
      const askPolicy = (ctx: DecisionCtx): Decision => {
        if (typeof p.decide !== 'function') return null;
        try { return p.decide(ctx) ?? null; }
        catch (error) {
          logger.warn?.(`[policy] decide failed: ${messageOf(error)}; falling back to builtin`);
          return null;
        }
      };
      const resolvePolicyPick = (decision: Decision, baseModel: Model): { backend: Backend; model: Model } | null => {
        if (!decision || decision === 'keep') return null;
        const target = p.backends.find((candidate) => candidate.name === decision.backend);
        if (!target || !candidates.some((candidate) => candidate.name === decision.backend)) return null;
        const model = decision.model === undefined ? baseModel : p.models.find((entry) => entry.id === decision.model);
        if (!model || !model.backends[target.family]) return null;
        return { backend: target, model };
      };
      let effectiveModel: Model = requestedModel;
      let attemptNote: string | null = null;
      const ctx: DecisionCtx = {
        now: Date.now(),
        request: requestView,
        session: { pin: pinnedName, requests: null, degraded: false },
        candidates: candidates.map((candidate) => candidateView(current, candidate)),
      };
      {
        const decision = askPolicy(ctx);
        if (decision === 'keep') {
          if (!backend || stalePin || !candidates.includes(backend)) {
            logger.warn?.('[policy] keep ignored: no usable pin for this request; using builtin');
          } else {
            attemptNote = `${policyTag()}:keep`;
          }
        } else if (decision) {
          const pick = resolvePolicyPick(decision, requestedModel);
          if (pick) {
            if (!backend || stalePin) {
              // 无钉死（或钉死已失效）时的 policy 首选：不健康即 503，不做备选回退（钉死语义）。
              if (!await healthyBackend(pick.backend)) {
                if (res.destroyed) return;
                return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
              }
              if (res.destroyed) return;
              backend = pick.backend;
              effectiveModel = pick.model;
              attemptNote = `${policyTag()}:pick->${pick.backend.name}` + (pick.model !== requestedModel ? `;model->${pick.model.id}` : '');
            } else if (pick.backend.name !== backend.name) {
              // 有钉死时的逐请求覆写：目标不健康则保钉死并告警（不为坏目标作废可用会话）。
              if (await healthyBackend(pick.backend)) {
                backend = pick.backend;
                effectiveModel = pick.model;
                attemptNote = `${policyTag()}:override->${pick.backend.name}` + (pick.model !== requestedModel ? `;model->${pick.model.id}` : '');
              } else {
                logger.warn?.(`[policy] override target ${pick.backend.name} unhealthy; keeping pinned ${backend.name}`);
              }
            } else {
              effectiveModel = pick.model;
              attemptNote = `${policyTag()}:keep` + (pick.model !== requestedModel ? `;model->${pick.model.id}` : '');
            }
          } else {
            logger.warn?.(`[policy] invalid decision ignored: ${JSON.stringify(decision)}; falling back to builtin`);
          }
        }
      }
      if (attemptNote === null) {
        // policy 未做有效决定：内置兜底（月欠账/尊重钉死/重选），行为 = config 时代原逻辑。
        let built;
        try {
          built = builtinDecide(ctx, { backends: p.backends, model: requestedModel, snapshots: current.snapshots, longSessionMin });
        } catch (error) {
          return json(res, statusOf(error, 500), { error: { message: messageOf(error), type: statusOf(error, 500) === 429 ? 'routing_error' : 'invalid_request_error' } });
        }
        if (built.decision === 'keep') {
          // builtin keep 仅在钉死合法时出现（ctx.session.pin 有效且支持模型）。
          backend = p.backends.find((candidate) => candidate.name === pinnedName);
        } else if (built.decision) {
          const picked = await firstHealthyBackend(built.orderedBackends ?? []);
          if (res.destroyed) return;
          if (!picked) return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
          backend = picked;
          attemptNote = built.note;
        }
      }
      if (!backend) return json(res, 500, { error: { message: 'routing produced no backend', type: 'configuration_error' } });
      // 正常新身份走 pin（不可变）；钉死后端已下线/被 policy 覆写时走 migrate（唯一合法的改映射通道）
      if (pinnedName === undefined) {
        identityStore.pin(identity.kind, identity.key, backend.name);
      } else if (backend.name !== pinnedName) {
        identityStore.migrate(identity.kind, identity.key, backend.name);
      }
      const startedAt = Date.now();
      let quotaRetries = 0;
      let lastResult: QuotaResult | undefined;
      while (true) {
        // Narrowed per iteration: migration reassigns `backend` between attempts.
        const active: Backend = backend;
        const upstreamKey = env[active.key_env];
        if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${active.key_env}`, type: 'configuration_error' } });
        const translated = chatCompletions.prepareRequest({ config: { models: p.models, identityHeader: identityHeaderOf(p) }, model: effectiveModel, body, headers: req.headers, backend: active, upstreamKey, identity });
        const translatedModel = translated.body.model;
        const record: (status: number, payload: string | ChatUsage | null, timings?: ForwardTimings, noteOverride?: string | null) => void = (status, payload, timings, noteOverride) => audit.record({
          ts: startedAt, identity: identity.key, identity_kind: identity.kind, subscription: active.name,
          account: active.account ?? active.name, model: requestedModel.id, translated_model: typeof translatedModel === 'string' ? translatedModel : null,
          path: req.url, status, ms: Date.now() - startedAt, ttft_ms: timings?.ttftMs, stream_ms: timings?.streamMs,
          routing_note: noteOverride ?? attemptNote,
        } satisfies AuditEntry, typeof payload === 'string' ? chatCompletions.responseUsage(payload) : payload);
        const result = await forwardAttempt({ res, backend: active, body: JSON.stringify(translated.body), headers: translated.headers, startedAt, onComplete: record, timeoutMs: upstreamTimeoutMs });
        if (result.forwarded) return;
        if (res.destroyed) { record(499, null); return; }
        lastResult = result;
        if (result.status === 429) {
          const delay = retryAfterMs(result.headers['retry-after']);
          if (delay !== null && delay <= 2000 && quotaRetries < 3) {
            quotaRetries++;
            if (!await sleep(delay, res)) { record(499, null); return; }
            continue;
          }
        }
        if ((result.status === 403 || result.status === 429) && !identityStore.coolingDown(identity.kind, identity.key)) {
          // 出错重试也是一次 decide：带 error/active/session 轮数问 policy，null 交内置
          // （长会话保缓存阈值、备选排序与探活）。1h 冷却是防抖护栏，policy 不可越过。
          const history = audit.sessionSummary(identity.key);
          const fresh = snaps.peek();
          const errorCtx: DecisionCtx = {
            now: Date.now(),
            request: requestView,
            session: { pin: active.name, requests: history?.requests ?? null, degraded: history?.degraded === true },
            candidates: candidates.map((candidate) => candidateView(fresh, candidate)),
            active: active.name,
            error: { status: result.status, retryAfterMs: retryAfterMs(result.headers['retry-after']) },
          };
          const decision = askPolicy(errorCtx);
          const migrateTo = async (target: Backend, note: string): Promise<void> => {
            // 观测盲区修复：迁移成功前先把失败那笔记进账本（旧行为直接 continue 跳过）。
            record(lastResult!.status, lastResult!.body.toString('utf8'), undefined, `${attemptNote ?? ''}|${note}`);
            backend = target;
            identityStore.migrate(identity.kind, identity.key, target.name);
            quotaRetries = 0;
            attemptNote = note;
          };
          const giveUp = (note: string): void => {
            record(lastResult!.status, lastResult!.body.toString('utf8'), undefined, `${attemptNote ?? ''}|${note}`);
          };
          if (decision === 'keep' || (decision !== null && typeof decision === 'object' && decision.backend === active.name)) {
            giveUp(`${policyTag()}:keep`);
            return passthroughError(res, lastResult!);
          }
          if (decision !== null && typeof decision === 'object') {
            const pick = resolvePolicyPick(decision, requestedModel);
            if (pick && pick.backend.name !== active.name && await healthyBackend(pick.backend)) {
              await migrateTo(pick.backend, `${policyTag()}:migrate->${pick.backend.name}`);
              continue;
            }
            logger.warn?.('[policy] error-path decision unusable; falling back to builtin alternates');
          }
          // 内置兜底：长会话阈值 → 备选月欠账排序 → 逐个探活。
          let built;
          try {
            built = builtinDecide(errorCtx, { backends: p.backends, model: requestedModel, snapshots: fresh.snapshots, longSessionMin });
          } catch { built = { decision: 'keep' as const, note: 'builtin:error' }; }
          if (built.decision === 'keep') {
            giveUp(built.note ?? 'builtin:keep');
            return passthroughError(res, lastResult!);
          }
          const replacement = await firstHealthyBackend(built.orderedBackends ?? []);
          if (res.destroyed) { record(499, null); return; }
          if (replacement) {
            await migrateTo(replacement, built.note ?? `builtin:migrate->${replacement.name}`);
            continue;
          }
          giveUp(`${built.note ?? 'builtin:alternates'}|no-healthy-alternate`);
          return passthroughError(res, lastResult!);
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
      let p: RouterPolicy;
      try { p = await source.current(); } catch (error) {
        return json(res, 500, { error: { message: `policy unavailable: ${messageOf(error)}`, type: 'server_error' } });
      }
      try { await snapshotsFor(p).refresh(); } catch (error) {
        return json(res, 502, { error: { message: `snapshot refresh failed: ${messageOf(error)}`, type: 'server_error' } });
      }
      return json(res, 200, snapshotsFor(p).peek());
    }
    if (req.method !== 'GET') return json(res, 405, { error: { message: 'method not allowed', type: 'method_not_allowed_error' } });
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'dashboard.html');
      try {
        const bytes = fs.readFileSync(filename);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
        return res.end(bytes);
      } catch { return json(res, 500, { error: { message: 'dashboard unavailable', type: 'server_error' } }); }
    }
    if (url.pathname === '/api/policy') {
      // 只读：当前 policy 文件、版本（mtime）、加载时间与最后错误（重载失败保旧的证词）。
      return json(res, 200, source.meta());
    }
    if (url.pathname === '/api/snapshots') {
      let p: RouterPolicy;
      try { p = await source.current(); } catch { return json(res, 200, snapshotsFor(policy).peek()); }
      return json(res, 200, snapshotsFor(p).peek());
    }
    if (url.pathname === '/api/route/status') {
      let p: RouterPolicy;
      try { p = await source.current(); } catch (error) {
        return json(res, 500, { error: { message: `policy unavailable: ${messageOf(error)}`, type: 'server_error' } });
      }
      const snaps = snapshotsFor(p);
      const current = snaps.peek();
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
      })), preference, mappings: identityStore.mappingOverview(), snapshots: current });
    }
    if (url.pathname === '/api/audit/requests') {
      return json(res, 200, { requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity: url.searchParams.get('identity') ?? undefined }) });
    }
    if (url.pathname === '/api/audit/sessions') return json(res, 200, { sessions: audit.listSessions({ limit: url.searchParams.get('limit') }) });
    if (url.pathname === '/api/audit/summary') {
      const identity = url.searchParams.get('identity');
      let p: RouterPolicy;
      try { p = await source.current(); } catch (error) {
        return json(res, 500, { error: { message: `policy unavailable: ${messageOf(error)}`, type: 'server_error' } });
      }
      // 汇总只看当前声明的订阅；已下线的（如历史 ocg-main/first/second）留在库里不上板
      return json(res, 200, identity === null
        ? { summary: audit.summary({ subscriptionNames: p.backends.map((candidate) => candidate.name) }) }
        : { summary: audit.sessionSummary(identity), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity }) });
    }
    const detail = url.pathname.match(/^\/api\/audit\/sessions\/(.+)$/);
    if (detail) {
      let identity: string;
      try { identity = decodeURIComponent(detail[1]); }
      catch { return json(res, 400, { error: { message: 'invalid session URL', type: 'invalid_request_error' } }); }
      return json(res, 200, { session: audit.sessionSummary(identity), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity }) });
    }
    return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
  });
  snapshots.start();
  forwardServer.once('close', () => { identityStore.close(); audit.close(); snapshots.stop(); });
  return {
    forwardServer,
    adminServer,
    get snapshots() { return snapshots; },
    audit,
    attachPolicySource(next: PolicySource) { source = next; },
  };
}

export async function startGateway(policy: RouterPolicy | PolicySource | undefined = undefined, { env = process.env, logger = console }: CreateGatewayOptions = {}): Promise<Gateway> {
  // 生产路径：PolicyStore 首次加载失败在这里抛错 → main.ts 置退出码，进程拒绝启动（Q2）。
  const source: PolicySource = policy !== undefined && typeof (policy as PolicySource).current === 'function' && typeof (policy as PolicySource).meta === 'function'
    ? policy as PolicySource
    : policy !== undefined ? new StaticPolicyStore(policy as RouterPolicy) : new PolicyStore({ logger });
  const initial = await source.current();
  const gateway = createGatewayServers(initial, { env, logger });
  gateway.attachPolicySource(source);
  const { forwardServer, adminServer } = gateway;
  const { listen, admin } = resolveListenEndpoints(initial, env);
  forwardServer.listen(listen.port, listen.host);
  adminServer.listen(admin.port, '127.0.0.1');
  await Promise.all([once(forwardServer, 'listening'), once(adminServer, 'listening')]);
  logger.log?.(`forward listening on http://${listen.host}:${(forwardServer.address() as AddressInfo).port}`);
  logger.log?.(`admin listening on http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`);
  return gateway;
}
