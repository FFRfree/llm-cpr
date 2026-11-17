// Policy-as-code 契约测试：decide 语义（keep/null/覆写/撞墙/模型覆盖/错误路径）、
// PolicyStore 生命周期（启动拒绝、热重载保旧）、迁移记账补漏与 routing_note。
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/server.ts';
import { PolicyStore } from '../lib/policy-loader.ts';
import type { DecisionCtx, Decision, RouterPolicy } from '../lib/policy-contract.ts';
import type { AuditRow, Backend } from '../lib/contracts.ts';

const listen = async (server: http.Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: http.Server): Promise<void> => new Promise<void>((resolve) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
});
const chat = (url: string, session: string, body: Record<string, unknown> = { model: 'm' }): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify(body) });

interface Handler { name: string; run: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void; get?: () => unknown }

async function setup(t: TestContext, handlers: Handler[], decide?: (ctx: DecisionCtx) => Decision, policyExtra: Partial<RouterPolicy> = {}) {
  const seen: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const upstreams = handlers.map((handler) => http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(handler.get ? handler.get() : { accounts: [] }));
    seen.push(handler.name);
    (bodies[handler.name] ??= []).push(safeJson(body));
    handler.run(req, res, body);
  }));
  const urls = await Promise.all(upstreams.map(listen));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-policy-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), K0: 'key0', K1: 'key1', K2: 'key2' };
  const backends: Backend[] = urls.map((base_url, i) => ({ name: handlers[i].name, family: 'ocg', base_url, key_env: `K${i}`, priority: i }));
  const policy: RouterPolicy = {
    master_key_env: 'CPR_MASTER',
    backends,
    models: [{ id: 'm', backends: { ocg: 'native-m' } }, { id: 'm2', backends: { ocg: 'native-m2' } }],
    decide,
    ...policyExtra,
  };
  const gateway = createGatewayServers(policy, { env, logger: { warn() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await Promise.all(upstreams.map(close)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...gateway, url: `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`, seen, bodies, env };
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }

const ok = (name: string): Handler => ({ name, run: (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ backend: name })) });
const quota = (name: string, status: number): Handler => ({ name, run: (_req, res) => res.writeHead(status).end(`quota-${status}`) });

async function rows(gateway: { audit: { listRequests(args: { identity?: string; limit?: number }): AuditRow[] } }, identity?: string): Promise<AuditRow[]> {
  return gateway.audit.listRequests(identity ? { identity } : {});
}

test('policy keep respects the pin and is noted in the ledger; absence falls back to builtin selection', async (t) => {
  const app = await setup(t, [ok('first'), ok('second')], (ctx) => (ctx.session.pin ? 'keep' : null));
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.deepEqual(app.seen, [app.seen[0], app.seen[0]]); // 两轮同一订阅（keep 生效）
  const history = await rows(app, 's1');
  assert.equal(history.length, 2);
  assert.match(String(history[0].routing_note), /^policy:keep$/); // 最新在前：第二轮被 policy keep
  assert.match(String(history[1].routing_note), /^builtin:select->/); // 首轮 builtin 月欠账
});

test('policy per-request override migrates a pinned session and records the migration channel', async (t) => {
  const app = await setup(t, [ok('first'), ok('second')], (ctx) => (ctx.session.pin ? { backend: 'second' } : null));
  assert.equal((await chat(app.url, 's1')).status, 200); // builtin 首选 first（priority 0）
  assert.equal((await chat(app.url, 's1')).status, 200); // policy 覆写 → second
  assert.equal((await chat(app.url, 's1')).status, 200); // pin 已是 second：policy keep 等价
  assert.deepEqual(app.seen, ['first', 'second', 'second']);
  const history = await rows(app, 's1');
  assert.match(String(history[1].routing_note), /^policy:override->second$/);
});

test('policy may pin a walled backend; builtin still filters walled candidates', async (t) => {
  // 撞墙状态走 provider 正常解析路径（proxy usage 载荷），避免与快照轮询器的写入赛跑。
  const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
  const usage = (rolling: number): unknown => ({
    accounts: [{ name: 'first', month_progress: 50, usage: { monthly_percent: 30, rolling_percent: rolling, weekly_percent: 10,
      rolling_resets_at: iso(3_600_000), weekly_resets_at: iso(3 * 24 * 3_600_000), monthly_resets_at: iso(20 * 24 * 3_600_000) } }],
  });
  const app = await setup(t, [
    { ...ok('first'), get: () => usage(100) }, // first 撞 5h 窗口
    { ...ok('second'), get: () => usage(5) },
  ], (ctx) => (ctx.request.model === 'm2' ? { backend: 'first' } : null));
  assert.equal((await chat(app.url, 'pin-walled', { model: 'm2' })).status, 200); // policy 钉死撞墙者
  assert.equal((await chat(app.url, 'builtin-path')).status, 200); // builtin 过滤撞墙者 → second
  assert.deepEqual(app.seen, ['first', 'second']);
});

