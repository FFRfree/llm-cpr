// 观测层票 03/04/05 的 e2e：泄漏扫描（规则/白名单/增量去重/不落原文）、缓存取证链、
// 工具分析聚合与卡住检测、管理口端点。真密钥一律用合成样例（公开文档的标准示例形态）。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServers } from '../core/http/server.ts';
import { scanForLeaks } from '../core/observability/leaks.ts';
import type { TestContext } from 'node:test';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Backend, Tenant } from '../core/contracts.ts';
import type { RouterPolicy } from '../core/policy/contract.ts';

const listen = async (server: Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));
const SALT = 'ab'.repeat(32);
// 公开文档的标准合成样例（非真实凭据）。
const SYNTH_AWS = 'AKIAIOSFODNN7EXAMPLE';
const SYNTH_OPENAI = 'sk-synthetic0123456789abcdefgh';
const SYNTH_STRANGER = 'sk-notallowlisted0123456789xyz';

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

async function start(t: TestContext, tenants: Tenant[], backendUrls: string[], envExtra: Record<string, string> = {}, capture?: RouterPolicy['capture']): Promise<GatewayHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-obs-'));
  const dbPath = path.join(dir, 'data.db');
  const env: Record<string, string> = { K_MAIN: 'main-key', K_HERMES: 'hermes-key', K_UPSTREAM: 'upstream', CPR_MASTER_KEY: 'main-key', CPR_DB_FILE: dbPath, CPR_CAPTURE_SALT: SALT, ...envExtra };
  const config = {
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
    backends: backendsOf(backendUrls),
    tenants,
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
    captureDb: path.join(dir, 'capture.db'),
  };
}

const chat = (url: string, key: string, rawBody: string, extraHeaders: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders }, body: rawBody });
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 400); });
const countOf = (db: DatabaseSync, sql: string, ...args: unknown[]): number => Number((db.prepare(sql).get(...(args as never[])) as { n: number | bigint }).n);

test('leak scan: synthetic keys in body produce privacy.hit events with no raw text ever stored', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  const leaky = JSON.stringify({ model: 'm', messages: [
    { role: 'system', content: 'helper prompt' },
    { role: 'user', content: `aws key ${SYNTH_AWS} and openai key ${SYNTH_OPENAI}` },
  ] });
  assert.equal((await chat(app.forwardUrl, 'main-key', leaky, { 'x-session-id': 'leak-1' })).status, 200);
  await settle();
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  const events = db.prepare("SELECT tenant, kind, identity_hash, detail FROM system_events WHERE kind='privacy.hit' ORDER BY id").all() as Array<{ tenant: string; kind: string; identity_hash: string; detail: string }>;
  assert.ok(events.length >= 2); // aws + openai 各一次
  for (const event of events) {
    const detail = JSON.parse(event.detail) as Record<string, unknown>;
    assert.equal(event.tenant, 'main');
    assert.equal(typeof detail.item_hash, 'string');
    assert.equal(typeof detail.capture_id, 'string');
    assert.ok(['aws-access-key', 'openai-style-key'].includes(String(detail.rule)), `rule=${detail.rule}`);
    // 红线：事件与 detail 里绝不出现命中原文。
    assert.ok(!event.detail.includes(SYNTH_AWS));
    assert.ok(!event.detail.includes(SYNTH_OPENAI));
  }
  // 同消息重发：增量扫描跳过，不再重复报警。
  assert.equal((await chat(app.forwardUrl, 'main-key', leaky, { 'x-session-id': 'leak-1' })).status, 200);
  await settle();
  assert.equal(countOf(db, "SELECT COUNT(*) AS n FROM system_events WHERE kind='privacy.hit'"), events.length);
  db.close();
});

test('leak whitelist: gateway-owned keys and user extra_allow never alarm', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  // 订阅 key_env 的真实值 = 合成 AWS key → 它出现在正文里不该报警；master key 经租户声明进白名单。
  const app = await start(t, [{ name: 'main', key_env: 'CPR_MASTER_KEY', capture: true }], [fake.url],
    { K_UPSTREAM: SYNTH_AWS, CPR_MASTER_KEY: SYNTH_OPENAI }, { privacy: { extra_allow: ['TESTKEY-12345'] } });
  const body = JSON.stringify({ model: 'm', messages: [
    { role: 'user', content: `config uses ${SYNTH_AWS} and ${SYNTH_OPENAI} and api_key = "TESTKEY-1234567890abcdef" here` },
  ] });
  assert.equal((await chat(app.forwardUrl, SYNTH_OPENAI, body)).status, 200);
  await settle();
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  assert.equal(countOf(db, "SELECT COUNT(*) AS n FROM system_events WHERE kind='privacy.hit'"), 0);
  db.close();
  // 非白名单命中照常报警（对照）。
  const stranger = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `leak ${SYNTH_STRANGER}` }] });
  assert.equal((await chat(app.forwardUrl, SYNTH_OPENAI, stranger)).status, 200);
  await settle();
  const db2 = new DatabaseSync(app.dbPath, { readOnly: true });
  assert.equal(countOf(db2, "SELECT COUNT(*) AS n FROM system_events WHERE kind='privacy.hit'"), 1);
  db2.close();
});

