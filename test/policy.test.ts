// Policy-as-code 契约测试：decide 语义（keep/null/覆写/撞墙/模型覆盖/错误路径）、
// 迁移记账补漏与 routing_note。配置即代码：loader 生命周期测试随 PolicyStore 退役删除。
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../lib/http/server.ts';
import type { DecisionCtx, Decision, RouterPolicy } from '../lib/policy/contract.ts';
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

test('invalid policy decisions (unknown backend / missing family map) are ignored in favor of builtin', async (t) => {
  const app = await setup(t, [ok('first'), ok('second')], () => ({ backend: 'nope' }));
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.equal(app.seen[0], 'first');
  const history = await rows(app, 's1');
  assert.match(String(history[0].routing_note), /^builtin:select->/); // 野目标回落内置
});

test('sticky-long guardrail preempts policy: a long session is not even consulted on the error path', async (t) => {
  const errorCalls: DecisionCtx[] = [];
  let firstBroken = false;
  const app = await setup(t, [
    { name: 'first', run: (_req, res) => { if (firstBroken) { res.writeHead(403).end('quota-403'); return; } res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); } },
    ok('second'),
  ], (ctx) => { if (ctx.error) { errorCalls.push(ctx); return { backend: 'second' }; } return null; }, { routing: { long_session_min_requests: 2 } });
  // 长会话：两笔成功后达到阈值 2
  assert.equal((await chat(app.url, 'long')).status, 200);
  assert.equal((await chat(app.url, 'long')).status, 200);
  firstBroken = true;
  const blocked = await chat(app.url, 'long');
  assert.equal(blocked.status, 403); // 403 原样透传
  assert.equal(await blocked.text(), 'quota-403');
  assert.deepEqual(app.seen, ['first', 'first', 'first']); // 两笔成功 + 一笔注定失败的 403；无迁移、无 second
  assert.equal(errorCalls.length, 0); // sticky-long 护栏前置：policy 不可见、不可覆写
});

test('recent health is injected per candidate from the in-memory tracker', async (t) => {
  const seenCandidates: { name: string; recent: unknown }[][] = [];
  let firstBroken = true;
  const app = await setup(t, [
    { name: 'first', run: (_req, res) => { if (firstBroken) { firstBroken = false; res.writeHead(500).end('boom'); return; } res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); } },
    ok('second'),
  ], (ctx) => { seenCandidates.push(structuredClone(ctx.candidates.map(({ name, recent }) => ({ name, recent })))); return null; });
  assert.equal((await chat(app.url, 's1')).status, 500); // first 报 500（非 403/429：直接透传并记账）
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(seenCandidates[0][0], { name: 'first', recent: undefined }); // 首次：窗口内无观察
  assert.deepEqual(seenCandidates[1][0].name, 'first');
  assert.equal((seenCandidates[1][0].recent as { fails: number; lastStatus: number }).fails, 1);
  assert.equal((seenCandidates[1][0].recent as { fails: number; lastStatus: number }).lastStatus, 500);
  assert.equal(seenCandidates[1][1].recent, undefined); // second 没有失败记录
});

test('routing.wall_retry_max_attempts=0 skips in-place retries and the error ctx carries the failed backend', async (t) => {
  const errorCalls: DecisionCtx[] = [];
  const app = await setup(t, [
    quota('first', 429),
    ok('second'),
  ], (ctx) => { if (ctx.error) { errorCalls.push(structuredClone(ctx)); return { backend: 'second' }; } return null; },
  { routing: { wall_retry_max_attempts: 0, wall_retry_max_after_ms: 2000 } });
  const response = await chat(app.url, 's1', { model: 'm' });
  assert.equal(response.status, 200);
  assert.deepEqual(app.seen, ['first', 'second']); // 0 次原地重试：一次失败直接进迁移决策
  assert.equal(errorCalls.length, 1);
  assert.deepEqual(errorCalls[0].error, { backend: 'first', status: 429, retryAfterMs: null }); // retry-after 头没给 → null
});
