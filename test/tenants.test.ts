// 租户（ADR-0007）：key 即租户。覆盖鉴权三态、亲和隔离、记账带 tenant、ctx.tenant、
// backends 子集（含池外亲和 stale-pin）、models allowlist、旧库加列迁移、无声明兼容与 validateConfig 坏声明。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../core/http/server.ts';
import { openDatabase } from '../core/store/db.ts';
import { createSystemEventStore } from '../core/store/events.ts';
import { validateConfig } from '../core/policy/config.ts';
import type { TestContext } from 'node:test';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Backend, GatewayConfig, Tenant } from '../core/contracts.ts';
import type { DecisionCtx, RouterPolicy } from '../core/policy/contract.ts';

interface Seen { name: string; auth: string | undefined }

const listen = async (server: Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));

async function fakeBackend(name: string, seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for await (const _chunk of req) { /* drain */ }
    if (req.method === 'POST') seen.push({ name, auth: String(req.headers.authorization ?? '') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ backend: name }));
  });
  return { server, url: await listen(server) };
}

// 声明里的 backends 按 index 命名 first/second（priority = index），新会话在额度未知时按 priority 选。
const backendsOf = (urls: string[]): Backend[] => urls.map((url, index) => ({ name: index === 0 ? 'first' : 'second', family: 'ocg', base_url: url, key_env: 'K_UPSTREAM', priority: index }));

interface GatewayHandle { gateway: ReturnType<typeof createGatewayServers>; forwardUrl: string; adminUrl: string; dbPath: string; dir: string }

async function startTenanted(t: TestContext, tenants: Tenant[], backendUrls: string[], decide?: RouterPolicy['decide'], envExtra: Record<string, string> = {}, dbPath?: string): Promise<GatewayHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tenants-'));
  dbPath ??= path.join(dir, 'data.db');
  const env = { K_MAIN: 'main-key', K_HERMES: 'hermes-key', K_UPSTREAM: 'upstream', CPR_DB_FILE: dbPath, ...envExtra };
  const config = {
    models: [
      { id: 'm', backends: { ocg: 'native-m' } },
      { id: 'other', backends: { ocg: 'native-other' } },
    ],
    backends: backendsOf(backendUrls),
    tenants,
    ...(decide ? { decide } : {}),
  } as unknown as RouterPolicy;
  const gateway = createGatewayServers(config, { env, logger: { warn() {}, log() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1');
  gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); });
  return {
    gateway,
    forwardUrl: `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`,
    adminUrl: `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`,
    dbPath, dir,
  };
}

const chat = (url: string, key: string, body: object = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, extraHeaders: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });

test('tenant keys authenticate per tenant; unknown keys 401; master key stops working once tenants are declared', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startTenanted(t,
    [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES' }],
    [fake.url], undefined, { CPR_MASTER: 'legacy-master' });
  assert.equal((await chat(app.forwardUrl, 'main-key')).status, 200);
  assert.equal((await chat(app.forwardUrl, 'hermes-key')).status, 200);
  assert.equal((await chat(app.forwardUrl, 'nope')).status, 401);
  assert.equal((await chat(app.forwardUrl, 'legacy-master')).status, 401); // 声明了 tenants：master_key_env 不再是门钥匙
});

