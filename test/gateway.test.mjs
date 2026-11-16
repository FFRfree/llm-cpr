import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../lib/config.mjs';
import { translateRequest } from '../lib/translate.mjs';
import { createGatewayServers } from '../lib/server.mjs';

const baseConfig = (baseUrl, family = 'ocg') => ({
  master_key_env: 'CPR_TEST_MASTER',
  listen: { host: '127.0.0.1', port: 8741 },
  models: [{ id: 'unified-model', backends: { [family]: 'native-model' } }],
  backends: [{ name: 'first', family, base_url: baseUrl, key_env: 'CPR_TEST_UPSTREAM' }],
});

test('configuration loads backends, model whitelist and environment port overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-config-'));
  const filename = path.join(dir, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(baseConfig('http://127.0.0.1:9')));
  try {
    const config = loadConfig({ env: { CPR_CONFIG_FILE: filename, CPR_FORWARD_PORT: '0', CPR_ADMIN_PORT: '0', CPR_TEST_MASTER: 'master' } });
    assert.equal(config.backends[0].family, 'ocg');
    assert.equal(config.models[0].id, 'unified-model');
    assert.equal(config.listen.port, 0);
    assert.equal(config.admin.port, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('translation replaces model and auth while preserving OCG session header', () => {
  const config = baseConfig('http://upstream', 'ocg');
  const result = translateRequest({ config, body: { model: 'unified-model' }, headers: { authorization: 'Bearer master', 'x-opencode-session': 'session' }, backend: config.backends[0], upstreamKey: 'upstream-key' });
  assert.deepEqual(result.body, { model: 'native-model' });
  assert.equal(result.headers.authorization, 'Bearer upstream-key');
  assert.equal(result.headers['x-opencode-session'], 'session');
});

test('translation strips the unified session header for CCG', () => {
  const config = baseConfig('http://upstream', 'ccg');
  const result = translateRequest({ config, body: { model: 'unified-model' }, headers: { authorization: 'Bearer master', 'x-opencode-session': 'session' }, backend: config.backends[0], upstreamKey: 'upstream-key' });
  assert.equal(result.headers['x-opencode-session'], undefined);
});

test('HTTP gateway returns local models, proxies JSON and SSE, rejects bad keys, and passes upstream errors through', async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    received.push(entry);
    if (req.url === '/v1/chat/completions' && JSON.parse(entry.body).stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
    } else if (req.url === '/v1/chat/completions' && JSON.parse(entry.body).model === 'error-model') {
      res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"ok"}}]}');
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const config = baseConfig(`http://127.0.0.1:${upstream.address().port}`, 'ocg');
  config.models.push({ id: 'error', backends: { ocg: 'error-model' } });
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-gateway-db-'));
  const env = { CPR_TEST_MASTER: 'test-master', CPR_TEST_UPSTREAM: 'test-upstream', CPR_SESSIONS_DB: path.join(dbDir, 'sessions.db') };
  const { forwardServer, adminServer } = createGatewayServers(config, { env });
  forwardServer.listen(0, '127.0.0.1'); adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(forwardServer, 'listening'), once(adminServer, 'listening')]);
  t.after(async () => {
    await Promise.all([forwardServer, adminServer, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${forwardServer.address().port}`;
  const models = await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer test-master' } });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map((model) => model.id), ['unified-model', 'error']);
  assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const jsonResponse = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer test-master', 'content-type': 'application/json', 'x-opencode-session': 'ocg-session' }, body: JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(jsonResponse.status, 200); assert.equal((await jsonResponse.json()).choices[0].message.content, 'ok');
  assert.equal(received[0].headers.authorization, 'Bearer test-upstream');
  assert.equal(JSON.parse(received[0].body).model, 'native-model');
  assert.equal(received[0].headers['x-opencode-session'], 'ocg-session');
  const streamResponse = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer test-master', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'unified-model', stream: true }) });
  assert.equal(await streamResponse.text(), 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  const errorResponse = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer test-master', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'error' }) });
  assert.equal(errorResponse.status, 503); assert.equal(await errorResponse.text(), '{"error":"unavailable"}');
});
