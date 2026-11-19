// 观测层正文捕获（observability 票 01）：内容寻址还原逐字节一致、跨轮去重、租户级 opt-in
// （未 opt-in 不落侧库）、TTL 清理判引用、超限跳过、形状不符不猜、降级不阻塞转发、
// 账本 capture_id 锚点、加法迁移、validateConfig 坏声明拒启动、读侧管理口端点。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../core/http/server.ts';
import { CaptureStore } from '../core/store/capture.ts';
import { chatCompletionsItems } from '../core/protocols/items.ts';
import { runMigrations } from '../core/store/migrate.ts';
import { openDatabase } from '../core/store/db.ts';
import { validateConfig } from '../core/policy/config.ts';
import type { TestContext } from 'node:test';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StatementSync } from 'node:sqlite';
import type { Backend, Tenant } from '../core/contracts.ts';
import type { RouterPolicy } from '../core/policy/contract.ts';

const listen = async (server: Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));
const SALT = 'ab'.repeat(32);

interface Seen { name: string; body: string }
async function fakeBackend(name: string, seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    if (req.method === 'POST') seen.push({ name, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ backend: name }));
  });
  return { server, url: await listen(server) };
}

const backendsOf = (urls: string[]): Backend[] => urls.map((url, index) => ({ name: index === 0 ? 'first' : 'second', family: 'ocg', base_url: url, key_env: 'K_UPSTREAM', priority: index }));

interface GatewayHandle { gateway: ReturnType<typeof createGatewayServers>; forwardUrl: string; adminUrl: string; dbPath: string; dir: string; captureDb: string }

async function startGateway(t: TestContext, tenants: Tenant[] | undefined, backendUrls: string[], envExtra: Record<string, string> = {}, capture?: RouterPolicy['capture']): Promise<GatewayHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-capture-'));
  const dbPath = path.join(dir, 'data.db');
  const env: Record<string, string> = { K_MAIN: 'main-key', K_HERMES: 'hermes-key', K_UPSTREAM: 'upstream', CPR_MASTER_KEY: 'main-key', CPR_DB_FILE: dbPath, CPR_CAPTURE_SALT: SALT, ...envExtra };
  const config = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: backendsOf(backendUrls),
    ...(tenants ? { tenants } : {}),
    ...(capture ? { capture } : {}),
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
    captureDb: env.CPR_CAPTURE_DB_FILE ?? path.join(dir, 'capture.db'),
  };
}

const chat = (url: string, key: string, rawBody: string, extraHeaders: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders }, body: rawBody });

// 捕获写盘走 250ms 异步定时器：等它落完再断言库面/管理口。
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 400); });

const countOf = (db: DatabaseSync, sql: string, ...args: unknown[]): number => Number((db.prepare(sql).get(...(args as Parameters<StatementSync['get']>)) as { n: number | bigint }).n);