test('cache forensics: chain reports common prefix, first divergence position and role', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  const sysA = 'system prompt A';
  const sysB = 'system prompt B (changed)';
  const send = (messages: Array<{ role: string; content: string }>): Promise<Response> =>
    chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages }), { 'x-session-id': 'cache-1' });
  assert.equal((await send([{ role: 'system', content: sysA }, { role: 'user', content: 'q1' }])).status, 200);
  assert.equal((await send([{ role: 'system', content: sysA }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }])).status, 200);
  assert.equal((await send([{ role: 'system', content: sysB }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }])).status, 200);
  await settle();
  const forensics = await fetch(`${app.adminUrl}/api/capture/cache-forensics?tenant=main&identity=cache-1`).then((r) => r.json()) as { chain: Array<{ id: number; common_prefix: number; first_diff_index: number | null; first_diff_role: string | null; chars_delta: number | null; prev_message_count: number | null }>; rebinds: unknown[] };
  assert.equal(forensics.chain.length, 3);
  const [, second, third] = forensics.chain;
  // 第二轮在前缀上追加：common=2，分歧位置 2，角色 user。
  assert.equal(second.common_prefix, 2);
  assert.equal(second.first_diff_index, 2);
  assert.equal(second.first_diff_role, 'user');
  // 第三轮改了 system：common=0，分歧位置 0，角色 system（「哪条先变」落到具体消息）。
  assert.equal(third.common_prefix, 0);
  assert.equal(third.first_diff_index, 0);
  assert.equal(third.first_diff_role, 'system');
  assert.ok(Array.isArray(forensics.rebinds));
  // 缺 identity 参数 → 400。
  assert.equal((await fetch(`${app.adminUrl}/api/capture/cache-forensics?tenant=main`)).status, 400);
});

test('cache forensics limit is enforced in SQL and returns the LATEST turns in ascending order (review P1 regression)', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  for (const q of ['q1', 'q2', 'q3', 'q4']) {
    assert.equal((await chat(app.forwardUrl, 'main-key', JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: q }] }), { 'x-session-id': 'chain-limit' })).status, 200);
  }
  await settle();
  const forensics = await fetch(`${app.adminUrl}/api/capture/cache-forensics?tenant=main&identity=chain-limit&limit=3`).then((r) => r.json()) as { chain: Array<{ id: number; prev_id: number | null }> };
  assert.equal(forensics.chain.length, 3);
  // 最新 3 轮（丢最旧一轮）且升序：首条 prev 为 null（它前面那轮不在窗口里）。
  assert.equal(forensics.chain[0].prev_id, null);
  assert.ok(forensics.chain[0].id < forensics.chain[1].id && forensics.chain[1].id < forensics.chain[2].id);
  assert.equal(forensics.chain[1].prev_id, forensics.chain[0].id);
});

test('tool stats keeps the NEWEST turns when truncating and reports coverage honestly (review P2 regression)', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  for (const [index, name] of ['early_tool', ...Array(10).fill('late_tool')].entries()) {
    const raw = JSON.stringify({ model: 'm', messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'r' },
    ] });
    assert.equal((await chat(app.forwardUrl, 'main-key', raw, { 'x-session-id': 'tools-cap' })).status, 200);
    void index;
  }
  await settle();
  const stats = await fetch(`${app.adminUrl}/api/capture/tools?tenant=main&max_turns=10`).then((r) => r.json()) as { turns_scanned: number; turns_truncated: boolean; covered_since: number | null; tools: Array<{ tool: string; calls: number }> };
  assert.equal(stats.turns_scanned, 10);
  assert.equal(stats.turns_truncated, true);
  assert.ok(stats.covered_since !== null);
  // 截断保留的是最新两轮：late_tool 在、early_tool 不在。
  assert.deepEqual(stats.tools.map((entry) => entry.tool), ['late_tool']);
});

