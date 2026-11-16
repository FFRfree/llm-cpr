import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../lib/server.mjs';
import { UsageAudit } from '../lib/audit.mjs';

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = (server) => new Promise((resolve) => server.close(resolve));
const fixture = async (t, { body, logger = { warn() {}, log() {} }, auditPath } = {}) => {
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const result = { id: 'response', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 50 } } };
    res.writeHead(200, { 'content-type': request.stream ? 'text/event-stream' : 'application/json' });
    res.end(request.stream ? `data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n` : JSON.stringify(result));
  });
  const baseUrl = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-'));
  const env = { CPR_MASTER: 'master', KEY: 'upstream', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), ...(auditPath ? { CPR_USAGE_DB: auditPath } : { CPR_USAGE_DB: path.join(dir, 'usage.db') }) };
  const config = { master_key_env: 'CPR_MASTER', models: [{ id: 'unified', backends: { ocg: 'native' } }], backends: [{ name: 'subscription-a', family: 'ocg', account: 'account-a', base_url: baseUrl, key_env: 'KEY' }] };
  const gateway = createGatewayServers(config, { env, logger });
  gateway.forwardServer.listen(0, '127.0.0.1');
  await once(gateway.forwardServer, 'listening');
  t.after(async () => { await close(gateway.forwardServer); await close(upstream); gateway.audit?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (payload = body ?? { model: 'unified', messages: [{ role: 'user', content: 'TOP_SECRET_PROMPT' }] }) => fetch(`http://127.0.0.1:${gateway.forwardServer.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-coding-plan-session': 'session-a' }, body: JSON.stringify(payload) });
  return { gateway, env, dir, send, logger };
};

test('audit stores complete request metadata and parsed upstream usage, never request body', async (t) => {
  const { gateway, env, send } = await fixture(t);
  const response = await send();
  assert.equal(response.status, 200);
  const db = new DatabaseSync(env.CPR_USAGE_DB);
  const row = db.prepare('SELECT * FROM requests').get();
  assert.equal(row.identity, 'session-a');
  assert.equal(row.identity_kind, 'session');
  assert.equal(row.subscription, 'subscription-a');
  assert.equal(row.account, 'account-a');
  assert.equal(row.model, 'unified');
  assert.equal(row.translated_model, 'native');
  assert.equal(row.status, 200);
  assert.equal(row.prompt_tokens, 100);
  assert.equal(row.completion_tokens, 20);
  assert.equal(row.cache_hit_tokens, 50);
  assert.equal(row.total_tokens, 120);
  assert.equal(row.cache_outcome, 'partial');
  assert.match(row.usage_json, /cached_tokens/);
  assert.doesNotMatch(JSON.stringify(row), /TOP_SECRET_PROMPT/);
  assert.equal(gateway.audit.sessionSummary('session-a').requests, 1);
  db.close();
});

test('cache miss summaries use full-miss session rate and prior-prompt 0.6 loss rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-unit-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  for (const [ts, hit] of [[1, 0], [2, 59], [3, 60]]) {
    audit.record({ ts, identity: 's', identity_kind: 'session', subscription: 'sub', account: 'a' },
      { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: hit } });
  }
  const summary = audit.sessionSummary('s');
  assert.equal(summary.full_miss_rate, 1 / 3);
  assert.deepEqual(summary.loss_events.map((event) => event.ts), [2]);
  audit.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('streaming responses and concurrent requests each produce one audit row', async (t) => {
  const { env, send } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => send({ model: 'unified', stream: index === 0 })));
  assert.ok(responses.every((response) => response.status === 200));
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  const db = new DatabaseSync(env.CPR_USAGE_DB);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 6);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM requests WHERE usage_json IS NOT NULL').get().n === 6);
  db.close();
});

test('audit write failure logs degraded marker and does not block successful forwarding', async (t) => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(' ')), log() {} };
  const { gateway, send } = await fixture(t, { logger });
  gateway.audit.db.close();
  const response = await send();
  assert.equal(response.status, 200);
  assert.ok(warnings.some((message) => /\[audit\].*degraded|\[audit\].*record failed/i.test(message)));
});