test('capture roundtrip: restore is byte-identical, content dedups across turns, capture_id anchors ledger rows', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startGateway(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  // 键序故意让 messages 不在最前（还原须保留原键序）；unicode 与小数直过 stringify。
  const rawA = JSON.stringify({ temperature: 0.5, model: 'm', messages: [{ role: 'system', content: 'sys-prompt 固定' }, { role: 'user', content: '你好 𝄞' }] });
  const rawB = JSON.stringify({ temperature: 0.5, model: 'm', messages: [
    { role: 'system', content: 'sys-prompt 固定' },
    { role: 'user', content: '你好 𝄞' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file body' },
  ] });
  assert.equal((await chat(app.forwardUrl, 'main-key', rawA, { 'x-session-id': 'sess-a' })).status, 200);
  assert.equal((await chat(app.forwardUrl, 'main-key', rawB, { 'x-session-id': 'sess-a' })).status, 200);
  await settle();

  const capture = new DatabaseSync(app.captureDb, { readOnly: true });
  // 两轮 6 条消息（A 2 条 + B 4 条），system 与 user 重复重发 → 正文只存 4 份唯一内容。
  assert.equal(countOf(capture, 'SELECT COUNT(*) AS n FROM turns'), 2);
  assert.equal(countOf(capture, 'SELECT COUNT(*) AS n FROM content'), 4);
  // 还原逐字节一致（两边同走 parse→stringify，键序/值必须完全一致）。
  for (const [raw, [id]] of [[rawA, [1]], [rawB, [2]]] as const) {
    const detail = await fetch(`${app.adminUrl}/api/capture/turns/${id}`).then((r) => { assert.equal(r.status, 200); return r.json(); }) as { turn: { capture_id: string }; body: unknown };
    assert.equal(JSON.stringify(detail.body), JSON.stringify(JSON.parse(raw)));
    assert.equal(detail.turn.capture_id.length, 36);
  }
  capture.close();

  // 账本锚点：每轮账本行 capture_id 与 capture.db turns 对上（1:N：改绑重试共用同一轮）。
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  const rows = db.prepare('SELECT capture_id FROM requests ORDER BY id').all() as Array<{ capture_id: string | null }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => typeof row.capture_id === 'string' && row.capture_id.length === 36));
  const turnIds = new Set((new DatabaseSync(app.captureDb, { readOnly: true }).prepare('SELECT capture_id FROM turns').all() as Array<{ capture_id: string }>).map((row) => row.capture_id));
  assert.ok(rows.every((row) => row.capture_id !== null && turnIds.has(row.capture_id)));
  db.close();
  // 清单端点：租户/身份过滤。
  const turns = await fetch(`${app.adminUrl}/api/capture/turns?identity=sess-a`).then((r) => r.json()) as { turns: Array<{ id: number }> };
  assert.equal(turns.turns.length, 2);
  const status = await fetch(`${app.adminUrl}/api/capture/status`).then((r) => r.json()) as { turns: number; contents: number; degraded: boolean };
  assert.deepEqual({ turns: status.turns, contents: status.contents, degraded: status.degraded }, { turns: 2, contents: 4, degraded: false });
  // 盐文件与正文同目录、0600。
  assert.equal(fs.statSync(path.join(path.dirname(app.captureDb), 'capture-salt.txt')).mode & 0o777, 0o600);
});

test('opt-in per tenant: non-capture tenant leaves nothing; gateway without capture never creates capture.db', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startGateway(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }, { name: 'hermes', key_env: 'K_HERMES' }], [fake.url]);
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await chat(app.forwardUrl, 'main-key', body, { 'x-session-id': 'm1' })).status, 200);
  assert.equal((await chat(app.forwardUrl, 'hermes-key', body, { 'x-session-id': 'h1' })).status, 200);
  await settle();
  const capture = new DatabaseSync(app.captureDb, { readOnly: true });
  const tenantRows = capture.prepare('SELECT tenant FROM turns ORDER BY id').all() as Array<{ tenant: string }>;
  assert.deepEqual(tenantRows.map((row) => row.tenant), ['main']);
  capture.close();
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  const rows = db.prepare('SELECT tenant, capture_id FROM requests ORDER BY id').all() as Array<{ tenant: string; capture_id: string | null }>;
  assert.deepEqual(rows.map((row) => [row.tenant, row.capture_id === null]), [['main', false], ['hermes', true]]);
  db.close();
});

test('no capture anywhere: forwarding unchanged, no capture.db file on disk, admin reads are empty', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startGateway(t, undefined, [fake.url]);
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))).status, 200);
  assert.equal(gatewayCaptureNull(app), true);
  assert.equal(fs.existsSync(app.captureDb), false);
  const turns = await fetch(`${app.adminUrl}/api/capture/turns`).then((r) => r.json());
  assert.deepEqual(turns, { turns: [] });
  const status = await fetch(`${app.adminUrl}/api/capture/status`).then((r) => r.json()) as { enabled: boolean };
  assert.equal(status.enabled, false);
  assert.equal((await fetch(`${app.adminUrl}/api/capture/turns/1`)).status, 404);
});
function gatewayCaptureNull(app: GatewayHandle): boolean { return app.gateway.capture === null; }

