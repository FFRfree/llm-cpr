import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers, startGateway } from '../core/http/server.ts';
import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditRow, GatewayConfig, QuotaSnapshot, SessionSummary } from '../core/contracts.ts';

interface RouteStatus {
  subscriptions: { name: string; snapshot: QuotaSnapshot & { fiveHour: { cap: number } } }[];
  mappings: { tenant: string; backend: string; identities: number }[];
}
interface RequestsPayload { requests: AuditRow[] }
interface SessionsPayload { sessions: SessionSummary[] }
interface SummaryPayload { summary: SessionSummary }

const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));

test('admin API exposes subscription snapshots, audit queries and index page contract on loopback', async (t: TestContext): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-admin-'));
  const env = { CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  const config: GatewayConfig = {
    models: [{ id: 'unified', backends: { ccg: 'native' } }],
    backends: [{ name: 'sub-a', family: 'ccg', account: 'acct-a', base_url: 'http://127.0.0.1:1', key_env: 'KEY' }],
    admin: { port: 8740 },
  };
  const gateway = createGatewayServers(config, { env, logger: { warn() {}, log() {} } });
  gateway.adminServer.listen(0, '127.0.0.1');
  await once(gateway.adminServer, 'listening');
  assert.equal((gateway.adminServer.address() as AddressInfo).address, '127.0.0.1');
  t.after(async () => { await close(gateway.adminServer); await close(gateway.forwardServer); gateway.audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`;
  gateway.snapshots.values = { 'sub-a': { known: true, degraded: false, monthlyPercent: 25, monthlyCap: 70, monthlyRemaining: 52.5,
    fiveHour: { used: 2, cap: 14, exceeded: false }, weekly: { used: 8, cap: 35, exceeded: false }, fetchedAt: Date.now() } };
  gateway.audit.record({ ts: 10, identity: 'session-1', identity_kind: 'session', subscription: 'sub-a', account: 'acct-a', model: 'unified', status: 200, ms: 12 },
    { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } });
  gateway.audit.record({ ts: 20, identity: 'session-1', identity_kind: 'session', subscription: 'sub-a', account: 'acct-a', model: 'unified', status: 200, ms: 15 },
    { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } });

  // HTTP JSON response boundary: use the declared payload shape for each admin endpoint.
  const status = await fetch(`${root}/api/route/status`).then((r: Response): Promise<RouteStatus> => r.json());
  assert.equal(status.subscriptions[0].name, 'sub-a');
  assert.equal(status.subscriptions[0].snapshot.fiveHour.cap, 14);
  assert.ok(Array.isArray(status.mappings));
  const requests = await fetch(`${root}/api/audit/requests`).then((r: Response): Promise<RequestsPayload> => r.json());
  assert.equal(requests.requests[0].identity, 'session-1');
  const sessions = await fetch(`${root}/api/audit/sessions`).then((r: Response): Promise<SessionsPayload> => r.json());
  assert.equal(sessions.sessions[0].identity, 'session-1');
  const summary = await fetch(`${root}/api/audit/summary?identity=session-1`).then((r: Response): Promise<SummaryPayload> => r.json());
  assert.equal(summary.summary.loss_events.length, 1);
  assert.equal(summary.summary.loss_events[0].cache_hit_tokens, 20);
  const detail = await fetch(`${root}/api/audit/sessions/session-1`).then((r: Response): Promise<RequestsPayload> => r.json());
  assert.equal(detail.requests[0].cache_hit_tokens, 20);
  const html = await fetch(root).then((r) => r.text());
  // 后台 v2：'/' 发 static/index.html（共享 app.css 的多页 Admin）
  assert.match(html, /5 小时/);
  assert.match(html, /每周/);
  assert.match(html, /订阅实际消耗/);
  assert.match(html, /assets\/app\.css/);
  assert.equal((await fetch(`${root}/api/audit/requests?limit=1`)).status, 200);
  assert.equal((await fetch(`${root}/assets/app.js`)).status, 200);
});

test('startGateway ignores configured public admin host and binds the admin listener to loopback', async (t: TestContext): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-admin-bind-'));
  const env = { CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  const gateway = await startGateway({
    models: [{ id: 'unified', backends: { ccg: 'native' } }],
    backends: [{ name: 'sub-a', family: 'ccg', base_url: 'http://127.0.0.1:1', key_env: 'KEY' }],
    listen: { host: '127.0.0.1', port: 0 }, admin: { host: '0.0.0.0', port: 0 },
  }, { env, logger: { log() {}, warn() {} } });
  assert.equal((gateway.adminServer.address() as AddressInfo).address, '127.0.0.1');
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); fs.rmSync(dir, { recursive: true, force: true }); });
});

test('audit query functions return stable request, session and aggregate shapes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-query-'));
  const { UsageAudit } = await import('../core/store/audit.ts');
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  audit.record({ ts: 1, identity: 's', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(audit.listRequests().length, 1);
  assert.equal(audit.listSessions()[0].identity, 's');
  assert.equal(audit.summary().requests, 1);
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
