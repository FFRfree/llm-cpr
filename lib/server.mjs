import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { endToEndHeaders } from './headers.ts';
import { chatCompletions } from './protocols/chat-completions.ts';
import { createIdentityStore, resolveIdentity } from './identity.mjs';
import { UsageSnapshots } from './snapshots.mjs';
import { rankBackends, monthlyDebtScore } from './selection.mjs';
import { UsageAudit } from './audit.mjs';

function json(res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
  res.end(bytes);
}

function authorized(req, key) {
  return typeof key === 'string' && key.length > 0 && req.headers.authorization === `Bearer ${key}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function sleep(ms, res) {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve(false);
    const finish = (active) => { clearTimeout(timer); res.off('close', cancel); resolve(active); };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(!res.destroyed), ms);
    res.once('close', cancel);
  });
}

function forwardAttempt({ res, backend, body, headers, startedAt, onComplete, timeoutMs }) {
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
    let incoming;
    let timer;
    const cleanup = () => { clearTimeout(timer); res.off('close', cancel); };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      const status = error?.code === 'ECANCELED' ? 499 : error?.code === 'ETIMEDOUT' ? 504 : 502;
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
        // Quota bodies gate retries: a drip must not keep that decision pending.
        armTimeout(Math.min(timeoutMs, 5000));
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) return fail(new Error('upstream quota response too large'));
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (finished) return;
          finished = true; cleanup();
          resolve({ status, headers: response.headers, responseHeaders, body: Buffer.concat(chunks) });
        });
        return;
      }
      armTimeout();
      // pipe() pauses this readable when the client applies backpressure. While
      // paused we cannot observe upstream activity, so it is not an idle period.
      // Resume starts a fresh idle window; cancellation/abort still use fail().
      response.on('pause', () => clearTimeout(timer));
      response.on('resume', () => { if (!finished) armTimeout(); });
      let firstByteAt = null;
      const streaming = chatCompletions.isStreaming(response.headers);
      const collector = chatCompletions.usageCollector(streaming);
      response.on('data', (chunk) => {
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
        const timings = {
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

function passthroughError(res, result, onComplete) {
  res.writeHead(result.status, result.responseHeaders);
  res.end(result.body);
  try { onComplete?.(result.status, result.body.toString('utf8')); } catch {}
}

function healthyBackend(backend, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy) => {
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

async function firstHealthyBackend(backends) {
  for (const backend of backends) if (await healthyBackend(backend)) return backend;
  return undefined;
}

export function createGatewayServers(config, { env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const masterKeyEnv = config.masterKeyEnv || config.master_key_env || 'CPR_MASTER_KEY';
  const masterKey = env[masterKeyEnv];
  const dbPath = env.CPR_SESSIONS_DB || config.sessions_db || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sessions.db');
  const identityStore = createIdentityStore(dbPath);
  const auditPath = env.CPR_USAGE_DB || path.join(path.dirname(dbPath), 'usage.db');
  const audit = new UsageAudit({ dbFile: auditPath, logger });
  const longSessionMin = Number(config.routing?.long_session_min_requests ?? 10);
  const configuredTimeout = Number(config.routing?.upstream_timeout_ms);
  const upstreamTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(300_000, Math.max(1, configuredTimeout)) : 120_000;
  const snapshots = new UsageSnapshots({ backends: config.backends, env, intervalMs: config.routing?.snapshot_interval_ms ?? 300_000, fetchImpl, logger });
  const forwardServer = http.createServer(async (req, res) => {
    if (!authorized(req, masterKey)) return json(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: config.models.map(({ id }) => ({ id, object: 'model' })) });
    }
    if (!chatCompletions.matches(req.method, req.url)) return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
    try {
      const bytes = await readBody(req);
      if (res.destroyed) return;
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { return json(res, 400, { error: { message: 'invalid JSON request body', type: 'invalid_request_error' } }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
      const requestedModel = config.models.find((entry) => entry.id === body.model);
      if (!requestedModel) return json(res, 400, { error: { message: `model not allowed: ${body.model ?? ''}`, type: 'invalid_request_error' } });
      const identity = resolveIdentity({ headers: req.headers, body, remoteAddress: req.socket.remoteAddress, identityHeader: config.identityHeader });
      const pinnedName = identityStore.get(identity.kind, identity.key);
      let backend = pinnedName ? config.backends.find((candidate) => candidate.name === pinnedName) : undefined;
      const stalePin = Boolean(pinnedName && !backend);
      if (stalePin) logger.warn?.(`[routing] pinned backend "${pinnedName}" no longer configured; re-selecting for identity ${identity.kind}`);
      if (backend && !requestedModel.backends[backend.family]) return json(res, 400, { error: { message: `model ${requestedModel.id} is not available on ${backend.family}`, type: 'invalid_request_error' } });
      if (!backend) {
        if (snapshots.peek().fetchedAt === null) await snapshots.refresh();
        if (res.destroyed) return;
        const candidates = rankBackends({ backends: config.backends, snapshots: snapshots.peek().snapshots, model: requestedModel.backends });
        if (!candidates.length) return json(res, 429, { error: { message: 'all eligible subscriptions are window-limited', type: 'routing_error' } });
        backend = await firstHealthyBackend(candidates);
        if (res.destroyed) return;
        if (!backend) return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
        // 正常新身份走 pin（不可变）；旧钉死后端已下线时走 migrate（唯一合法的改映射通道）
        const name = stalePin ? identityStore.migrate(identity.kind, identity.key, backend.name) : identityStore.pin(identity.kind, identity.key, backend.name);
        backend = config.backends.find((candidate) => candidate.name === name);
      }
      const startedAt = Date.now();
      let quotaRetries = 0;
      let lastResult;
      while (true) {
        const upstreamKey = env[backend.key_env];
        if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${backend.key_env}`, type: 'configuration_error' } });
        const translated = chatCompletions.prepareRequest({ config, body, headers: req.headers, backend, upstreamKey, identity });
        const record = (status, responseText, timings) => audit.record({ ts: startedAt, identity: identity.key, identity_kind: identity.kind, subscription: backend.name,
          account: backend.account ?? backend.name, model: requestedModel.id, translated_model: translated.body.model,
          path: req.url, status, ms: Date.now() - startedAt, ttft_ms: timings?.ttftMs, stream_ms: timings?.streamMs }, typeof responseText === 'string' ? chatCompletions.responseUsage(responseText) : responseText);
        const result = await forwardAttempt({ res, backend, body: JSON.stringify(translated.body), headers: translated.headers, startedAt, onComplete: record, timeoutMs: upstreamTimeoutMs });
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
          // 长会话保缓存：请求轮数达到阈值的会话不做额度迁移——换后端会作废上游 prompt
          // cache，宁可让 agent 稍后重试原后端（阈值 routing.long_session_min_requests，
          // 默认 10，0 关闭此规则恢复永远迁移的旧行为）。
          const history = longSessionMin > 0 ? audit.sessionSummary(identity.key) : null;
          // Missing/degraded history is not evidence that this is a short session.
          const stickyLong = longSessionMin > 0 && (history?.degraded === true
            || !Number.isFinite(history?.requests) || history.requests >= longSessionMin);
          if (!stickyLong) {
            let alternates = [];
            try {
              alternates = rankBackends({ backends: config.backends.filter((candidate) => candidate.name !== backend.name),
                snapshots: snapshots.peek().snapshots, model: requestedModel.backends });
            } catch {}
            if (alternates.length) {
              const replacement = await firstHealthyBackend(alternates);
              if (res.destroyed) { record(499, null); return; }
              if (replacement) {
                backend = replacement;
                identityStore.migrate(identity.kind, identity.key, backend.name);
                quotaRetries = 0;
                continue;
              }
            }
          }
        }
        record(lastResult.status, lastResult.body.toString('utf8'));
        return passthroughError(res, lastResult);
      }
    } catch (error) {
      return json(res, error.statusCode || 400, { error: { message: error.message, type: error.statusCode === 429 ? 'routing_error' : 'invalid_request_error' } });
    }
  });
  const adminServer = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return json(res, 400, { error: { message: 'invalid URL', type: 'invalid_request_error' } }); }
    // 唯一的写操作：手动触发一轮额度快照刷新（轮询默认 5 分钟一次，看板按钮也走这里）
    if (req.method === 'POST' && url.pathname === '/api/snapshots/refresh') {
      try { await snapshots.refresh(); } catch (error) {
        return json(res, 502, { error: { message: `snapshot refresh failed: ${error.message}`, type: 'server_error' } });
      }
      return json(res, 200, snapshots.peek());
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
    if (url.pathname === '/api/snapshots') return json(res, 200, snapshots.peek());
    if (url.pathname === '/api/route/status') {
      const current = snapshots.peek();
      // 「当前优先」：如果现在来一个新会话，selectBackend 会挑谁。按与路由核同一套
      // 逻辑排出候选顺序（已钉死的旧会话不走这个，只有新会话才用它）。
      let preference = null;
      try {
        const modelMap = config.models[0]?.backends;
        preference = rankBackends({ backends: config.backends, snapshots: current.snapshots, model: modelMap })
          .map((backend) => ({ name: backend.name, score: monthlyDebtScore(current.snapshots[backend.name]) }));
      } catch { preference = null; }
      return json(res, 200, { subscriptions: config.backends.map((backend) => ({
        name: backend.name, family: backend.family, alias: backend.alias ?? backend.name,
        account: backend.account ?? backend.name,
        models: config.models.filter((model) => model.backends?.[backend.family]).map((model) => model.id),
        snapshot: current.snapshots[backend.name] ?? { known: false, degraded: true, stale: true },
      })), preference, mappings: identityStore.mappingOverview(), snapshots: current });
    }
    if (url.pathname === '/api/audit/requests') {
      return json(res, 200, { requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity: url.searchParams.get('identity') ?? undefined }) });
    }
    if (url.pathname === '/api/audit/sessions') return json(res, 200, { sessions: audit.listSessions({ limit: url.searchParams.get('limit') }) });
    if (url.pathname === '/api/audit/summary') {
      const identity = url.searchParams.get('identity');
      // 汇总只看当前配置的订阅；已下线的（如历史 ocg-main/first/second）留在库里不上板
      return json(res, 200, identity === null
        ? { summary: audit.summary({ subscriptionNames: config.backends.map((backend) => backend.name) }) }
        : { summary: audit.sessionSummary(identity), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity }) });
    }
    const detail = url.pathname.match(/^\/api\/audit\/sessions\/(.+)$/);
    if (detail) {
      let identity;
      try { identity = decodeURIComponent(detail[1]); }
      catch { return json(res, 400, { error: { message: 'invalid session URL', type: 'invalid_request_error' } }); }
      return json(res, 200, { session: audit.sessionSummary(identity), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity }) });
    }
    return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
  });
  snapshots.start();
  forwardServer.once('close', () => { identityStore.close(); audit.close(); snapshots.stop(); });
  return { forwardServer, adminServer, snapshots, audit };
}

export async function startGateway(config = undefined, { env = process.env, logger = console } = {}) {
  if (!config) {
    const { loadConfig } = await import('./config.mjs');
    config = loadConfig({ env });
  }
  const { forwardServer, adminServer } = createGatewayServers(config, { env });
  forwardServer.listen(config.listen.port, config.listen.host);
  adminServer.listen(config.admin.port, '127.0.0.1');
  await Promise.all([once(forwardServer, 'listening'), once(adminServer, 'listening')]);
  logger.log(`forward listening on http://${config.listen.host}:${forwardServer.address().port}`);
  logger.log(`admin listening on http://127.0.0.1:${adminServer.address().port}`);
  return { forwardServer, adminServer };
}