test('same session id in different tenants binds independently (affinity + ledger isolation)', async (t: TestContext): Promise<void> => {
  const seen: Seen[] = [];
  const first = await fakeBackend('first', seen);
  const second = await fakeBackend('second', seen);
  t.after(async () => { await close(first.server); await close(second.server); });
  // main 全池（priority 先选 first）；hermes 限定 second 子集——同 session id 两租户各自归属。
  const app = await startTenanted(t,
    [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES', backends: ['second'] }],
    [first.url, second.url]);
  const session = { 'x-session-id': 'shared-session' };
  assert.equal((await (await chat(app.forwardUrl, 'main-key', undefined, session)).json()).backend, 'first');
  assert.equal((await (await chat(app.forwardUrl, 'hermes-key', undefined, session)).json()).backend, 'second');
  // 各自的亲和互不串扰：再发一轮仍回各自后端
  assert.equal((await (await chat(app.forwardUrl, 'main-key', undefined, session)).json()).backend, 'first');
  assert.equal((await (await chat(app.forwardUrl, 'hermes-key', undefined, session)).json()).backend, 'second');
  const db = new DatabaseSync(app.dbPath);
  const events = db.prepare(`SELECT tenant, kind, backend_name FROM system_events WHERE kind IN ('route.bind','route.rebind') ORDER BY id`).all() as Array<{ tenant: string; kind: string; backend_name: string }>;
  // node:sqlite 行是 null-prototype：deepEqual（strict）比原型，先摊平成普通对象
  assert.deepEqual(events.map((row) => ({ ...row })), [
    { tenant: 'main', kind: 'route.bind', backend_name: 'first' },
    { tenant: 'hermes', kind: 'route.bind', backend_name: 'second' },
  ]);
  const requests = db.prepare('SELECT tenant, identity, subscription FROM requests ORDER BY id').all() as Array<{ tenant: string; identity: string; subscription: string }>;
  assert.deepEqual(requests.map((row) => row.tenant), ['main', 'hermes', 'main', 'hermes']);
  db.close();
  // 管理口按租户过滤：main 只看到 first 的行，hermes 只看到 second 的行
  const mainSessions = await fetch(`${app.adminUrl}/api/audit/sessions?tenant=main`).then((r) => r.json());
  assert.ok(mainSessions.sessions.every((row: { tenant: string }) => row.tenant === 'main'));
  const hermesRequests = await fetch(`${app.adminUrl}/api/audit/requests?tenant=hermes`).then((r) => r.json());
  assert.equal(hermesRequests.requests.length, 2);
  assert.ok(hermesRequests.requests.every((row: { tenant: string; subscription: string }) => row.tenant === 'hermes' && row.subscription === 'second'));
  const hermesSummary = await fetch(`${app.adminUrl}/api/audit/summary?tenant=hermes`).then((r) => r.json());
  assert.equal(hermesSummary.summary.requests, 2);
  const status = await fetch(`${app.adminUrl}/api/route/status`).then((r) => r.json());
  assert.deepEqual(status.tenants.map((tenant: { name: string }) => tenant.name), ['main', 'hermes']);
});

test('tenant backends subset goes stale-pin: affinity outside the pool re-selects within the pool', async (t: TestContext): Promise<void> => {
  const first = await fakeBackend('first', []);
  const second = await fakeBackend('second', []);
  t.after(async () => { await close(first.server); await close(second.server); });
  // 阶段一：hermes 不限池，粘到 first（priority 0）
  const phase1 = await startTenanted(t, [{ name: 'hermes', key_env: 'K_HERMES' }], [first.url, second.url]);
  assert.equal((await (await chat(phase1.forwardUrl, 'hermes-key', undefined, { 'x-session-id': 'shrink' })).json()).backend, 'first');
  phase1.gateway.audit.close();
  // 阶段二：同一库上，hermes 限定 second —— 池外亲和按 stale 重选（等价订阅下线）
  const env = { K_HERMES: 'hermes-key', K_UPSTREAM: 'upstream', CPR_DB_FILE: phase1.dbPath };
  const config = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: backendsOf([first.url, second.url]),
    tenants: [{ name: 'hermes', key_env: 'K_HERMES', backends: ['second'] }],
  } as unknown as RouterPolicy;
  const gateway = createGatewayServers(config, { env, logger: { warn() {}, log() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1');
  await once(gateway.forwardServer, 'listening');
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); gateway.audit.close(); fs.rmSync(phase1.dir, { recursive: true, force: true }); });
  const url2 = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;
  assert.equal((await (await chat(url2, 'hermes-key', undefined, { 'x-session-id': 'shrink' })).json()).backend, 'second');
  const db = new DatabaseSync(phase1.dbPath);
  const rebind = db.prepare(`SELECT backend_name, detail FROM system_events WHERE kind = 'route.rebind'`).get() as { backend_name: string; detail: string };
  assert.equal(rebind.backend_name, 'second');
  assert.equal(JSON.parse(rebind.detail).trigger, 'stale-pin');
  db.close();
});