test('capture TTL sweep deletes expired turns and unreferenced content, keeps still-referenced content', async (t: TestContext): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-capture-sweep-'));
  const store = new CaptureStore({ dbFile: path.join(dir, 'capture.db'), ttlDays: 1, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  const systemMessage = { role: 'system', content: 'shared-system' };
  const a = store.capture({ tenant: 't', identity: 'i', identityKind: 'session', model: 'm', body: { model: 'm', messages: [systemMessage, { role: 'user', content: 'old turn' }] }, rawBytes: 100 });
  const b = store.capture({ tenant: 't', identity: 'i', identityKind: 'session', model: 'm', body: { model: 'm', messages: [systemMessage, { role: 'user', content: 'new turn' }] }, rawBytes: 100 });
  assert.notEqual(a.captureId, null); assert.notEqual(b.captureId, null);
  store.sweepNow(); // 落盘
  let db = new DatabaseSync(path.join(dir, 'capture.db'));
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM turns'), 2);
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM content'), 3); // system 共享一份
  // turn A 过期、turn B 未过期：A 删、B 留，system 正文仍被 B 引用不删。
  db.exec('BEGIN'); db.prepare('UPDATE turns SET ts = ? WHERE capture_id = ?').run(Date.now() - 2 * 86_400_000, a.captureId); db.exec('COMMIT');
  db.close();
  store.sweepNow();
  db = new DatabaseSync(path.join(dir, 'capture.db'), { readOnly: true });
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM turns'), 1);
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM content'), 2);
  db.close();
  // 全部过期：turns 清空后 system 正文失去引用，一并回收。
  db = new DatabaseSync(path.join(dir, 'capture.db'));
  db.exec('BEGIN'); db.prepare('UPDATE turns SET ts = ?').run(Date.now() - 2 * 86_400_000); db.exec('COMMIT');
  db.close();
  store.sweepNow();
  db = new DatabaseSync(path.join(dir, 'capture.db'), { readOnly: true });
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM turns'), 0);
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM content'), 0);
  db.close();
  store.close();
});

test('oversize skip: body over capture.max_body_bytes is forwarded but not captured', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startGateway(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url], {}, { max_body_bytes: 100 });
  const big = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(500) }] });
  assert.equal((await chat(app.forwardUrl, 'main-key', big)).status, 200);
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'small' }] }))).status, 200);
  await settle();
  const capture = new DatabaseSync(app.captureDb, { readOnly: true });
  assert.equal(countOf(capture, 'SELECT COUNT(*) AS n FROM turns'), 1);
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  const rows = db.prepare('SELECT capture_id FROM requests ORDER BY id').all() as Array<{ capture_id: string | null }>;
  assert.deepEqual(rows.map((row) => row.capture_id === null), [true, false]);
  db.close();
  capture.close();
});

test('shape guard: bodies without well-formed messages are forwarded but never captured (no guessing)', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await startGateway(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm' }))).status, 200); // 无 messages
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ content: 'no role' }] }))).status, 200); // 消息缺 role
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ok' }] }))).status, 200);
  await settle();
  const capture = new DatabaseSync(app.captureDb, { readOnly: true });
  assert.equal(countOf(capture, 'SELECT COUNT(*) AS n FROM turns'), 1);
  capture.close();
});

