import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGatewayServers } from '../lib/server.ts';
import type { Gateway } from '../lib/server.ts';
import type { TestContext } from 'node:test';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AuditRow, Backend, QuotaSnapshot } from '../lib/contracts.ts';

interface InferenceBody extends Record<string, unknown> {
  model: string;
  stream_options: { include_usage: boolean };
}
interface CapturedRequest { url: string | undefined; headers: IncomingHttpHeaders }
interface InferenceRequest extends CapturedRequest { body: InferenceBody }
interface FixtureOptions {
  family?: string;
  prefix?: string;
  identity_header?: string;
  direct?: boolean;
  account?: string;
  reply?: (req: IncomingMessage, res: ServerResponse, entry: InferenceRequest) => void | ServerResponse | Promise<void>;
}
interface ChatResponse { status: number; text: string; headers: Headers }
interface FamilyFixture {
  inference: InferenceRequest[];
  quota: CapturedRequest[];
  restart(): Promise<void>;
  get<T>(route: string): Promise<T>;
  chat(body?: Record<string, unknown>, headers?: Record<string, string>, route?: string): Promise<ChatResponse>;
}
interface RequestsPayload { requests: AuditRow[] }
interface RouteStatus {
  subscriptions: { name: string; account: string; alias: string; snapshot: QuotaSnapshot & { fiveHour: { exceeded: boolean } } }[];
  mappings: { backend: string; identities: number }[];
}
interface ChatPayload { usage: { completion_tokens: number } }
interface Addresses { forward: string; admin: string }

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});
const future = (days: number): string => new Date(Date.now() + days * 86400000).toISOString();