test('tool analytics: calls, error rate, context bulk ranking and stuck-loop candidates', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  const turn = (user: string, toolCalls: Array<{ id: string; name: string; args: string }>, results: Array<{ id: string; content: string }>): string =>
    JSON.stringify({ model: 'm', messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: user },
      { role: 'assistant', content: null, tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) },
      ...results.map((result) => ({ role: 'tool', tool_call_id: result.id, content: result.content })),
    ] });
  // read_file 三连同参数（卡住候选），其中一轮报错；search_web 单次大结果（灌上下文排行）。
  const same = 'do_thing';
  for (const content of ['ok result', '{"error":"boom"}', 'Error: still failing']) {
    const raw = turn('go', [{ id: 'c1', name: 'read_file', args: `{"path":"${same}"}` }], [{ id: 'c1', content }]);
    assert.equal((await chat(app.forwardUrl, 'main-key', raw, { 'x-session-id': 'tool-1' })).status, 200);
  }
  const big = 'x'.repeat(3500);
  assert.equal((await chat(app.forwardUrl, 'main-key', turn('search', [{ id: 'c9', name: 'search_web', args: '{"q":"x"}' }], [{ id: 'c9', content: big }]), { 'x-session-id': 'tool-2' })).status, 200);
  await settle();
  const stats = await fetch(`${app.adminUrl}/api/capture/tools?tenant=main&days=7`).then((r) => r.json()) as { tools: Array<{ tool: string; calls: number; results?: number; errors: number; error_rate: number | null; result_chars: number; result_tokens_est: number }>; loops: Array<{ identity: string; tool: string; streak: number }>; by_session: Array<{ scope: string; tool: string; chars: number }>; turns_scanned: number };
  const readFile = stats.tools.find((entry) => entry.tool === 'read_file');
  assert.ok(readFile);
  assert.equal(readFile.calls, 3);
  assert.equal(readFile.results, 3);
  assert.equal(readFile.errors, 2);
  assert.ok(readFile.error_rate !== null && Math.abs(readFile.error_rate - 2 / 3) < 1e-9);
  const search = stats.tools.find((entry) => entry.tool === 'search_web');
  assert.ok(search);
  assert.equal(search.result_chars, 3500);
  assert.equal(search.result_tokens_est, 1000); // 3.5 字符/token 折算
  assert.equal(stats.tools[0].tool, 'search_web'); // 灌 token 排行以 search_web 居首
  const loop = stats.loops.find((entry) => entry.identity === 'tool-1' && entry.tool === 'read_file');
  assert.ok(loop && loop.streak >= 3);
  assert.ok(stats.by_session.some((entry) => entry.scope === 'tool-2' && entry.tool === 'search_web' && entry.chars === 3500));
  assert.equal(stats.turns_scanned, 4);
});

test('privacy endpoint correlates hits to the introducing turn without exposing content', async (t: TestContext): Promise<void> => {
  const fake = await fakeBackend('first', []);
  t.after(async () => await close(fake.server));
  const app = await start(t, [{ name: 'main', key_env: 'K_MAIN', capture: true }], [fake.url]);
  const leaky = (q: string): string => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `${q} ${SYNTH_AWS}` }] });
  assert.equal((await chat(app.forwardUrl, 'main-key', leaky('q1'), { 'x-session-id': 'p-1' })).status, 200);
  assert.equal((await chat(app.forwardUrl, 'main-key', leaky('q2'), { 'x-session-id': 'p-1' })).status, 200);
  await settle();
  const data = await fetch(`${app.adminUrl}/api/capture/privacy?tenant=main`).then((r) => r.json()) as { hits: Array<{ rule: string; message_index: number; role: string; hit_turn: { identity: string } | null; first_seen_turn: { identity: string } | null }> };
  assert.ok(data.hits.length >= 1);
  const hit = data.hits.find((entry) => entry.rule === 'aws-access-key');
  assert.ok(hit);
  assert.equal(hit.message_index, 0);
  assert.equal(hit.role, 'user');
  assert.equal(hit.hit_turn?.identity, 'p-1');
  assert.equal(hit.first_seen_turn?.identity, 'p-1'); // 「哪一轮吸进来的」
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes(SYNTH_AWS));
});

test('leak scanner budget: 1 MB of code-like text scans well within parse-order cost', (t: TestContext): void => {
  const chunk = 'const handler = (req) => { return db.query("SELECT 1"); }; // code line padding \n';
  const text = chunk.repeat(Math.ceil(1024 * 1024 / chunk.length));
  const started = Date.now();
  const hits = scanForLeaks(text);
  const elapsed = Date.now() - started;
  assert.equal(hits.length, 0);
  assert.ok(elapsed < 500, `scan of 1MB took ${elapsed}ms`);
  console.log(`[capture] leak scan budget: 1MB in ${elapsed}ms (parse 口径 ~1.5ms/MB)`);
});

test('scanForLeaks unit: known formats hit, low-entropy assignments stay silent', (): void => {
  assert.deepEqual(scanForLeaks(`key ${SYNTH_AWS} end`).map((hit) => hit.rule), ['aws-access-key']);
  assert.deepEqual(scanForLeaks('token = "ghp_" + "a".repeat(4)').map((hit) => hit.rule), []);
  assert.ok(scanForLeaks('-----BEGIN RSA PRIVATE KEY-----').some((hit) => hit.rule === 'private-key-block'));
  assert.deepEqual(scanForLeaks('const retries = 3; // no secrets here').length, 0);
});
