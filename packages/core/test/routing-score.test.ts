import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Backend, ChatBody, Environment, GatewayConfig, Logger, QuotaSnapshot, QuotaWindow } from '../core/contracts.ts';
import type { Gateway } from '../core/http/server.ts';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../core/http/server.ts';
import { selectBackend, rankBackends, monthlyDebtScore } from '../core/policy/selection.ts';
import { UsageSnapshots } from '../core/store/snapshots.ts';

interface ObservedSnapshot extends QuotaSnapshot { fiveHour: QuotaWindow; weekly: QuotaWindow }
interface ForwardedChat { model: string }
interface ReceivedChat {
  name: string;
  path: string | undefined;
  session: string | string[] | undefined;
  body: ForwardedChat;
}
interface ErrorResponse { error: { message: string } }
const start = async (server: Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server): Promise<void | Error> => new Promise<void | Error>((resolve) => server.close(resolve));
const launchGateway = async (config: GatewayConfig, env: Environment, logger: Logger = { warn() {} }): Promise<Gateway> => {
  const gateway = createGatewayServers(config, { env, logger });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  return gateway;
};
const chat = (gateway: Gateway, body: ChatBody = { model: 'm' }): Promise<Response> => fetch(`http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json' }, body: JSON.stringify(body) });

// e2e 夹具的日期必须相对真实时间生成：网关按真实时钟运行，写死的 resetsAt/periodEnd 一旦过期，
// 快照会被标为「过期/未知」、排序降级为 priority 兜底，测试就在到期当天集体爆掉
// （2026-11-17 rolling 过期导致 OCG 直连 e2e 失败即为此类）。纯函数测试自己冻结 now，不受影响。
const DAY = 86_400_000;
const isoFromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
// 以 now 为中心的对称周期：月进度恒为 50%，断言只依赖「欠账差」，与真实日期无关
const billingPeriod = (): { periodStart: string; periodEnd: string } => ({ periodStart: isoFromNow(-15 * DAY), periodEnd: isoFromNow(15 * DAY) });

test('monthly score uses normalized spend against calendar progress', () => {
  const common = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z' };
  assert.equal(monthlyDebtScore({ ...common, monthlyPercent: 50 }, Date.parse('2026-11-16T00:00:00Z')), 0);
  assert.ok((monthlyDebtScore({ ...common, monthlyPercent: 20 }, Date.parse('2026-11-16T00:00:00Z')) as number) > 0);
});

test('selector filters unsupported models and full windows; exhaustions last and unknown data falls back to priority', () => {
  // Selection ignores transport fields, which these fixtures intentionally omit.
  const backends = [{ name: 'first', family: 'ccg', priority: 0 }, { name: 'behind', family: 'ccg', priority: 1 }, { name: 'exhausted', family: 'ccg', priority: 2 }] as Backend[];
  const period = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', known: true };
  const snapshots = { first: { ...period, monthlyPercent: 20 }, behind: { ...period, monthlyPercent: 10 }, exhausted: { ...period, monthlyPercent: 100 } };
  assert.equal(selectBackend({ backends, snapshots, model: { ccg: 'native' }, now: Date.parse('2026-11-16T00:00:00Z') }).name, 'behind');
  assert.equal(selectBackend({ backends, snapshots: {}, model: { ccg: 'native' } }).name, 'first');
  assert.equal(selectBackend({ backends, snapshots: { first: { ...period, monthlyPercent: 100 }, behind: { ...period, monthlyPercent: 100 } }, model: { ccg: 'native' }, now: Date.parse('2026-11-16T00:00:00Z') }).name, 'first');
  // Selection needs only the exceeded flags from these partial windows.
  const limited = Object.fromEntries(backends.map(({ name }) => [name, { fiveHour: { exceeded: true }, weekly: { exceeded: true } }])) as Record<string, QuotaSnapshot>;
  assert.throws(() => selectBackend({ backends, snapshots: limited, model: { ccg: 'native' } }), /all eligible subscriptions are window-limited/);
  assert.throws(() => selectBackend({ backends, snapshots, model: { ocg: 'not-configured' } }), (error: unknown): boolean => (error as Error & { statusCode: number }).statusCode === 400);
});

test('rankBackends exposes the full candidate order selectBackend picks from', () => {
  // Selection ignores transport fields, which these fixtures intentionally omit.
  const backends = [{ name: 'first', family: 'ccg', priority: 0 }, { name: 'behind', family: 'ccg', priority: 1 }, { name: 'exhausted', family: 'ccg', priority: 2 }] as Backend[];
  const period = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', known: true };
  const snapshots = { first: { ...period, monthlyPercent: 20 }, behind: { ...period, monthlyPercent: 10 }, exhausted: { ...period, monthlyPercent: 100 } };
  const now = Date.parse('2026-11-16T00:00:00Z');
  const ranked = rankBackends({ backends, snapshots, model: { ccg: 'native' }, now });
  assert.deepEqual(ranked.map((b) => b.name), ['behind', 'first']); // 月耗尽的 exhausted 有可用候选时不进池（既有行为）
  assert.equal(selectBackend({ backends, snapshots, model: { ccg: 'native' }, now }).name, ranked[0].name);
  // Selection needs only the exceeded flags from these partial windows.
  const limited = Object.fromEntries(backends.map(({ name }) => [name, { fiveHour: { exceeded: true }, weekly: { exceeded: true } }])) as Record<string, QuotaSnapshot>;
  assert.deepEqual(rankBackends({ backends, snapshots: limited, model: { ccg: 'native' } }), []);
  assert.throws(() => rankBackends({ backends, snapshots, model: { ocg: 'no' } }), (error: unknown): boolean => (error as Error & { statusCode: number }).statusCode === 400);
});

test('CCG snapshot polls credits, usage, subscriptions and marks failed alpha queries unknown', async () => {
  const paths: string[] = [];
  const snapshots = new UsageSnapshots({ backends: [{ name: 'ccg', family: 'ccg', base_url: 'http://ccg.invalid/provider/v1', key_env: 'KEY' }], env: { KEY: 'secret' }, fetchImpl: async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    // Provider quota polling calls fetch with URL strings.
    const url = input as string;
    paths.push(new URL(url).pathname);
    if (url.endsWith('/credits')) return Response.json({ monthlyCredits: 60, fiveHour: { used: 2, cap: 14 }, weekly: { used: 3, cap: 35 } });
    if (url.endsWith('/summary')) return Response.json({ totalCost: 10 });
    return Response.json(billingPeriod());
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
  // This proxy status fixture intentionally omits the unused credential field.
  const backends = [{ name: 'ocg-a', family: 'ocg', base_url: 'http://proxy.invalid:8731', status_url: 'http://proxy.invalid:8742/api/route/status', account: 'account-a' }] as Backend[];
  const snapshots = new UsageSnapshots({ backends, fetchImpl: async () => Response.json({ accounts: [{ name: 'account-a', monthly_percent: 45, month_progress: 60, rolling_percent: 100, weekly_percent: 20 }] }), logger: { warn() {} } });
  await snapshots.refresh();
  // The account status fixture supplies both window observations.
  const result = snapshots.peek().snapshots['ocg-a'] as ObservedSnapshot;
  assert.equal(result.monthlyPercent, 45);
  assert.equal(result.monthProgress, 60);
  assert.equal(result.fiveHour.exceeded, true);
  assert.equal(result.fiveHour.used, 100);
  assert.equal(result.fiveHour.cap, 100);
  assert.equal(result.weekly.exceeded, false);
  assert.equal(result.weekly.used, 20);
});

test('e2e chooses greater-debt CCG subscription on new identity', async (t: TestContext) => {
  const seen: string[] = [];
  const fake = (spent: number, name: string): Server => http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    if (req.method === 'GET' && req.url === '/alpha/billing/credits') return res.end(JSON.stringify({ monthlyCredits: 70 - spent, fiveHour: { used: 1, cap: 14 }, weekly: { used: 1, cap: 35 } }));
    if (req.method === 'GET' && req.url === '/alpha/usage/summary') return res.end(JSON.stringify({ totalCost: spent }));
    if (req.method === 'GET' && req.url === '/alpha/billing/subscriptions') return res.end(JSON.stringify(billingPeriod()));
    if (req.method === 'POST') { seen.push(name); for await (const _chunk of req) {} res.end(JSON.stringify({ backend: name })); return; }
    res.writeHead(404).end();
  });
  const first = fake(40, 'first'); const second = fake(5, 'second');
  const firstUrl = await start(first); const secondUrl = await start(second);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-score-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), KEY1: 'one', KEY2: 'two' };
  const config: GatewayConfig = { master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ccg: 'native' } }], backends: [{ name: 'first', family: 'ccg', base_url: firstUrl, key_env: 'KEY1', priority: 0 }, { name: 'second', family: 'ccg', base_url: secondUrl, key_env: 'KEY2', priority: 1 }] };
  const gateway = await launchGateway(config, env);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(first); await close(second); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await chat(gateway);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['second']);
});

test('e2e routes directly to OCG backends by monthly debt and pins the selected account per identity', async (t: TestContext) => {
  const received: ReceivedChat[] = [];
  const direct = (name: string, percent: number): Server => http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url === '/zen/go/v1/usage') {
      assert.equal(req.headers['user-agent']?.startsWith('Mozilla/'), true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: {
        rolling: { percent: 10, resetsAt: isoFromNow(6 * 3_600_000) },
        weekly: { percent: 20, resetsAt: isoFromNow(3 * DAY) },
        monthly: { percent, resetsAt: isoFromNow(30 * DAY) },
      } }));
      return;
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      // HTTP JSON boundary: the forwarded chat body contains the translated model.
      received.push({ name, path: req.url, session: req.headers['x-opencode-session'], body: JSON.parse(Buffer.concat(chunks).toString()) as ForwardedChat });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ backend: name })); return;
    }
    res.writeHead(404).end();
  });
  const foxmail = direct('foxmail', 85); const gmail = direct('gmail', 15);
  const foxUrl = await start(foxmail); const gmailUrl = await start(gmail);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-ocg-direct-'));
  const env = { CPR_MASTER: 'master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), FOX_KEY: 'fox-fixture', GMAIL_KEY: 'gmail-fixture' };
  const config: GatewayConfig = {
    master_key_env: 'CPR_MASTER',
    models: [{ id: 'm', backends: { ocg: 'native-model' } }],
    backends: [
      { name: 'ocg-foxmail', family: 'ocg', direct: true, base_url: `${foxUrl}/zen/go/v1`, key_env: 'FOX_KEY', priority: 0 },
      { name: 'ocg-gmail', family: 'ocg', direct: true, base_url: `${gmailUrl}/zen/go/v1`, key_env: 'GMAIL_KEY', priority: 1 },
    ],
  };
  const gateway = await launchGateway(config, env);
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(foxmail); await close(gmail); fs.rmSync(dir, { recursive: true, force: true }); });

  const send = (session: string): Promise<Response> => fetch(`http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}/v1/chat/completions`, {
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

test('e2e returns explicit 429 when all candidates exceed both windows', async (t: TestContext) => {
  const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    if (req.method === 'GET' && req.url === '/alpha/billing/credits') return res.end(JSON.stringify({ monthlyCredits: 50, fiveHour: { used: 14, cap: 14 }, weekly: { used: 35, cap: 35 } }));
    if (req.method === 'GET' && req.url === '/alpha/usage/summary') return res.end(JSON.stringify({ totalCost: 20 }));
    if (req.method === 'GET' && req.url === '/alpha/billing/subscriptions') return res.end(JSON.stringify(billingPeriod()));
    res.writeHead(200).end('should not forward');
  });
  const base = await start(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-limited-'));
  const gateway = await launchGateway({ master_key_env: 'CPR_MASTER', models: [{ id: 'm', backends: { ccg: 'native' } }], backends: [{ name: 'limited', family: 'ccg', base_url: base, key_env: 'UPSTREAM' }] }, { CPR_MASTER: 'master', UPSTREAM: 'key', CPR_SESSIONS_DB: path.join(dir, 'sessions.db') });
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await chat(gateway);
  assert.equal(response.status, 429);
  // HTTP JSON boundary: routing failures return an error envelope.
  assert.match(((await response.json()) as ErrorResponse).error.message, /all eligible subscriptions are window-limited/);
});
