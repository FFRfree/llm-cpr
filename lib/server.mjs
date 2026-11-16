import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { translateRequest } from './translate.mjs';

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

function proxy({ req, res, backend, body, headers }) {
  const target = new URL(`${backend.base_url.replace(/\/+$/, '')}/v1/chat/completions`);
  const transport = target.protocol === 'https:' ? https : http;
  const outgoingHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) outgoingHeaders[name] = value;
  }
  outgoingHeaders['content-type'] = 'application/json';
  outgoingHeaders['content-length'] = Buffer.byteLength(body);
  const upstream = transport.request(target, { method: 'POST', headers: outgoingHeaders }, (response) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value;
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) json(res, 502, { error: { message: `upstream request failed: ${error.message}`, type: 'gateway_error' } });
    else res.destroy(error);
  });
  upstream.end(body);
}

export function createGatewayServers(config, { env = process.env } = {}) {
  const masterKeyEnv = config.masterKeyEnv || config.master_key_env || 'CPR_MASTER_KEY';
  const masterKey = env[masterKeyEnv];
  const backend = config.backends[0];
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
      const upstreamKey = env[backend.key_env];
      if (!upstreamKey) return json(res, 500, { error: { message: `missing credential environment variable: ${backend.key_env}`, type: 'configuration_error' } });
      const translated = translateRequest({ config, body, headers: req.headers, backend, upstreamKey });
      const serialized = JSON.stringify(translated.body);
      return proxy({ req, res, backend, body: serialized, headers: translated.headers });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: { message: error.message, type: 'invalid_request_error' } });
    }
  });
  const adminServer = http.createServer((_req, res) => json(res, 404, { error: { message: 'not found', type: 'not_found_error' } }));
  return { forwardServer, adminServer };
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