test('ctx.tenant reaches decide at both decision points', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const seenTenants: string[] = [];
  const decide = (ctx: DecisionCtx) => { seenTenants.push(ctx.tenant); return null; };
  const app = await startTenanted(t, [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES' }], [fake.url], decide);
  await chat(app.forwardUrl, 'main-key');
  await chat(app.forwardUrl, 'hermes-key');
  assert.deepEqual(seenTenants, ['main', 'hermes']);
});

test('tenant models allowlist: /v1/models filters and out-of-list model 400s', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startTenanted(t,
    [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES', models: ['m'] }],
    [fake.url]);
  const hermesModels = await fetch(`${app.forwardUrl}/v1/models`, { headers: { authorization: 'Bearer hermes-key' } }).then((r) => r.json());
  assert.deepEqual(hermesModels.data.map((entry: { id: string }) => entry.id), ['m']);
  const mainModels = await fetch(`${app.forwardUrl}/v1/models`, { headers: { authorization: 'Bearer main-key' } }).then((r) => r.json());
  assert.deepEqual(mainModels.data.map((entry: { id: string }) => entry.id).sort(), ['m', 'other']);
  assert.equal((await chat(app.forwardUrl, 'hermes-key', { model: 'other', messages: [{ role: 'user', content: 'hi' }] })).status, 400);
  assert.equal((await chat(app.forwardUrl, 'main-key', { model: 'other', messages: [{ role: 'user', content: 'hi' }] })).status, 200);
});

test('no tenants declared: master key auth and default tenant rows (v0.1.0 behavior)', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tenants-default-'));
  const dbPath = path.join(dir, 'data.db');
  const env = { CPR_MASTER: 'master', K_UPSTREAM: 'upstream', CPR_DB_FILE: dbPath };
  const config: GatewayConfig = { master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ocg: 'native-m' } }], backends: [{ name: 'first', family: 'ocg', base_url: fake.url, key_env: 'K_UPSTREAM' }] };
  const gateway = createGatewayServers(config, { env, logger: { warn() {}, log() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1');
  gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); gateway.audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;
  assert.equal((await chat(url, 'master')).status, 200);
  assert.equal((await chat(url, 'wrong')).status, 401);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT tenant FROM requests').get() as { tenant: string };
  assert.equal(row.tenant, 'default');
  const adminUrl = `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`;
  const status = await fetch(`${adminUrl}/api/route/status`).then((r) => r.json());
  assert.deepEqual(status.tenants, [{ name: 'default' }]);
  db.close();
});

