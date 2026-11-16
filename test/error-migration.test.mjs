import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/server.mjs';
import { createIdentityStore } from '../lib/identity.mjs';

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = (server) => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(resolve);
});
const chat = (url, session = 'identity', body = { model: 'm' }) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-coding-plan-session': session }, body: JSON.stringify(body) });

async function setup(t, handlers) {
  const seen = [];
  const upstreams = handlers.map((handler) => http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accounts: [] }));
    seen.push(handler.name);
    handler.run(req, res);
  }));
  const urls = await Promise.all(upstreams.map(listen));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-migration-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), K0: 'key0', K1: 'key1' };
  const backends = urls.map((base_url, i) => ({ name: handlers[i].name, family: 'ocg', base_url, key_env: `K${i}`, priority: i }));
  const config = { master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ocg: 'native-m' } }], backends };
  const gateway = createGatewayServers(config, { env, logger: { warn() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await Promise.all(upstreams.map(close)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...gateway, url: `http://127.0.0.1:${gateway.forwardServer.address().port}`, seen, config, env, dir };
}

const ok = (name) => ({ name, run: (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ backend: name })) });
const quota = (name, status, headers = {}) => ({ name, run: (_req, res) => res.writeHead(status, headers).end(`quota-${status}`) });

test('429 retries only with short Retry-After, then migrates and persists the replacement pin', async (t) => {
  let attempts = 0;
  const app = await setup(t, [{ name: 'first', run: (_req, res) => { attempts++; res.writeHead(429, { 'retry-after': '0' }).end('limited'); } }, ok('second')]);
  const first = await chat(app.url);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { backend: 'second' });
  assert.equal(attempts, 4);
  assert.deepEqual(app.seen, ['first', 'first', 'first', 'first', 'second']);
  const reopenedStore = createIdentityStore(app.env.CPR_SESSIONS_DB);
  assert.equal(reopenedStore.get('session', 'identity'), 'second');
  reopenedStore.close();
});

test('403 migrates once; migration cooldown prevents another failover', async (t) => {
  const app = await setup(t, [quota('first', 403), quota('second', 403)]);
  assert.equal((await chat(app.url)).status, 403);
  assert.deepEqual(app.seen, ['first', 'second']);
  assert.equal((await chat(app.url)).status, 403);
  assert.deepEqual(app.seen, ['first', 'second', 'second']);
});

test('semantic 4xx is passed through without trying another backend', async (t) => {
  const app = await setup(t, [quota('first', 400), ok('second')]);
  const response = await chat(app.url);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'quota-400');
  assert.deepEqual(app.seen, ['first']);
});

test('Retry-After above two seconds migrates immediately without sleeping/retrying', async (t) => {
  const app = await setup(t, [quota('first', 429, { 'retry-after': '3' }), ok('second')]);
  const response = await chat(app.url);
  assert.equal(response.status, 200);
  assert.deepEqual(app.seen, ['first', 'second']);
});

test('stream failure after SSE starts is not migrated', async (t) => {
  const app = await setup(t, [{ name: 'first', run: (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hello\n\n'); setTimeout(() => res.destroy(), 10); } }, ok('second')]);
  const response = await chat(app.url, 'stream', { model: 'm', stream: true });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.deepEqual(app.seen, ['first']);
});

test('date-valued Retry-After is parsed as a bounded retry delay', async (t) => {
  const shortDate = new Date(Date.now() + 100).toUTCString();
  const app = await setup(t, [quota('first', 429, { 'retry-after': shortDate }), ok('second')]);
  const response = await chat(app.url, 'date');
  assert.equal(response.status, 200);
  assert.deepEqual(app.seen, ['first', 'first', 'first', 'first', 'second']);
});