async function fixture(t: TestContext, { family = 'ocg', prefix = '', identity_header, direct = true, account = 'quota-account', reply }: FixtureOptions = {}): Promise<FamilyFixture> {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'cpr-family-http-'));
  const inference: InferenceRequest[] = [], quota: CapturedRequest[] = [];
  const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void | ServerResponse> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'GET') {
      quota.push({ url: req.url, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      if (family === 'ccg') {
        const bodies: Record<string, unknown> = {
          '/alpha/billing/credits': { credits: { monthlyCredits: 75 }, windowLimits: { fiveHour: { used: 2, cap: 10 }, weekly: { used: 3, cap: 20 } } },
          '/alpha/usage/summary': { totalCost: 25 },
          '/alpha/billing/subscriptions': { data: { periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: future(29) } },
        };
        return res.writeHead(bodies[req.url as string] ? 200 : 404).end(JSON.stringify(bodies[req.url as string] ?? {}));
      }
      if (direct) return res.end(JSON.stringify({ usage: {
        rolling: { percent: 20, resetsAt: future(1) }, weekly: { percent: 15, resetsAt: future(7) }, monthly: { percent: 25, resetsAt: future(20) },
      } }));
      return res.end(JSON.stringify({ accounts: [
        { name: 'other-account', month_progress: 50, usage: { monthly_percent: 99 } },
        { name: account, month_progress: 50, usage: { monthly_percent: 25, rolling_percent: 20, weekly_percent: 15 } },
      ] }));
    }
    // HTTP JSON payload boundary: the fixture reads only model and stream_options.
    const entry: InferenceRequest = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as InferenceBody };
    inference.push(entry);
    if (family === 'ocg' && !req.headers['x-opencode-session']) return res.writeHead(400).end('missing OCG session');
    if (reply) return reply(req, res, entry);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}');
  });
  const origin = await listen(upstream);
  const config = {
    master_key_env: 'MASTER', identity_header,
    listen: { host: '127.0.0.1', port: 0 }, admin: { port: 0 },
    backends: [{ name: 'stable-subscription', alias: 'display-only', account, family: family as Backend['family'], direct, base_url: `${origin}${prefix}`, key_env: 'UPSTREAM', admin_key_env: 'ADMIN' }],
    models: [{ id: 'public-model', backends: { [family]: 'native-model' } }],
  };
  const env = { MASTER: 'test-master', UPSTREAM: 'test-upstream', ADMIN: 'test-admin', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  let gateway: Gateway, forward: string, admin: string;
  const start = async (): Promise<void> => {
    gateway = createGatewayServers(config, { env, logger: { warn() {} } });
    [forward, admin] = await Promise.all([listen(gateway.forwardServer), listen(gateway.adminServer)]);
  };
  await start();
  t.after(async () => {
    await Promise.all([close(gateway.forwardServer), close(gateway.adminServer)]);
    await close(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    inference, quota,
    restart: async (): Promise<void> => { await Promise.all([close(gateway.forwardServer), close(gateway.adminServer)]); await start(); },
    get: async <T>(route: string): Promise<T> => {
      const response = await fetch(`${admin}${route}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      // HTTP JSON response boundary: each caller supplies its endpoint payload shape.
      return response.json() as Promise<T>;
    },
    chat: async (body: Record<string, unknown> = {}, headers: Record<string, string> = {}, route: string = '/v1/chat/completions'): Promise<ChatResponse> => {
      const response = await fetch(`${forward}${route}`, {
        method: 'POST', signal: AbortSignal.timeout(2000),
        headers: { authorization: 'Bearer test-master', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'public-model', ...body }),
      });
      return { status: response.status, text: await response.text(), headers: response.headers };
    },
  };
}

test('OCG header priority and blank-header fallback agree with routing identity over HTTP', async (t: TestContext): Promise<void> => {
  const app = await fixture(t, { identity_header: 'X-Client-Session' });
  for (const [headers, expected] of [
    [{ 'x-client-session': 'primary', 'x-opencode-session': 'legacy' }, 'primary'],
    [{ 'x-opencode-session': 'legacy-only' }, 'legacy-only'],
    [{ 'x-client-session': '', 'x-opencode-session': 'legacy-fallback' }, 'legacy-fallback'],
    [{}, '127.0.0.1'],
  ] satisfies [Record<string, string>, string][]) {
    assert.equal((await app.chat({}, headers)).status, 200);
    const entry = app.inference.at(-1) as InferenceRequest;
    assert.equal(entry.headers['x-opencode-session'], expected);
    assert.equal(entry.headers['x-client-session'], undefined);
    const { requests } = await app.get<RequestsPayload>(`/api/audit/requests?identity=${encodeURIComponent(expected)}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].identity_kind, expected === '127.0.0.1' ? 'address' : 'session');
  }
});

test('real provider families keep quota/account identity, auth, Chat paths and opaque payloads consistent', async (t: TestContext): Promise<void> => {
  for (const options of [
    { family: 'ocg', prefix: '', direct: true, target: '/v1/chat/completions', usage: '/usage' },
    { family: 'ocg', prefix: '/v1///', direct: true, target: '/v1/chat/completions', usage: '/v1/usage' },
    { family: 'ocg', prefix: '/proxy/v1/', direct: false, target: '/proxy/v1/chat/completions', usage: '/api/route/status' },
    { family: 'ccg', prefix: '/provider', target: '/provider/v1/chat/completions' },
    { family: 'ccg', prefix: '/provider/v1///', target: '/provider/v1/chat/completions' },
  ]) await t.test(`${options.family} ${options.prefix || '/'} ${options.direct ?? ''}`, async (t: TestContext): Promise<void> => {
    const app = await fixture(t, options);
    const body = {
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{"x":1}' } }], reasoning: 'opaque' }],
      tools: [{ type: 'function', function: { name: 'tool', parameters: { type: 'object' } } }],
      extra_provider_field: { signature: 'untouched' },
    };
    assert.equal((await app.chat(body, { 'x-session-id': 'primary', 'x-opencode-session': 'legacy' })).status, 200);
    const [entry] = app.inference;
    assert.equal(entry.url, options.target);
    assert.equal(entry.headers.authorization, 'Bearer test-upstream');
    assert.equal(entry.headers['x-opencode-session'], options.family === 'ocg' ? 'primary' : undefined);
    assert.equal(entry.headers['x-session-id'], undefined);
    assert.deepEqual(entry.body, { model: 'native-model', ...body });
    const status = await app.get<RouteStatus>('/api/route/status');
    const subscription = status.subscriptions[0];
    assert.equal(subscription.name, 'stable-subscription');
    assert.equal(subscription.account, 'quota-account');
    assert.equal(subscription.alias, 'display-only');
    assert.equal(subscription.snapshot.monthlyPercent, 25, 'proxy OCG chooses the named account rather than the first one');
    assert.equal(subscription.snapshot.fiveHour.exceeded, false);
    if (options.family === 'ccg') {
      assert.deepEqual([...new Set(app.quota.map(({ url }) => url))].sort(), ['/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary']);
      assert.ok(app.quota.every(({ headers }) => headers.authorization === 'Bearer test-upstream'));
    } else {
      assert.ok(app.quota.every(({ url }) => url === options.usage));
      assert.ok(app.quota.every(({ headers }) => headers.authorization === `Bearer ${options.direct ? 'test-upstream' : 'test-admin'}`));
      if (options.direct) assert.ok(app.quota.every(({ headers }) => (headers['user-agent'] as string).startsWith('Mozilla/5.0')));
    }
    const { requests } = await app.get<RequestsPayload>('/api/audit/requests?identity=primary');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].subscription, 'stable-subscription');
    assert.equal(requests[0].account, 'quota-account');
    assert.equal(requests[0].translated_model, 'native-model');
    assert.equal(requests[0].cache_hit_tokens, 8);
  });
});

