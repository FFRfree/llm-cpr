import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import type { AuditSummary, Backend, GatewayConfig, QuotaSnapshot, QuotaWindow, RoutingConfig, SessionSummary } from '../lib/contracts.ts';
import type { Gateway } from '../lib/server.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../lib/server.ts';
import { UsageSnapshots } from '../lib/snapshots.ts';
import { rankBackends, monthlyDebtScore } from '../lib/selection.ts';
import { UsageAudit } from '../lib/audit.ts';

interface UsageWindow { percent: number; resetsAt: string | null }
interface Usage { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow }
interface UpstreamState {
  usage: Usage;
  usageStatus?: number;
  status?: number;
  headers?: OutgoingHttpHeaders;
  body?: string;
}
interface ObservedSnapshot extends QuotaSnapshot { fiveHour: QuotaWindow; weekly: QuotaWindow }
interface RouteStatusResponse {
  subscriptions: { snapshot: ObservedSnapshot }[];
  preference: { name: string }[];
}
interface SnapshotsResponse { snapshots: Record<string, ObservedSnapshot> }
interface SessionSummaryResponse { summary: SessionSummary }
interface AuditFailureResponse { summary?: AuditSummary | SessionSummary; session?: SessionSummary }
interface ChatResponse { status: number; headers: Headers; text: string }
interface Fixture {
  get: <T = AuditFailureResponse>(route: string) => Promise<T>;
  refresh: () => Promise<unknown>;
  chat: (session?: string) => Promise<ChatResponse>;
  seen: string[];
  warnings: unknown[];
  auditFile: string;
}
const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server): Promise<void | Error> => new Promise<void | Error>((resolve) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(resolve);
});
const scratch = process.env.TMPDIR || '/root/.hermes/cache/scratch';
const iso = (offset: number): string => new Date(Date.now() + offset).toISOString();
const usage = (overrides: Partial<Usage> = {}): Usage => ({
  rolling: { percent: 10, resetsAt: iso(3_600_000) },
  weekly: { percent: 20, resetsAt: iso(86_400_000) },
  monthly: { percent: 30, resetsAt: iso(15 * 86_400_000) },
  ...overrides,
});

