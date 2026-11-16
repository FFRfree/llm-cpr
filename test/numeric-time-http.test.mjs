import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/server.mjs';
import { monthlyDebtScore } from '../lib/selection.mjs';

test('numeric millisecond quota reset expires and monthly timestamps score correctly', async (t) => {
  let calls = 0;
  const now = Date.now();
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/alpha/billing/credits') return res.end(JSON.stringify({ monthlyCredits: 50, fiveHour: { used: 14, cap: 14, resetAt: now - 1000 }, weekly: { used: 0, cap: 35, resetAt: now + 86400000 } }));
    if (req.url === '/alpha/usage/summary') return res.end(JSON.stringify({ totalCost: 20 }));
    if (req.url === '/alpha/billing/subscriptions') return res.end(JSON.stringify({ periodStart: now - 86400000, periodEnd: now + 86400000 }));
    if (req.method === 'POST') { calls++; for await (const _ of req) {} return res.end('{}'); }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'cpr-time-'));
  const config = { master_key_env: 'MASTER', models: [{ id: 'm', backends: { ccg: 'native' } }], backends: [{ name: 'ccg', family: 'ccg', base_url: `http://127.0.0.1:${upstream.address().port}`, key_env: 'KEY' }] };
  const gateway = createGatewayServers(config, { env: { MASTER: 'master', KEY: 'test', CPR_SESSIONS_DB: path.join(dir, 'sessions.db') }, logger: { warn() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => {
    await Promise.all([gateway.forwardServer, gateway.adminServer, upstream].map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await gateway.snapshots.refresh();
  const response = await fetch(`http://127.0.0.1:${gateway.forwardServer.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(monthlyDebtScore({ known: true, periodStart: now - 86400000, periodEnd: now + 86400000, monthlyPercent: 20 }, now), 30);
});