test('Chat SSE remains byte-transparent on both families; unimplemented protocols never reach an upstream', async (t: TestContext): Promise<void> => {
  const bytes = 'data: {"choices":[{"delta":{"reasoning":"opaque","tool_calls":[{"id":"call-1","function":{"arguments":"{}"}}]}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":15,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":12}}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const family of ['ocg', 'ccg']) await t.test(family, async (t: TestContext): Promise<void> => {
    const app = await fixture(t, { family, prefix: '/provider/v1/', reply: (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(bytes.slice(0, 13)); res.end(bytes.slice(13));
    } });
    for (const route of ['/v1/responses', '/v1/messages']) assert.equal((await app.chat({}, {}, route)).status, 404);
    assert.equal(app.inference.length, 0);
    const response = await app.chat({ stream: true, stream_options: { include_usage: true } });
    assert.equal(response.status, 200);
    assert.equal(response.text, bytes);
    assert.equal(app.inference[0].body.stream_options.include_usage, true);
    const { requests } = await app.get<RequestsPayload>('/api/audit/requests');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt_tokens, 15);
    assert.equal(requests[0].completion_tokens, 3);
    assert.equal(requests[0].cache_hit_tokens, 12);
    assert.ok((requests[0].ttft_ms as number) >= 0);
    assert.ok((requests[0].stream_ms as number) >= 0);
  });
});

test('unchanged main entry runs native typed modules with disposable config and no installed runtime packages', { timeout: 10000 }, async (t: TestContext): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'cpr-main-'));
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  const seen: (string | string[] | undefined)[] = [];
  const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void | ServerResponse> => {
    for await (const _chunk of req) {}
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end('{"accounts":[]}');
    seen.push(req.headers['x-opencode-session']);
    res.end('{"choices":[],"usage":{"completion_tokens":4}}');
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    if (upstream.listening) await close(upstream);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base_url = await listen(upstream);
  const policyFile = path.join(dir, 'policy.ts');
  fs.writeFileSync(policyFile, `
    export default class {
      master_key_env = 'MASTER';
      models = [{ id: 'public-model', backends: { ocg: 'native-model' } }];
      backends = [{ name: 'main-subscription', family: 'ocg', base_url: ${JSON.stringify(base_url)}, key_env: 'UPSTREAM' }];
    }
  `);
  child = spawn(process.execPath, ['lib/main.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    // Do not inherit credentials or the production policy/port environment.
    env: { MASTER: 'test-master', UPSTREAM: 'test-upstream', CPR_POLICY_FILE: policyFile, CPR_FORWARD_PORT: '0', CPR_ADMIN_PORT: '0',
      CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk; });
  const addresses = await new Promise<Addresses>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code: number | null) => reject(new Error(`main exited ${code}: ${errors}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
      const forward = output.match(/forward listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      const admin = output.match(/admin listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (forward && admin) resolve({ forward, admin });
    });
  });
  const response = await fetch(`${addresses.forward}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer test-master', 'content-type': 'application/json' },
    body: '{"model":"public-model","messages":[{"role":"user","content":"hello"}]}', signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  // HTTP JSON response boundary: main returns Chat usage and audit request payloads.
  assert.equal((await response.json() as ChatPayload).usage.completion_tokens, 4);
  assert.match(seen[0] as string, /^[a-f0-9]{64}$/);
  const audit = await fetch(`${addresses.admin}/api/audit/requests`, { signal: AbortSignal.timeout(2000) });
  assert.equal((await audit.json() as RequestsPayload).requests[0].subscription, 'main-subscription');
});

test('headerless fingerprint is the OCG upstream session, audit identity and persistent route key', async (t: TestContext): Promise<void> => {
  const app = await fixture(t);
  const body = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'first turn' }] };
  assert.equal((await app.chat(body)).status, 200);
  const session = app.inference[0].headers['x-opencode-session'];
  assert.match(session as string, /^[a-f0-9]{64}$/);
  assert.equal(app.inference[0].headers['x-session-id'], undefined);
  assert.equal(app.inference[0].body.model, 'native-model');
  await app.restart();
  assert.equal((await app.chat({ ...body, messages: [...body.messages, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'next turn' }] })).status, 200);
  assert.equal(app.inference[1].headers['x-opencode-session'], session);
  const { requests } = await app.get<RequestsPayload>('/api/audit/requests');
  assert.equal(requests.length, 2);
  for (const row of requests) {
    assert.equal(row.identity_kind, 'fingerprint');
    assert.equal(row.identity, session);
    assert.equal(row.subscription, 'stable-subscription');
    assert.equal(row.account, 'quota-account');
    assert.equal(row.cache_hit_tokens, 8);
  }
  const status = await app.get<RouteStatus>('/api/route/status');
  assert.deepEqual(status.mappings, [{ backend: 'stable-subscription', identities: 1 }]);
  assert.equal(status.subscriptions[0].snapshot.monthlyPercent, 25);
});