async function fixture(t: TestContext, states: UpstreamState[], routing: RoutingConfig = {}): Promise<Fixture> {
  const seen: string[] = [], warnings: unknown[] = [];
  const dir = fs.mkdtempSync(path.join(scratch, 'cpr-reliability-routing-'));
  const upstreams = states.map((state, index) => http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    for await (const _chunk of req) {}
    if (req.method === 'GET' && req.url === '/usage') {
      return res.writeHead(state.usageStatus ?? 200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ usage: state.usage }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      seen.push(`sub-${index}`);
      return res.writeHead(state.status ?? 200, { 'content-type': 'application/json', ...state.headers })
        .end(state.body ?? JSON.stringify({ backend: `sub-${index}` }));
    }
    res.writeHead(404).end();
  }));
  let gateway: Gateway | undefined;
  t.after(async () => {
    if (gateway) await Promise.all([close(gateway.forwardServer), close(gateway.adminServer)]);
    await Promise.all(upstreams.map(close));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const urls = await Promise.all(upstreams.map(listen));
  const config: GatewayConfig = {
    master_key_env: 'MASTER',
    routing: { snapshot_interval_ms: 3_600_000, ...routing },
    models: [{ id: 'm', backends: { ocg: 'native' } }],
    backends: urls.map((base_url, index) => ({ name: `sub-${index}`, family: 'ocg', direct: true, base_url, key_env: 'KEY', priority: index })),
  };
  const auditFile = path.join(dir, 'usage.db');
  gateway = createGatewayServers(config, {
    env: { MASTER: 'test-master', KEY: 'test-upstream', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: auditFile },
    logger: { warn: (message) => warnings.push(message) },
  });
  const [forward, admin] = await Promise.all([listen(gateway.forwardServer), listen(gateway.adminServer)]);
  const get = async <T = AuditFailureResponse>(route: string): Promise<T> => {
    const response = await fetch(`${admin}${route}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    // HTTP JSON boundary: callers specify the endpoint response shape.
    return response.json() as Promise<T>;
  };
  const refresh = async (): Promise<unknown> => {
    const response = await fetch(`${admin}/api/snapshots/refresh`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const chat = async (session: string = 'new'): Promise<ChatResponse> => {
    const response = await fetch(`${forward}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(2000),
      headers: { authorization: 'Bearer test-master', 'content-type': 'application/json', 'x-session-id': session },
      body: JSON.stringify({ model: 'm' }),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  await refresh();
  return { get, refresh, chat, seen, warnings, auditFile };
}

test('expired full window becomes unknown after refresh failure and new routing falls back to priority', async (t: TestContext) => {
  const states: UpstreamState[] = [
    { usage: usage({ rolling: { percent: 100, resetsAt: iso(-1000) } }) },
    { usage: usage({ monthly: { percent: 1, resetsAt: iso(15 * 86_400_000) } }) },
  ];
  const app = await fixture(t, states);
  states[0].usageStatus = 503;
  await app.refresh();
  const status = await app.get<RouteStatusResponse>('/api/route/status');
  const expired = status.subscriptions[0].snapshot;
  assert.equal(expired.known, false);
  assert.equal(expired.degraded, true);
  assert.equal(expired.fiveHour.expired, true);
  assert.equal(expired.fiveHour.exceeded, null, 'elapsed reset does not prove remaining quota');
  assert.equal(expired.fiveHour.used, null, 'old usage must not describe the new window');
  assert.deepEqual(status.preference.map(({ name }) => name), ['sub-0', 'sub-1']);
  assert.equal((await app.chat()).status, 200);
  assert.deepEqual(app.seen, ['sub-0']);
});

test('public selection re-evaluates saved reset timestamps at the boundary without mutating observations', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  // Selection only reads identity, family and priority from these partial fixtures.
  const backends = [{ name: 'expired', family: 'ocg', priority: 0 }, { name: 'fresh', family: 'ocg', priority: 1 }] as Backend[];
  const snapshots = {
    expired: { known: true, monthlyPercent: 90, monthProgress: 50,
      fiveHour: { used: 100, cap: 100, exceeded: true, resetAt: '2026-11-16T12:00:00Z' } },
    fresh: { known: true, monthlyPercent: 1, monthProgress: 50 },
  };
  const before = structuredClone(snapshots);
  assert.deepEqual(rankBackends({ backends, snapshots, model: { ocg: 'm' }, now }).map(({ name }) => name), ['expired', 'fresh']);
  assert.deepEqual(snapshots, before);
  assert.equal(monthlyDebtScore({ ...snapshots.expired, stale: true }, now), null);
  assert.equal(monthlyDebtScore({ ...snapshots.expired, periodEnd: '2026-11-16T12:00:00Z' }, now), null);
  assert.equal(monthlyDebtScore(undefined, now), null);
});

test('audit read failures report unknown counts rather than throwing or pretending history is empty', (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(scratch, 'cpr-reliability-audit-'));
  const file = path.join(dir, 'usage.db');
  const warnings: unknown[] = [];
  const audit = new UsageAudit({ dbFile: file, logger: { warn: (message) => warnings.push(message) } });
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(audit.record({ identity: 'long', identity_kind: 'session', status: 200 }, undefined), true);
  assert.equal(audit.sessionSummary('long').requests, 1);
  // Break only this disposable ledger through SQLite's external storage boundary.
  // No replacing gateway internals / methods, and no production database access.
  const breaker = new DatabaseSync(file);
  breaker.exec('DROP TABLE requests');
  breaker.close();
  assert.deepEqual(audit.listRequests(), []);
  assert.deepEqual(audit.listSessions(), []);
  const summary = audit.summary();
  assert.equal(summary.degraded, true);
  assert.equal(summary.requests, null);
  assert.equal(summary.sessions, null);
  const session = audit.sessionSummary('long');
  assert.equal(session.degraded, true);
  assert.equal(session.requests, null, 'unknown history must not be reported as a short session');
  assert.equal(session.full_miss_rate, null);
  assert.ok(warnings.some((message) => /\[audit\].*degraded.*query failed/.test(message as string)));
});

test('a live full weekly window still blocks routing after the rolling reset; refresh can restore known quota', async (t: TestContext) => {
  const states: UpstreamState[] = [{ usage: usage({
    rolling: { percent: 100, resetsAt: iso(-1000) },
    weekly: { percent: 100, resetsAt: iso(86_400_000) },
  }) }];
  const app = await fixture(t, states);
  assert.equal((await app.chat()).status, 429);
  assert.deepEqual(app.seen, []);
  states[0].usage = usage();
  await app.refresh();
  const restored = (await app.get<SnapshotsResponse>('/api/snapshots')).snapshots['sub-0'];
  assert.equal(restored.known, true);
  assert.equal(restored.degraded, false);
  assert.equal(restored.fiveHour.exceeded, false);
  assert.equal((await app.chat()).status, 200);
  assert.deepEqual(app.seen, ['sub-0']);
});

test('an unknown expired window is only a best-effort attempt and upstream quota errors remain authoritative', async (t: TestContext) => {
  const app = await fixture(t, [{ usage: usage({ weekly: { percent: 100, resetsAt: iso(-1000) } }),
    status: 429, headers: { 'retry-after': '60' }, body: 'provider-quota-wall' }]);
  const response = await app.chat();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.text, 'provider-quota-wall');
  assert.deepEqual(app.seen, ['sub-0']);
});

test('missing or malformed reset times never clear a known quota wall', async (t: TestContext) => {
  for (const resetAt of [null, 'not-a-date']) {
    await t.test(String(resetAt), async (t: TestContext) => {
      const app = await fixture(t, [{ usage: usage({ rolling: { percent: 100, resetsAt: resetAt } }) }]);
      assert.equal((await app.chat()).status, 429);
      assert.deepEqual(app.seen, []);
    });
  }
});

