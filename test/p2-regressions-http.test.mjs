import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../lib/server.mjs';

// User-approved seam: real loopback HTTP with disposable storage and fake upstreams.
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});
async function fixture(t, handlers, routing = {}) {
  const dir = fs.mkdtempSync('/root/.hermes/cache/scratch/cpr-p2-');
  const seen = [];
  const upstreams = handlers.map((handler, index) => http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (req.method === 'GET') return res.end('{"accounts":[]}');
    seen.push(index);
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  }));
  const urls = await Promise.all(upstreams.map(listen));
  const auditFile = path.join(dir, 'usage.db');
  const gateway = createGatewayServers({
    master_key_env: 'MASTER', models: [{ id: 'm', backends: { ocg: 'native' } }], routing,
    backends: urls.map((base_url, i) => ({ name: `sub-${i}`, family: 'ocg', base_url, key_env: 'KEY', priority: i })),
  }, { env: { MASTER: 'fake-master', KEY: 'fake-upstream', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: auditFile }, logger: { warn() {} } });
  const [url, admin] = await Promise.all([listen(gateway.forwardServer), listen(gateway.adminServer)]);
  t.after(async () => {
    await Promise.all([close(gateway.forwardServer), close(gateway.adminServer)]);
    await Promise.all(upstreams.map(close));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = async (route) => {
    const res = await fetch(`${admin}${route}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const open = (session) => new Promise((resolve, reject) => {
    const req = http.request(`${url}/v1/chat/completions`, { method: 'POST', headers: {
      authorization: 'Bearer fake-master', 'x-session-id': session, 'content-type': 'application/json',
    } }, (res) => { res.on('error', () => {}); resolve(res); });
    req.on('error', reject);
    req.end('{"model":"m","stream":true}');
  });
  const chat = async (session) => {
    const res = await open(session);
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return { status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers };
  };
  const rows = async (session) => (await get(`/api/audit/requests?identity=${session}`)).requests;
  return { get, open, chat, rows, seen, auditFile };
}
const block = Buffer.from(': ' + 'x'.repeat(65530) + '\n\n');
const blocks = 512; // Exceeds loopback TCP buffers, forcing real pipe backpressure.
const tail = Buffer.from('data: {"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n');
async function flood(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (let i = 0; i < blocks; i++) {
    if (res.destroyed) return;
    if (!res.write(block)) await once(res, 'drain');
  }
}

test('a slow HTTP client can hold a healthy SSE beyond the upstream idle deadline and receive every byte', { timeout: 10000 }, async (t) => {
  let sentAll = false;
  const app = await fixture(t, [async (_req, res) => {
    await flood(res);
    sentAll = true;
    res.end(tail);
  }], { upstream_timeout_ms: 200 });
  const response = await app.open('slow');
  response.pause();
  await delay(800);
  assert.equal(sentAll, false, 'fake upstream must still be blocked by actual client backpressure');
  assert.deepEqual(await app.rows('slow'), [], 'downstream backpressure is not upstream inactivity');
  let bytes = 0;
  const ending = new Promise((resolve, reject) => {
    response.on('data', (chunk) => { bytes += chunk.length; });
    response.once('end', resolve);
    response.once('error', reject);
  });
  response.resume();
  await ending;
  assert.equal(bytes, blocks * block.length + tail.length);
  assert.deepEqual((await app.rows('slow')).map((row) => [row.status, row.completion_tokens]), [[200, 7]]);
});

test('upstream idle timeout is rearmed after a backpressured client resumes', { timeout: 10000 }, async (t) => {
  let closed;
  const stopped = new Promise((resolve) => { closed = resolve; });
  const app = await fixture(t, [async (_req, res) => {
    res.once('close', closed);
    await flood(res); // No more upstream data after the client drains this body.
  }], { upstream_timeout_ms: 200 });
  const response = await app.open('resume-idle');
  response.pause();
  await delay(800);
  assert.deepEqual(await app.rows('resume-idle'), []);
  let bytes = 0;
  response.on('data', (chunk) => { bytes += chunk.length; });
  const failed = once(response, 'error');
  response.resume();
  const [error] = await failed;
  assert.match(error.message, /aborted/);
  await stopped;
  assert.equal(bytes, blocks * block.length, 'the client must drain the complete prefix before the true idle timeout');
  assert.deepEqual((await app.rows('resume-idle')).map((row) => row.status), [504]);
});

test('cancelling a backpressured client still destroys upstream and records exactly one 499', { timeout: 10000 }, async (t) => {
  let closed;
  const stopped = new Promise((resolve) => { closed = resolve; });
  const app = await fixture(t, [async (_req, res) => {
    res.once('close', closed);
    await flood(res);
    res.end(tail);
  }], { upstream_timeout_ms: 200 });
  const response = await app.open('paused-cancel');
  response.pause();
  await delay(800);
  assert.deepEqual(await app.rows('paused-cancel'), []);
  response.destroy();
  await stopped;
  await delay(50);
  assert.deepEqual((await app.rows('paused-cancel')).map((row) => row.status), [499]);
});

test('failed audit writes with readable storage leave history unknown and preserve cache pins even after writes recover', async (t) => {
  let quota = false;
  const ok = (_req, res) => res.end('{"usage":{"prompt_tokens":20,"completion_tokens":1}}');
  const app = await fixture(t, [(_req, res) => {
    if (quota) res.writeHead(429, { 'retry-after': '60' }).end('original-quota');
    else ok(_req, res);
  }, ok], { long_session_min_requests: 4 });
  assert.equal((await app.chat('keep-cache')).status, 200);
  // Only the disposable SQLite storage boundary is faulted: SELECT stays healthy.
  const breaker = new DatabaseSync(app.auditFile);
  t.after(() => breaker.close());
  breaker.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON requests BEGIN
    SELECT RAISE(FAIL, 'test write failure'); END`);
  for (let i = 0; i < 3; i++) assert.equal((await app.chat('keep-cache')).status, 200);
  assert.equal((await app.rows('keep-cache')).length, 1, 'forwarded turns really are absent from the ledger');
  breaker.exec('DROP TRIGGER reject_audit');
  const summary = (await app.get('/api/audit/summary?identity=keep-cache')).summary;
  assert.equal(summary.degraded, true, 'successful reads cannot establish complete history after a failed write');
  assert.equal(summary.requests, null, 'do not manufacture the three missing turns or report an exact undercount');
  assert.equal(summary.full_miss_rate, null);
  assert.equal((await app.get('/api/audit/sessions/keep-cache')).session.requests, null);
  assert.equal((await app.get('/api/audit/sessions')).sessions[0].requests, null);
  quota = true;
  for (let i = 0; i < 2; i++) {
    const response = await app.chat('keep-cache');
    assert.equal(response.status, 429);
    assert.equal(response.text, 'original-quota');
    assert.equal(response.headers['retry-after'], '60');
  }
  assert.deepEqual(app.seen, [0, 0, 0, 0, 0, 0], 'unknown history must not cause quota migration');
  assert.equal((await app.rows('keep-cache')).length, 3, 'audit writes recover without making history complete');
  assert.equal((await app.get('/api/audit/summary?identity=keep-cache')).summary.requests, null);
});
