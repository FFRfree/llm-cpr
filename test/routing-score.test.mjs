import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/server.mjs';
import { selectBackend, rankBackends, monthlyDebtScore } from '../lib/selection.mjs';
import { UsageSnapshots } from '../lib/snapshots.mjs';

const start = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = (server) => new Promise((resolve) => server.close(resolve));
const launchGateway = async (config, env, logger = { warn() {} }) => {
  const gateway = createGatewayServers(config, { env, logger });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  return gateway;
};
const chat = (gateway, body = { model: 'm' }) => fetch(`http://127.0.0.1:${gateway.forwardServer.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('monthly score uses normalized spend against calendar progress', () => {
  const common = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z' };
  assert.equal(monthlyDebtScore({ ...common, monthlyPercent: 50 }, Date.parse('2026-11-16T00:00:00Z')), 0);
  assert.ok(monthlyDebtScore({ ...common, monthlyPercent: 20 }, Date.parse('2026-11-16T00:00:00Z')) > 0);
});

test('selector filters unsupported models and full windows; exhaustions last and unknown data falls back to priority', () => {
  const backends = [{ name: 'first', family: 'ccg', priority: 0 }, { name: 'behind', family: 'ccg', priority: 1 }, { name: 'exhausted', family: 'ccg', priority: 2 }];
  const period = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', known: true };
  const snapshots = { first: { ...period, monthlyPercent: 20 }, behind: { ...period, monthlyPercent: 10 }, exhausted: { ...period, monthlyPercent: 100 } };
  assert.equal(selectBackend({ backends, snapshots, model: { ccg: 'native' }, now: Date.parse('2026-11-16T00:00:00Z') }).name, 'behind');
  assert.equal(selectBackend({ backends, snapshots: {}, model: { ccg: 'native' } }).name, 'first');
  assert.equal(selectBackend({ backends, snapshots: { first: { ...period, monthlyPercent: 100 }, behind: { ...period, monthlyPercent: 100 } }, model: { ccg: 'native' }, now: Date.parse('2026-11-16T00:00:00Z') }).name, 'first');
  const limited = Object.fromEntries(backends.map(({ name }) => [name, { fiveHour: { exceeded: true }, weekly: { exceeded: true } }]));
  assert.throws(() => selectBackend({ backends, snapshots: limited, model: { ccg: 'native' } }), /all eligible subscriptions are window-limited/);
  assert.throws(() => selectBackend({ backends, snapshots, model: { ocg: 'not-configured' } }), (error) => error.statusCode === 400);
});

test('rankBackends exposes the full candidate order selectBackend picks from', () => {
  const backends = [{ name: 'first', family: 'ccg', priority: 0 }, { name: 'behind', family: 'ccg', priority: 1 }, { name: 'exhausted', family: 'ccg', priority: 2 }];
  const period = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', known: true };
  const snapshots = { first: { ...period, monthlyPercent: 20 }, behind: { ...period, monthlyPercent: 10 }, exhausted: { ...period, monthlyPercent: 100 } };
  const now = Date.parse('2026-11-16T00:00:00Z');
  const ranked = rankBackends({ backends, snapshots, model: { ccg: 'native' }, now });
  assert.deepEqual(ranked.map((b) => b.name), ['behind', 'first']); // 月耗尽的 exhausted 有可用候选时不进池（既有行为）
  assert.equal(selectBackend({ backends, snapshots, model: { ccg: 'native' }, now }).name, ranked[0].name);
  const limited = Object.fromEntries(backends.map(({ name }) => [name, { fiveHour: { exceeded: true }, weekly: { exceeded: true } }]));
  assert.deepEqual(rankBackends({ backends, snapshots: limited, model: { ccg: 'native' } }), []);
  assert.throws(() => rankBackends({ backends, snapshots, model: { ocg: 'no' } }), (error) => error.statusCode === 400);
});

test('CCG snapshot polls credits, usage, subscriptions and marks failed alpha queries unknown', async () => {
  const paths = [];
  const snapshots = new UsageSnapshots({ backends: [{ name: 'ccg', family: 'ccg', base_url: 'http://ccg.invalid/provider/v1', key_env: 'KEY' }], env: { KEY: 'secret' }, fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/credits')) return Response.json({ monthlyCredits: 60, fiveHour: { used: 2, cap: 14 }, weekly: { used: 3, cap: 35 } });
    if (url.endsWith('/summary')) return Response.json({ totalCost: 10 });
    return Response.json({ periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z' });
  }, logger: { warn() {} }});
  await snapshots.refresh();
  assert.equal(paths.length, 3);
  assert.equal(snapshots.peek().snapshots.ccg.monthlyPercent, 100 * 10 / 70);
  const failed = new UsageSnapshots({ backends: [{ name: 'bad', family: 'ccg', base_url: 'http://ccg.invalid', key_env: 'KEY' }], env: { KEY: 'x' }, fetchImpl: async () => new Response('', { status: 500 }), logger: { warn() {} } });
  await failed.refresh();
  assert.equal(failed.peek().snapshots.bad.known, false);
  assert.equal(failed.peek().snapshots.bad.degraded, true);
});

test('OCG status provides monthly progress and percent-based window state', async () => {
  const snapshots = new UsageSnapshots({ backends: [{ name: 'ocg-a', family: 'ocg', base_url: 'http://proxy.invalid:8731', status_url: 'http://proxy.invalid:8742/api/route/status', account: 'account-a' }], fetchImpl: async () => Response.json({ accounts: [{ name: 'account-a', monthly_percent: 45, month_progress: 60, rolling_percent: 100, weekly_percent: 20 }] }), logger: { warn() {} } });
  await snapshots.refresh();
  const result = snapshots.peek().snapshots['ocg-a'];
  assert.equal(result.monthlyPercent, 45);
  assert.equal(result.monthProgress, 60);
  assert.equal(result.fiveHour.exceeded, true);
  assert.equal(result.fiveHour.used, 100);
  assert.equal(result.fiveHour.cap, 100);
  assert.equal(result.weekly.exceeded, false);
  assert.equal(result.weekly.used, 20);
});

test('e2e chooses greater-debt CCG subscription on new identity', async (t) => {
  const seen = [];
  const fake = (spent, name) => http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/alpha/billing/credits') return res.end(JSON.stringify({ monthlyCredits: 70 - spent, fiveHour: { used: 1, cap: 14 }, weekly: { used: 1, cap: 35 } }));
    if (req.method === 'GET' && req.url === '/alpha/usage/summary') return res.end(JSON.stringify({ totalCost: spent }));
    if (req.method === 'GET' && req.url === '/alpha/billing/subscriptions') return res.end(JSON.stringify({ periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z' }));
    if (req.method === 'POST') { seen.push(name); for await (const _chunk of req) {} res.end(JSON.stringify({ backend: name })); return; }
    res.writeHead(404).end();
  });
  const first = fake(40, 'first'); const second = fake(5, 'second');
  const firstUrl = await start(first); const secondUrl = await start(second);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-score-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), KEY1: 'one', KEY2: 'two' };
  const config = { master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ccg: 'native' } }], backends: [{ name: 'first', family: 'ccg', base_url: firstUrl, key_env: 'KEY1', priority: 0 }, { name: 'second', family: 'ccg', base_url: secondUrl, key_env: 'KEY2', priority: 1 }] };
  const gateway = await launchGateway(config, env);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(first); await close(second); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await chat(gateway);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['second']);
});

test('e2e routes directly to OCG backends by monthly debt and pins the selected account per identity', async (t) => {
  const received = [];
  const direct = (name, percent) => http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/zen/go/v1/usage') {
      assert.equal(req.headers['user-agent']?.startsWith('Mozilla/'), true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: {
        rolling: { percent: 10, resetsAt: '2026-11-17T00:00:00.000Z' },
        weekly: { percent: 20, resetsAt: '2026-11-20T00:00:00.000Z' },
        monthly: { percent, resetsAt: '2026-12-01T00:00:00.000Z' },
      } }));
      return;
    }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received.push({ name, path: req.url, session: req.headers['x-opencode-session'], body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ backend: name })); return;
    }
    res.writeHead(404).end();
  });
  const foxmail = direct('foxmail', 85); const gmail = direct('gmail', 15);
  const foxUrl = await start(foxmail); const gmailUrl = await start(gmail);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-ocg-direct-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), FOX_KEY: 'fox-fixture', GMAIL_KEY: 'gmail-fixture' };
  const config = {
    master_key_env: 'CPR_MASTER',
    models: [{ id: 'm', backends: { ocg: 'native-model' } }],
    backends: [
      { name: 'ocg-foxmail', family: 'ocg', direct: true, base_url: `${foxUrl}/zen/go/v1`, key_env: 'FOX_KEY', priority: 0 },
      { name: 'ocg-gmail', family: 'ocg', direct: true, base_url: `${gmailUrl}/zen/go/v1`, key_env: 'GMAIL_KEY', priority: 1 },
    ],
  };
  const gateway = await launchGateway(config, env);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(foxmail); await close(gmail); fs.rmSync(dir, { recursive: true, force: true }); });

  const send = (session) => fetch(`http://127.0.0.1:${gateway.forwardServer.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': session },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal((await send('sticky-session')).status, 200);
  assert.equal((await send('sticky-session')).status, 200);
  assert.equal((await send('new-session')).status, 200);
  assert.deepEqual(received.map((entry) => entry.name), ['gmail', 'gmail', 'gmail']);
  assert.ok(received.every((entry) => entry.path === '/zen/go/v1/chat/completions'));
  assert.ok(received.every((entry) => entry.session === 'sticky-session' || entry.session === 'new-session'));
  assert.ok(received.every((entry) => entry.body.model === 'native-model'));
});

test('e2e returns explicit 429 when all candidates exceed both windows', async (t) => {
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/alpha/billing/credits') return res.end(JSON.stringify({ monthlyCredits: 50, fiveHour: { used: 14, cap: 14 }, weekly: { used: 35, cap: 35 } }));
    if (req.method === 'GET' && req.url === '/alpha/usage/summary') return res.end(JSON.stringify({ totalCost: 20 }));
    if (req.method === 'GET' && req.url === '/alpha/billing/subscriptions') return res.end(JSON.stringify({ periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z' }));
    res.writeHead(200).end('should not forward');
  });
  const base = await start(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-limited-'));
  const gateway = await launchGateway({ master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ccg: 'native' } }], backends: [{ name: 'limited', family: 'ccg', base_url: base, key_env: 'UPSTREAM' }] }, { CPR_MASTER: 'master', UPSTREAM: 'key', CPR_SESSIONS_DB: path.join(dir, 'sessions.db') });
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await chat(gateway);
  assert.equal(response.status, 429);
  assert.match((await response.json()).error.message, /all eligible subscriptions are window-limited/);
});