test('snapshot age disables debt ranking, while a live known quota wall remains in force', async (t: TestContext) => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  let clock = now;
  const upstream = http.createServer((_req: IncomingMessage, res: ServerResponse): ServerResponse => res.end(JSON.stringify({ usage: {
    rolling: { percent: 100, resetsAt: '2026-11-17T12:00:00Z' },
    weekly: { percent: 10, resetsAt: '2026-11-20T12:00:00Z' },
    monthly: { percent: 10, resetsAt: '2026-12-01T12:00:00Z' },
  } })));
  const base_url = await listen(upstream);
  t.after(() => close(upstream));
  // This public snapshot fixture intentionally omits the unused credential field.
  const snapshotBackends = [{ name: 'a', family: 'ocg', direct: true, base_url }] as Backend[];
  const snapshots = new UsageSnapshots({ backends: snapshotBackends,
    env: {}, now: () => clock, intervalMs: 1000, logger: { warn() {} } });
  await snapshots.refresh();
  assert.equal(snapshots.peek().snapshots.a.known, true);
  clock = now + 1999;
  assert.equal(snapshots.peek().snapshots.a.stale, false);
  clock = now + 2000;
  // The OCG usage fixture supplies both window observations.
  const stale = snapshots.peek().snapshots.a as ObservedSnapshot;
  assert.equal(stale.stale, true);
  assert.equal(stale.known, false);
  assert.equal(stale.degraded, true);
  assert.equal(stale.fiveHour.exceeded, true);
  assert.equal(monthlyDebtScore(stale, clock), null);
});

test('quota refresh cannot move an existing pin, and healthy long sessions still refuse quota migration', async (t: TestContext) => {
  const states: UpstreamState[] = [{ usage: usage({ monthly: { percent: 1, resetsAt: iso(15 * 86_400_000) } }) },
    { usage: usage({ monthly: { percent: 90, resetsAt: iso(15 * 86_400_000) } }) }];
  const app = await fixture(t, states, { long_session_min_requests: 2 });
  assert.equal((await app.chat('long')).status, 200);
  states[0].usage = usage({ rolling: { percent: 100, resetsAt: iso(3_600_000) } });
  await app.refresh();
  assert.equal((await app.chat('new')).status, 200);
  assert.equal((await app.chat('long')).status, 200);
  assert.equal((await app.get<SessionSummaryResponse>('/api/audit/summary?identity=long')).summary.requests, 2);
  states[0].status = 403;
  states[0].body = 'long-session-quota';
  const blocked = await app.chat('long');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.text, 'long-session-quota');
  assert.deepEqual(app.seen, ['sub-0', 'sub-1', 'sub-0', 'sub-0']);
});

test('audit failure remains observable over HTTP while successful forwarding continues', async (t: TestContext) => {
  const app = await fixture(t, [{ usage: usage() }]);
  assert.equal((await app.chat('s')).status, 200);
  const breaker = new DatabaseSync(app.auditFile);
  breaker.exec('DROP TABLE requests');
  breaker.close();
  for (const route of ['/api/audit/requests', '/api/audit/sessions', '/api/audit/summary',
    '/api/audit/summary?identity=s', '/api/audit/sessions/s']) {
    const body = await app.get(route);
    if (body.summary) assert.equal(body.summary.degraded, true);
    if (body.session) assert.equal(body.session.degraded, true);
  }
  assert.equal((await app.chat('s')).status, 200);
  assert.ok(app.warnings.some((message) => /query failed/.test(message as string)));
});

// This HTTP contract also needs the server.ts owner to consume degraded=true
// conservatively; audit cannot decide migration policy from inside its ledger.
test('unavailable audit history preserves the existing pin and original quota response', async (t: TestContext) => {
  const states: UpstreamState[] = [
    { usage: usage({ monthly: { percent: 1, resetsAt: iso(15 * 86_400_000) } }) },
    { usage: usage({ monthly: { percent: 90, resetsAt: iso(15 * 86_400_000) } }) },
  ];
  const app = await fixture(t, states, { long_session_min_requests: 2 });
  assert.equal((await app.chat('keep-cache')).status, 200);
  assert.equal((await app.chat('keep-cache')).status, 200);
  const breaker = new DatabaseSync(app.auditFile);
  breaker.exec('DROP TABLE requests');
  breaker.close();
  states[0].status = 429;
  states[0].headers = { 'retry-after': '60' };
  states[0].body = 'quota-with-unknown-history';
  const blocked = await app.chat('keep-cache');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.text, 'quota-with-unknown-history');
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await app.chat('keep-cache')).status, 429);
  assert.deepEqual(app.seen, ['sub-0', 'sub-0', 'sub-0', 'sub-0']);
});