test('policy model override rewrites translation while the ledger keeps the requested id', async (t) => {
  const app = await setup(t, [ok('first')], (ctx) => (ctx.request.model === 'm' ? { backend: 'first', model: 'm2' } : null));
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.equal((app.bodies['first'][0] as { model: string }).model, 'native-m2'); // 上游收到生效模型的家族名
  const history = await rows(app, 's1');
  assert.equal(history[0].model, 'm'); // 客户端请求的真名
  assert.equal(history[0].translated_model, 'native-m2');
  assert.match(String(history[0].routing_note), /model->m2$/);
});

test('policy keep on quota error passes the error through without migration, even for short sessions', async (t) => {
  const app = await setup(t, [quota('first', 403), ok('second')], (ctx) => (ctx.error ? 'keep' : null));
  const response = await chat(app.url, 's1');
  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'quota-403');
  assert.deepEqual(app.seen, ['first']); // policy keep 压过了内置的短会话迁移
  const history = await rows(app, 's1');
  assert.match(String(history[0].routing_note), /policy:keep$/);
});

test('policy picks the migration target on quota error and the failed attempt lands in the ledger', async (t) => {
  const app = await setup(t, [quota('first', 403), ok('second'), ok('third')], (ctx) => (ctx.error ? { backend: 'third' } : null));
  const response = await chat(app.url, 's1');
  assert.equal(response.status, 200);
  assert.deepEqual(app.seen, ['first', 'third']);
  const history = await rows(app, 's1');
  assert.equal(history.length, 2); // 失败笔不再被 continue 跳过
  assert.equal(history[1].status, 403);
  assert.match(String(history[1].routing_note), /policy:migrate->third$/);
  assert.equal(history[0].subscription, 'third');
  assert.match(String(history[0].routing_note), /policy:migrate->third$/);
});

test('builtin migration still records the failed attempt with its note', async (t) => {
  const app = await setup(t, [quota('first', 403), ok('second')]); // 无 decide：纯内置
  assert.equal((await chat(app.url, 's1')).status, 200);
  const history = await rows(app, 's1');
  assert.equal(history.length, 2);
  assert.equal(history[1].status, 403);
  assert.match(String(history[1].routing_note), /builtin:migrate->second$/);
  assert.match(String(history[0].routing_note), /builtin:migrate->second$/);
});

test('decide throwing on the error path falls back to builtin migration', async (t) => {
  const app = await setup(t, [quota('first', 403), ok('second')], (ctx) => { if (ctx.error) throw new Error('boom'); return null; });
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.deepEqual(app.seen, ['first', 'second']);
});

test('admin GET /api/policy reports the active policy source and version', async (t) => {
  const app = await setup(t, [ok('first')]);
  const admin = `http://127.0.0.1:${(app.adminServer.address() as import('node:net').AddressInfo).port}`;
  const meta = await (await fetch(`${admin}/api/policy`)).json();
  assert.equal(meta.source, 'static');
  assert.equal(meta.lastError, null);
});

test('invalid policy decisions (unknown backend / missing family map) are ignored in favor of builtin', async (t) => {
  const app = await setup(t, [ok('first'), ok('second')], () => ({ backend: 'nope' }));
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.equal(app.seen[0], 'first');
  const history = await rows(app, 's1');
  assert.match(String(history[0].routing_note), /^builtin:select->/); // 野目标回落内置
});

test('PolicyStore: boot with a broken policy file refuses to load; later breakage keeps the previous instance', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-policy-store-'));
  const file = path.join(dir, 'policy.ts');
  const write = (content: string, tick: number): void => {
    fs.writeFileSync(file, content);
    const at = new Date(Date.now() + tick * 1000);
    fs.utimesSync(file, at, at); // 强制 mtime 变化，绕开文件系统时间戳精度
  };
  write(`export default class { backends = [{ name: 'only', family: 'ocg', base_url: 'http://127.0.0.1:9', key_env: 'K' }]; models = [{ id: 'm', backends: { ocg: 'x' } }]; }`, 1);
  const store = new PolicyStore({ file });
  const first = await store.current();
  assert.equal(first.backends[0].name, 'only');
  // 热重载失败：语法/校验错误 → 保留旧实例，lastError 记证词
  write(`export default class (`, 2);
  const kept = await store.current();
  assert.equal(kept, first);
  assert.ok(store.meta().lastError !== null); // 具体报错文案是 Node 解析器的，只断言有证词
  // 修好并改声明 → 新实例生效
  write(`export default class { backends = [{ name: 'a', family: 'ocg', base_url: 'http://127.0.0.1:9', key_env: 'K' }, { name: 'b', family: 'ocg', base_url: 'http://127.0.0.1:9', key_env: 'K' }]; models = [{ id: 'm', backends: { ocg: 'x' } }]; }`, 3);
  const next = await store.current();
  assert.equal(next.backends.length, 2);
  assert.equal(store.meta().lastError, null);
  assert.ok(store.meta().mtimeMs !== null);
  // 非法声明（缺 backends）→ 启动语义：未加载过就拒绝；已加载过则保旧
  write(`export default class { models = [{ id: 'm', backends: { ocg: 'x' } }]; }`, 4);
  assert.equal(await store.current(), next);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('PolicyStore: first load of a missing file rejects (refuse to start)', async () => {
  const store = new PolicyStore({ file: '/nonexistent/cpr-policy-test-does-not-exist.ts' });
  await assert.rejects(store.current(), /policy file unavailable/);
});