test('legacy data.db gains tenant columns with default backfill, rows preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tenants-migrate-'));
  const file = path.join(dir, 'data.db');
  const legacy = new DatabaseSync(file);
  // 2026-11-18 affinity-events 版 schema（无 tenant 列）
  legacy.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, identity_kind TEXT NOT NULL,
    subscription TEXT, account TEXT, model TEXT, translated_model TEXT, path TEXT, status INTEGER, ms INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
    cache_write_tokens INTEGER, total_tokens INTEGER, cache_observed INTEGER NOT NULL DEFAULT 0,
    cache_outcome TEXT, ttft_ms INTEGER, stream_ms INTEGER, usage_json TEXT)`);
  legacy.exec(`CREATE TABLE system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
    identity_kind TEXT, identity_hash TEXT, backend_name TEXT, request_id INTEGER, detail TEXT)`);
  legacy.prepare(`INSERT INTO requests(ts,identity,identity_kind,subscription,status,cache_observed) VALUES(1,'s1','session','sub',200,0)`).run();
  legacy.prepare(`INSERT INTO system_events(ts,kind,identity_kind,identity_hash,backend_name) VALUES(1,'route.bind','session','hash','sub')`).run();
  legacy.close();
  const db = openDatabase(file);
  const requestRow = db.prepare('SELECT tenant, identity FROM requests').get() as { tenant: string; identity: string };
  const eventRow = db.prepare('SELECT tenant, kind FROM system_events').get() as { tenant: string; kind: string };
  assert.equal(requestRow.tenant, 'default'); // ALTER 常量默认值把旧行直接落 'default'，无需回填语句
  assert.equal(requestRow.identity, 's1'); // 行保留
  assert.equal(eventRow.tenant, 'default');
  assert.equal(eventRow.kind, 'route.bind');
  // 迁移后的亲和查询对旧行照常可用（租户维度 = default）
  const store = createSystemEventStore(db);
  assert.equal(store.affinity('default', 'session', 'no-hash'), undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateConfig rejects bad tenant declarations', () => {
  const base = {
    backends: [{ name: 'b1', family: 'ocg', base_url: 'http://127.0.0.1:1', key_env: 'K' }],
    models: [{ id: 'm', backends: { ocg: 'x' } }],
  };
  assert.ok(validateConfig({ ...base, tenants: [{ name: 'main', key_env: 'K1' }, { name: 'hermes', key_env: 'K2' }] }));
  const bad: Array<[string, unknown[]]> = [
    ['duplicate names', [{ name: 'main', key_env: 'K1' }, { name: 'main', key_env: 'K2' }]],
    ['reserved default', [{ name: 'default', key_env: 'K1' }]],
    ['missing key_env', [{ name: 'main' }]],
    ['unknown backend reference', [{ name: 'main', key_env: 'K1', backends: ['nope'] }]],
    ['unknown model reference', [{ name: 'main', key_env: 'K1', models: ['nope'] }]],
    ['empty backends subset', [{ name: 'main', key_env: 'K1', backends: [] }]],
    // review P2：字符串转换曾让非字符串元素混过校验（String(['first']) === 'first'）
    ['non-string backend element', [{ name: 'main', key_env: 'K1', backends: [['b1']] }]],
    ['non-string model element', [{ name: 'main', key_env: 'K1', models: [['m']] }]],
    ['object name', [{ name: {}, key_env: 'K1' }]],
    ['empty key_env', [{ name: 'main', key_env: '' }]],
    // review P2：两个租户共用一个 key_env = 静态凭据冲突
    ['duplicate key_env', [{ name: 'main', key_env: 'K1' }, { name: 'hermes', key_env: 'K1' }]],
  ];
  for (const [label, tenants] of bad) {
    // 校验器形态断言（函数谓词）；label 作失败信息——坏声明都必须拒启动
    assert.throws(() => validateConfig({ ...base, tenants }), (error: unknown): boolean => error instanceof Error && !(error instanceof assert.AssertionError), label);
  }
  assert.throws(() => validateConfig({ ...base, tenants: [] }));
});

test('two tenants resolving to the same key value refuse to start (credential conflict fail fast)', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tenants-conflict-'));
  // K_MAIN 与 K_HERMES 配了同一个值：authenticate 会把所有流量归给先声明的 main，hermes 被静默遮蔽——拒绝启动。
  const env = { K_MAIN: 'same-secret', K_HERMES: 'same-secret', K_UPSTREAM: 'upstream', CPR_DB_FILE: path.join(dir, 'data.db') };
  const config = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: [{ name: 'first', family: 'ocg', base_url: fake.url, key_env: 'K_UPSTREAM' }],
    tenants: [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES' }],
  } as unknown as RouterPolicy;
  assert.throws(() => createGatewayServers(config, { env, logger: { warn() {}, log() {} } }), /tenant credential conflict: main and hermes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summary dedupes sessions by (tenant, identity); identity summary without tenant matches its requests scope', async (t: TestContext): Promise<void> => {
  const { UsageAudit } = await import('../core/store/audit.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tenants-summary-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'data.db') });
  // 同一 identity 两个租户 = 两个会话（review P2：COUNT(DISTINCT identity) 曾并成一个）
  audit.record({ ts: 1, tenant: 'main', identity: 'same', identity_kind: 'session', subscription: 'sub-a', status: 200, ms: 1 }, { completion_tokens: 1, prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 5 } });
  audit.record({ ts: 2, tenant: 'hermes', identity: 'same', identity_kind: 'session', subscription: 'sub-b', status: 200, ms: 1 }, { completion_tokens: 2, prompt_tokens: 6, prompt_tokens_details: { cached_tokens: 6 } });
  assert.equal(audit.listSessions().length, 2);
  assert.equal(audit.summary().sessions, 2);
  assert.equal(audit.summary({ tenant: 'main' }).sessions, 1);
  assert.equal(audit.summary({ tenant: 'main' }).requests, 1);
  // sessionSummary 省略 tenant = 跨租户合并同 identity（与 listRequests 同范围）
  assert.equal(audit.sessionSummary('same').requests, 2);
  assert.equal(audit.sessionSummary('same', { tenant: 'hermes' }).requests, 1);
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin summary?identity= without tenant keeps summary and requests in the same scope', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startTenanted(t, [{ name: 'main', key_env: 'K_MAIN' }, { name: 'hermes', key_env: 'K_HERMES' }], [fake.url]);
  for (let i = 0; i < 3; i++) {
    await chat(app.forwardUrl, 'main-key', undefined, { 'x-session-id': 'same' });
    await chat(app.forwardUrl, 'hermes-key', undefined, { 'x-session-id': 'same' });
  }
  const payload = await fetch(`${app.adminUrl}/api/audit/summary?identity=same`).then((r) => r.json());
  // review P2：summary 曾恒查 default（0 行）而 requests 列全部租户（6 行）——两侧必须同范围
  assert.equal(payload.summary.requests, 6);
  assert.equal(payload.requests.length, 6);
  const scoped = await fetch(`${app.adminUrl}/api/audit/summary?identity=same&tenant=hermes`).then((r) => r.json());
  assert.equal(scoped.summary.requests, 3);
  assert.equal(scoped.requests.length, 3);
});