test('capture degrade: failed flush latches, drops the turn, forwarding and ledger stay unaffected', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-capture-broken-'));
  const captureDb = path.join(dir, 'capture.db');
  // 预建侧库 + 拒写触发器（账本降级测试同款手段）：turns 插入永远 ABORT。
  const seeded = new DatabaseSync(captureDb);
  seeded.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, tenant TEXT NOT NULL, identity TEXT, identity_kind TEXT NOT NULL, model TEXT, message_count INTEGER NOT NULL, bytes INTEGER NOT NULL, refs TEXT NOT NULL, meta TEXT NOT NULL, response_refs TEXT);
    CREATE TABLE content (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, body TEXT NOT NULL, first_seen INTEGER NOT NULL);
    CREATE TRIGGER refuse_turns BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'capture-insert-blocked'); END;`);
  seeded.close();
  const app = await startGateway(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url], { CPR_CAPTURE_DB_FILE: captureDb });
  assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))).status, 200);
  await settle();
  const status = await fetch(`${app.adminUrl}/api/capture/status`).then((r) => r.json()) as { degraded: boolean; dropped: number; turns: number };
  assert.equal(status.degraded, true);
  assert.ok(status.dropped >= 1);
  assert.equal(status.turns, 0);
  // 转发与账本不受连累：账本行照落（capture_id 指向的 turn 缺行 = 不可宣称完整）。
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  assert.equal(countOf(db, 'SELECT COUNT(*) AS n FROM requests'), 1);
  db.close();
});

test('requests.capture_id is an additive migration: old schema gains the column, rows survive', (t: TestContext): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-capture-migrate-'));
  const dbFile = path.join(dir, 'data.db');
  const old = new DatabaseSync(dbFile);
  old.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, identity_kind TEXT NOT NULL, subscription TEXT, account TEXT, model TEXT, translated_model TEXT, path TEXT, status INTEGER, ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER, cache_observed INTEGER NOT NULL DEFAULT 0, cache_outcome TEXT, ttft_ms INTEGER, stream_ms INTEGER, usage_json TEXT);
    CREATE TABLE system_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, identity_kind TEXT, identity_hash TEXT, backend_name TEXT, request_id INTEGER, detail TEXT);
    INSERT INTO requests(ts, identity_kind) VALUES(1, 'session');`);
  old.close();
  const db = openDatabase(dbFile, { baseline: false });
  const result = runMigrations(db, { dbFile });
  assert.equal(result.status, 'upgraded');
  const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
  assert.equal(columns.has('capture_id'), true);
  const row = db.prepare('SELECT ts, capture_id FROM requests').get() as { ts: number; capture_id: string | null };
  assert.equal(row.ts, 1);
  assert.equal(row.capture_id, null);
  db.close();
});

test('validateConfig: capture knobs must be boolean/numbers, bad shapes refuse to start', (): void => {
  assert.throws(() => validateConfig({ backends: [{ name: 'b', family: 'ocg', base_url: 'https://x', key_env: 'K' }], models: [{ id: 'm', backends: { ocg: 'x' } }], tenants: [{ name: 'main', key_env: 'K', capture: 'yes' }] }), /capture must be a boolean/);
  assert.throws(() => validateConfig({ backends: [{ name: 'b', family: 'ocg', base_url: 'https://x', key_env: 'K' }], models: [{ id: 'm', backends: { ocg: 'x' } }], capture: { ttl_days: -1 } }), /ttl_days must be a non-negative finite number/);
  assert.throws(() => validateConfig({ backends: [{ name: 'b', family: 'ocg', base_url: 'https://x', key_env: 'K' }], models: [{ id: 'm', backends: { ocg: 'x' } }], capture: 'on' }), /capture must be an object/);
  // 合法形态不拒：租户 capture + 全局参数。
  validateConfig({ backends: [{ name: 'b', family: 'ocg', base_url: 'https://x', key_env: 'K' }], models: [{ id: 'm', backends: { ocg: 'x' } }], tenants: [{ name: 'main', key_env: 'K', capture: true }], capture: { ttl_days: 0, max_body_bytes: 0 } });
});

test('chat-completions item model: kinds, tool names, cache hints, meta key order', (): void => {
  const normalized = chatCompletionsItems({ temperature: 1, model: 'm', messages: [
    { role: 'system', content: 's', prompt_cache_breakpoint: true },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'r' },
  ] });
  assert.ok(normalized);
  assert.deepEqual(normalized.items.map((item) => [item.kind, item.role, item.tool_calls, item.cache_hint]), [
    ['message', 'system', undefined, true],
    ['message', 'assistant', ['run'], undefined],
    ['tool_result', 'tool', undefined, undefined],
  ]);
  // meta 保留原键序、messages 占位空数组（还原回填后 stringify 与原 body 同序）。
  assert.deepEqual(Object.keys(JSON.parse(normalized.meta)), ['temperature', 'model', 'messages']);
  assert.deepEqual(JSON.parse(normalized.meta).messages, []);
  assert.equal(chatCompletionsItems({ model: 'm' }), null);
  assert.equal(chatCompletionsItems({ model: 'm', messages: [] }), null);
  assert.equal(chatCompletionsItems({ model: 'm', messages: ['nope'] }), null);
});
