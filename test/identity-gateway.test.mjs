import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/server.mjs';

async function fakeBackend(name, seen) {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    if (req.method === 'POST') seen.push({ name, session: req.headers['x-coding-plan-session'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ backend: name }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function start(config, env) {
  const servers = createGatewayServers(config, { env });
  servers.forwardServer.listen(0, '127.0.0.1');
  servers.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(servers.forwardServer, 'listening'), once(servers.adminServer, 'listening')]);
  return { ...servers, url: `http://127.0.0.1:${servers.forwardServer.address().port}` };
}

const config = (backends) => ({
  master_key_env: 'CPR_MASTER',
  listen: { host: '127.0.0.1', port: 0 },
  models: [{ id: 'model', backends: { ocg: 'native' } }],
  backends,
});
const request = (url, body, headers = {}) => fetch(`${url}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('gateway pins session and conversation identities to a persisted backend', async (t) => {
  const seen = [];
  const first = await fakeBackend('first', seen);
  const second = await fakeBackend('second', seen);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-routing-'));
  const dbPath = path.join(dir, 'sessions.db');
  const env = { CPR_MASTER: 'master', CPR_UPSTREAM: 'upstream', CPR_SESSIONS_DB: dbPath };
  const backend = (name, url) => ({ name, family: 'ocg', base_url: url, key_env: 'CPR_UPSTREAM' });
  let gateway = await start(config([backend('second', second.url), backend('first', first.url)]), env);
  try {
    const convo = { model: 'model', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }] };
    for (let i = 0; i < 2; i++) {
      const response = await request(gateway.url, { model: 'model' }, { 'x-coding-plan-session': 'shared-session' });
      assert.equal((await response.json()).backend, 'second');
    }
    for (let i = 0; i < 2; i++) {
      const response = await request(gateway.url, convo);
      assert.equal((await response.json()).backend, 'second');
    }
    assert.equal(seen.length, 4);
    assert.ok(seen.every(({ name }) => name === 'second'));
  } finally {
    await closeServer(gateway.forwardServer); await closeServer(gateway.adminServer);
  }

  gateway = await start(config([backend('first', first.url), backend('second', second.url)]), env);
  try {
    const response = await request(gateway.url, { model: 'model' }, { 'x-coding-plan-session': 'shared-session' });
    assert.equal((await response.json()).backend, 'second');
    const fingerprintResponse = await request(gateway.url, { model: 'model', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }] });
    assert.equal((await fingerprintResponse.json()).backend, 'second');
    const differentConversation = await request(gateway.url, { model: 'model', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'a different prompt' }] });
    assert.equal((await differentConversation.json()).backend, 'first');
  } finally {
    await closeServer(gateway.forwardServer); await closeServer(gateway.adminServer);
    await closeServer(first.server); await closeServer(second.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
