import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createIdentityStore, resolveIdentity } from './identity.mjs';
import { translateRequest } from './translate.mjs';
import { UsageSnapshots } from './snapshots.mjs';
import { selectBackend } from './selection.mjs';
import { UsageAudit } from './audit.mjs';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function forwardAttempt({ res, backend, body, headers, onComplete }) {
  return new Promise((resolve) => {
    const base = new URL(backend.base_url);
    while (base.pathname !== '/' && base.pathname.endsWith('/')) base.pathname = base.pathname.slice(0, -1);
    const apiPath = base.pathname === '/v1' || base.pathname.endsWith('/v1')
      ? '/chat/completions'
      : '/v1/chat/completions';
    base.pathname = `${base.pathname === '/' ? '' : base.pathname}${apiPath}`;
    const target = base;
    const transport = target.protocol === 'https:' ? https : http;
    const outgoingHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) outgoingHeaders[name] = value;
    }
    outgoingHeaders['content-type'] = 'application/json';
    outgoingHeaders['content-length'] = Buffer.byteLength(body);
    const upstream = transport.request(target, { method: 'POST', headers: outgoingHeaders }, (response) => {
      const status = response.statusCode || 502;
      const responseHeaders = {};
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value;
      if (status === 403 || status === 429) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status, headers: response.headers, responseHeaders, text: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      res.writeHead(status, responseHeaders);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { try { onComplete?.(status, Buffer.concat(chunks).toString('utf8')); } catch {} });
      response.on('aborted', () => res.destroy(new Error('upstream response aborted')));
      response.on('error', (error) => res.destroy(error));
      response.pipe(res);
      resolve({ status, forwarded: true });
    });
    upstream.on('error', (error) => {
      try { onComplete?.(502, ''); } catch {}
      if (!res.headersSent) json(res, 502, { error: { message: `upstream request failed: ${error.message}`, type: 'gateway_error' } });
      else res.destroy(error);
      resolve({ status: 502, forwarded: true });
    });
    upstream.end(body);
  });
}

function passthroughError(res, result, onComplete) {
  res.writeHead(result.status, result.responseHeaders);
  res.end(result.text);
  try { onComplete?.(result.status, result.text); } catch {}
}

function responseUsage(text) {
  try { const value = JSON.parse(text); if (value?.usage) return value.usage; } catch {}
  let usage = null;
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    try { const value = JSON.parse(data); if (value?.usage) usage = value.usage; } catch {}
  }
  return usage;
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
  const snapshots = new UsageSnapshots({ backends: config.backends, env, intervalMs: config.routing?.snapshot_interval_ms ?? 60_000, fetchImpl, logger });
  const forwardServer = http.createServer(async (req, res) => {
    if (!authorized(req, masterKey)) return json(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: config.models.map(({ id }) => ({ id, object: 'model' })) });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found', type: 'not_found_error' } });
    try {
      const bytes = await readBody(req);
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { return json(res, 400, { error: { message: 'invalid JSON request body', type: 'invalid_request_error' } }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } });
      const requestedModel = config.models.find((entry) => entry.id === body.model);
      if (!requestedModel) return json(res, 400, { error: { message: `model not allowed: ${body.model ?? ''}`, type: 'invalid_request_error' } });
      const identity = resolveIdentity({ headers: req.headers, body, remoteAddress: req.socket.remoteAddress, identityHeader: config.identityHeader });
      const pinnedName = identityStore.get(identity.kind, identity.key);
      let backend = pinnedName ? config.backends.find((candidate) => candidate.name === pinnedName) : undefined;
      if (pinnedName && !backend) return json(res, 503, { error: { message: `pinned backend is no longer configured: ${pinnedName}`, type: 'routing_error' } });
      if (backend && !requestedModel.backends[backend.family]) return json(res, 400, { error: { message: `model ${requestedModel.id} is not available on ${backend.family}`, type: 'invalid_request_error' } });
      if (!backend) {
        if (snapshots.peek().fetchedAt === null) await snapshots.refresh();
        const selected = selectBackend({ backends: config.backends, snapshots: snapshots.peek().snapshots, model: requestedModel.backends });
        const candidates = [selected];
        backend = await firstHealthyBackend(candidates);
        if (!backend) return json(res, 503, { error: { message: 'no healthy backend available', type: 'routing_error' } });
        backend = config.backends.find((candidate) => candidate.name === identityStore.pin(identity.kind, identity.key, backend.name));
      }
      const startedAt = Date.now();
      let quotaRetries = 0;
      let lastResult;
      while (true) {
        const upstreamKey = env[backend.key_env];
        if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${backend.key_env}`, type: 'configuration_error' } });
        const translated = translateRequest({ config, body, headers: req.headers, backend, upstreamKey });
        const record = (status, responseText) => audit.record({ ts: startedAt, identity: identity.key, identity_kind: identity.kind, subscription: backend.name,
          account: backend.account ?? backend.name, model: requestedModel.id, translated_model: translated.body.model,
          path: req.url, status, ms: Date.now() - startedAt }, responseUsage(responseText));
        const result = await forwardAttempt({ res, backend, body: JSON.stringify(translated.body), headers: translated.headers, onComplete: record });
        if (result.forwarded) return;
        lastResult = result;
        if (result.status === 429) {
          const delay = retryAfterMs(result.headers['retry-after']);
          if (delay !== null && delay <= 2000 && quotaRetries < 3) {
            quotaRetries++;
            await sleep(delay);
            continue;
          }
        }
        if ((result.status === 403 || result.status === 429) && !identityStore.coolingDown(identity.kind, identity.key)) {
          let alternate;
          try {
            alternate = selectBackend({ backends: config.backends.filter((candidate) => candidate.name !== backend.name),
              snapshots: snapshots.peek().snapshots, model: requestedModel.backends });
          } catch {}
          if (alternate) {
            const replacement = await firstHealthyBackend([alternate]);
            if (replacement) {
              backend = replacement;
              identityStore.migrate(identity.kind, identity.key, backend.name);
              quotaRetries = 0;
              continue;
            }
          }
        }
        record(lastResult.status, lastResult.text);
        return passthroughError(res, lastResult);
      }
    } catch (error) {
      return json(res, error.statusCode || 400, { error: { message: error.message, type: error.statusCode === 429 ? 'routing_error' : 'invalid_request_error' } });
    }
  });
  const adminServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
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
      return json(res, 200, { subscriptions: config.backends.map((backend) => ({
        name: backend.name, family: backend.family, account: backend.account ?? backend.name,
        models: config.models.filter((model) => model.backends?.[backend.family]).map((model) => model.id),
        snapshot: current.snapshots[backend.name] ?? { known: false, degraded: true, stale: true },
      })), mappings: identityStore.mappingOverview(), snapshots: current });
    }
    if (url.pathname === '/api/audit/requests') {
      return json(res, 200, { requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity: url.searchParams.get('identity') ?? undefined }) });
    }
    if (url.pathname === '/api/audit/sessions') return json(res, 200, { sessions: audit.listSessions({ limit: url.searchParams.get('limit') }) });
    if (url.pathname === '/api/audit/summary') {
      const identity = url.searchParams.get('identity');
      return json(res, 200, identity === null ? { summary: audit.summary() } : { summary: audit.sessionSummary(identity), requests: audit.listRequests({ limit: url.searchParams.get('limit'), identity }) });
    }
    const detail = url.pathname.match(/^\/api\/audit\/sessions\/(.+)$/);
    if (detail) {
      const identity = decodeURIComponent(detail[1]);
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
