import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, IncomingHttpHeaders, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';
import type { AuditRow, Backend, Environment, GatewayConfig, RoutingConfig } from '../core/contracts.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createGatewayServers } from '../core/http/server.ts';

// Agreed seam: real HTTP on ephemeral loopback ports, with local fake upstreams.
// No production config, credentials, inference, or private collaborator mocks.
interface RequestOptions {
  target?: string;
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer;
}
interface HttpResponse {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
}
interface AuditResponse { requests: AuditRow[] }
interface ChildAddresses { url: string; admin: string }
type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown;
type SnapshotHandler = (req: IncomingMessage, res: ServerResponse) => unknown;
interface Fixture {
  url: string;
  admin: string;
  chat: (session?: string, options?: RequestOptions) => Promise<HttpResponse>;
  rows: (session?: string) => Promise<AuditRow[]>;
  seen: number[];
  upstreams: Server[];
  config: GatewayConfig;
}
const scratch = process.env.TMPDIR || os.tmpdir();
const listen = async (server: Server, port: number = 0): Promise<string> => {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server): Promise<void | Error> => new Promise<void | Error>((resolve) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(resolve);
});
function request(url: string, { target, method = 'GET', headers = {}, body }: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = http.request(url, { path: target, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP test deadline exceeded')));
    req.on('error', reject);
    req.end(body);
  });
}
async function setup(t: TestContext, handlers: UpstreamHandler[], routing: RoutingConfig = {}, snapshotHandler?: SnapshotHandler): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(scratch, 'cpr-reliability-'));
  const seen: number[] = [];
  const upstreams = handlers.map((handler, i) => http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    if (req.method === 'GET') return snapshotHandler ? snapshotHandler(req, res) : res.writeHead(200, { 'content-type': 'application/json' }).end('{"accounts":[]}');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(i);
    handler(req, res, Buffer.concat(chunks));
  }));
  const urls = await Promise.all(upstreams.map((server) => listen(server)));
  const env: Environment = { MASTER: 'test-master', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  const backends: Backend[] = urls.map((base_url, i) => {
    env[`K${i}`] = `test-upstream-${i}`;
    return { name: `sub-${i}`, family: 'ocg', base_url, key_env: `K${i}`, priority: i };
  });
  const config: GatewayConfig = { master_key_env: 'MASTER', models: [{ id: 'm', backends: { ocg: 'native' } }], backends, routing };
  const gateway = createGatewayServers(config, { env, logger: { warn() {} } });
  const [url, admin] = await Promise.all([listen(gateway.forwardServer), listen(gateway.adminServer)]);
  t.after(async () => {
    await close(gateway.forwardServer);
    await close(gateway.adminServer);
    await Promise.all(upstreams.map(close));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const chat = (session: string = 's', options: RequestOptions = {}): Promise<HttpResponse> => request(url, {
    method: 'POST', target: '/v1/chat/completions',
    body: JSON.stringify({ model: 'm', stream: true }),
    ...options,
    headers: { authorization: 'Bearer test-master', 'content-type': 'application/json', 'x-session-id': session, ...options.headers },
  });
  const rows = async (session: string = 's'): Promise<AuditRow[]> => {
    // HTTP JSON boundary: the admin endpoint returns audit rows.
    return (JSON.parse((await request(admin, { target: `/api/audit/requests?identity=${encodeURIComponent(session)}` })).bytes.toString()) as AuditResponse).requests;
  };
  return { url, admin, chat, rows, seen, upstreams, config };
}
const ok = (_req: IncomingMessage, res: ServerResponse): ServerResponse => res.writeHead(200, { 'content-type': 'application/json' }).end('{"usage":{"prompt_tokens":10,"completion_tokens":2}}');

test('health checks walk ranked candidates for both new pins and quota migration', async (t: TestContext) => {
  for (const migrate of [false, true]) await t.test(migrate ? 'quota migration' : 'new pin', async (t: TestContext) => {
    const quota = (_req: IncomingMessage, res: ServerResponse): ServerResponse => res.writeHead(403).end('quota');
    const app = await setup(t, migrate ? [quota, ok, ok] : [ok, ok]);
    await request(app.admin, { method: 'POST', target: '/api/snapshots/refresh' });
    const down = app.upstreams[migrate ? 1 : 0];
    const port = (down.address() as AddressInfo).port;
    await close(down);
    const response = await app.chat();
    assert.equal(response.status, 200);
    assert.deepEqual(app.seen, migrate ? [0, 2] : [1]);
    // The successful fallback becomes the stable pin, even after better-ranked TCP recovers.
    await listen(down, port);
    assert.equal((await app.chat()).status, 200);
    assert.deepEqual(app.seen, migrate ? [0, 2, 2] : [1, 1]);
  });
});

test('quota errors preserve arbitrary binary bytes and representation headers', async (t: TestContext) => {
  const bytes = Buffer.from([0x1f, 0x8b, 0xff, 0xfe, 0x00, 0x80]);
  const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): ServerResponse => res.writeHead(429, {
    'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'retry-after': '30',
  }).end(bytes)]);
  const response = await app.chat();
  assert.equal(response.status, 429);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers['retry-after'], '30');
  assert.deepEqual(response.bytes, bytes);
  assert.equal((await app.rows()).length, 1);
});

test('truncated quota responses terminate with one gateway-error audit instead of hanging', async (t: TestContext) => {
  for (const status of [403, 429]) await t.test(String(status), async (t: TestContext) => {
    const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(status); res.write('partial');
      setTimeout(() => res.destroy(), 15);
    }, ok]);
    const response = await app.chat();
    assert.equal(response.status, 502);
    const rows = await app.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 502);
    assert.deepEqual(app.seen, [0], 'a transport failure is not a quota migration');
  });
});

test('upstream deadlines bound headers, idle bodies, and quota drips without cutting active long streams', async (t: TestContext) => {
  await t.test('silent headers', async (t: TestContext) => {
    const app = await setup(t, [(): void => {}], { upstream_timeout_ms: 80 });
    assert.equal((await app.chat()).status, 504);
    assert.deepEqual((await app.rows()).map((row) => row.status), [504]);
  });
  await t.test('idle stream after data', async (t: TestContext) => {
    const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: hello\n\n');
    }], { upstream_timeout_ms: 80 });
    await assert.rejects(app.chat(), /aborted/);
    assert.deepEqual((await app.rows()).map((row) => row.status), [504]);
  });
  await t.test('headers without any body bytes', async (t: TestContext) => {
    const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
    }], { upstream_timeout_ms: 80 });
    assert.equal((await app.chat()).status, 504);
    assert.deepEqual((await app.rows()).map((row) => row.status), [504]);
  });
  await t.test('dripping quota has an absolute collection deadline', async (t: TestContext) => {
    const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(429); res.write('partial');
      const timer = setInterval(() => res.write('.'), 15);
      res.on('close', () => clearInterval(timer));
    }, ok], { upstream_timeout_ms: 80 });
    assert.equal((await app.chat()).status, 504);
    assert.deepEqual((await app.rows()).map((row) => row.status), [504]);
    assert.deepEqual(app.seen, [0]);
  });
  await t.test('stream lifetime can exceed the inactivity deadline', async (t: TestContext) => {
    const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': start\n\n');
      let count = 0;
      const timer = setInterval(() => {
        if (++count === 12) res.end('data: {"usage":{"completion_tokens":12}}\n\n');
        else res.write(': active\n\n');
      }, 20);
      res.on('close', () => clearInterval(timer));
    }], { upstream_timeout_ms: 80 });
    assert.equal((await app.chat()).status, 200);
    assert.deepEqual((await app.rows()).map((row) => [row.status, row.completion_tokens]), [[200, 12]]);
  });
});

test('quota body collection is size bounded and fails explicitly rather than truncating a representation', async (t: TestContext) => {
  const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): ServerResponse => res.writeHead(403, { 'content-encoding': 'gzip' }).end(Buffer.alloc(1024 * 1024 + 1, 0xff)), ok]);
  const response = await app.chat();
  assert.equal(response.status, 502);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.match(response.bytes.toString(), /too large/);
  assert.deepEqual((await app.rows()).map((row) => row.status), [502]);
  assert.deepEqual(app.seen, [0]);
});

test('the upstream receives only its own credential, approved context, and no hop-by-hop nominated headers', async (t: TestContext) => {
  let observed: IncomingHttpHeaders | undefined;
  const app = await setup(t, [(req: IncomingMessage, res: ServerResponse): void => {
    observed = req.headers;
    res.writeHead(200, { connection: 'keep-alive, x-internal', 'x-internal': 'must-not-escape', trailer: 'x-trailer', 'content-type': 'application/json' }).end('{}');
  }]);
  const response = await app.chat('safe-session', { headers: {
    cookie: 'private=secret', 'x-api-key': 'private-key', 'api-key': 'private-key',
    'x-auth-token': 'private-token', 'proxy-authorization': 'Basic secret',
    'cf-access-jwt-assertion': 'private-jwt', 'x-forwarded-user': 'private-user',
    forwarded: 'for=private', 'x-forwarded-for': 'private-ip', 'x-real-ip': 'private-ip',
    connection: 'keep-alive, x-request-id', 'x-request-id': 'nominated',
    'x-unrecognized-secret': 'secret', accept: 'text/event-stream',
  } });
  assert.equal(response.status, 200);
  // The awaited successful chat has already invoked the header-capturing handler.
  assert.equal((observed as IncomingHttpHeaders).authorization, 'Bearer test-upstream-0');
  assert.equal((observed as IncomingHttpHeaders)['x-opencode-session'], 'safe-session');
  assert.equal((observed as IncomingHttpHeaders).accept, 'text/event-stream');
  for (const name of ['cookie', 'x-api-key', 'api-key', 'x-auth-token', 'proxy-authorization',
    'cf-access-jwt-assertion', 'x-forwarded-user', 'forwarded', 'x-forwarded-for', 'x-real-ip',
    'x-session-id', 'x-request-id', 'x-unrecognized-secret']) assert.equal((observed as IncomingHttpHeaders)[name], undefined, name);
  assert.equal(response.headers['x-internal'], undefined);
  assert.equal(response.headers.trailer, undefined);
});

test('cancellation during quota retry delay never starts another upstream attempt and records 499 once', async (t: TestContext) => {
  let hit: () => void;
  const first = new Promise<void>((resolve) => { hit = resolve; });
  const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => { res.writeHead(429, { 'retry-after': '0.08' }).end('quota'); hit(); }, ok]);
  const req = http.request(`${app.url}/v1/chat/completions`, { method: 'POST', headers: {
    authorization: 'Bearer test-master', 'x-session-id': 'retry-cancel',
  } });
  req.on('error', () => {});
  req.end('{"model":"m"}');
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(app.seen, [0]);
  assert.deepEqual((await app.rows('retry-cancel')).map((row) => row.status), [499]);
});

test('cancellation while snapshots are pending never opens an upstream inference request', async (t: TestContext) => {
  const held: ServerResponse[] = [];
  const app = await setup(t, [ok], {}, (_req: IncomingMessage, res: ServerResponse): number => held.push(res));
  const req = http.request(`${app.url}/v1/chat/completions`, { method: 'POST', headers: {
    authorization: 'Bearer test-master', 'x-session-id': 'early-cancel',
  } });
  req.on('error', () => {});
  req.end('{"model":"m"}');
  await new Promise((resolve) => setTimeout(resolve, 50));
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const res of held) res.end('{"accounts":[]}');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(app.seen, []);
});

test('bounded SSE audit recovers after oversized events and decodes split UTF-8, CRLF, multiline data and final usage', async (t: TestContext) => {
  const multiline = Buffer.from('data: {"note":"缓存",\r\ndata: "usage":{"prompt_tokens":21,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":19}}}\r\n\r\n');
  const split = multiline.indexOf(Buffer.from('缓')) + 1;
  const chunks = [
    Buffer.from('data: ' + 'x'.repeat(300 * 1024) + '\r\n\r\n'),
    Buffer.from('data: {"usage":{"completion_tokens":1}}\r\n\r\n'),
    multiline.subarray(0, split), multiline.subarray(split, multiline.length - 3), multiline.subarray(multiline.length - 3),
    Buffer.from('data: [DONE]\r\n\r\n'),
  ];
  const expected = Buffer.concat(chunks);
  const app = await setup(t, [async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      // Deliberately split both CRLF and multibyte characters across writes.
      for (let i = 0; i < chunk.length; i += 4093) {
        if (!res.write(chunk.subarray(i, i + 4093))) await once(res, 'drain');
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    res.end();
  }]);
  const response = await app.chat();
  assert.deepEqual(response.bytes, expected);
  const [row] = await app.rows();
  assert.equal(row.status, 200);
  assert.equal(row.prompt_tokens, 21);
  assert.equal(row.completion_tokens, 7);
  assert.equal(row.cache_hit_tokens, 19);
  // Preserve the original numeric comparisons for this completed stream observation.
  assert.ok((row.ttft_ms as number) >= 0);
  assert.ok((row.stream_ms as number) >= 0);
});

test('an upstream stream abort is audited once as 502, not as a client cancellation', async (t: TestContext) => {
  const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: started\n\n');
    setTimeout(() => res.destroy(), 15);
  }, ok]);
  await assert.rejects(app.chat(), /aborted/);
  assert.deepEqual((await app.rows()).map((row) => row.status), [502]);
  assert.deepEqual(app.seen, [0]);
});

test('cancelling while a quota body is being collected destroys upstream and audits 499 once', async (t: TestContext) => {
  let hit: () => void, closed: () => void;
  const started = new Promise<void>((resolve) => { hit = resolve; });
  const stopped = new Promise<void>((resolve) => { closed = resolve; });
  const app = await setup(t, [(_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(429); res.write('partial'); hit();
    res.once('close', closed);
  }, ok]);
  const req = http.request(`${app.url}/v1/chat/completions`, { method: 'POST', headers: {
    authorization: 'Bearer test-master', 'x-session-id': 'quota-cancel',
  } });
  req.on('error', () => {}); req.end('{"model":"m"}');
  await started; req.destroy();
  await Promise.race([stopped, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream not cancelled')), 1000); timer.unref();
  })]);
  assert.deepEqual((await app.rows('quota-cancel')).map((row) => row.status), [499]);
  assert.deepEqual(app.seen, [0]);
});

test('large SSE forwards incrementally within a small heap and audits trailing usage', async (t: TestContext) => {
  const block = Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'.repeat(1024));
  const blocks = 2048; // Many complete events, collectively larger than the gateway's JS heap.
  const tail = Buffer.from('\n\ndata: {"usage":{"prompt_tokens":17,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":12}}}\r\n\r\ndata: [DONE]\n\n');
  let finished = false;
  const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    if (req.method === 'GET') return res.end('{"accounts":[]}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ');
    try {
      for (let i = 0; i < blocks; i++) if (!res.write(block)) await once(res, 'drain');
      finished = true;
      res.end(tail);
    } catch {}
  });
  const base_url = await listen(upstream);
  t.after(() => close(upstream));
  const dir = fs.mkdtempSync(path.join(scratch, 'cpr-stream-heap-'));
  const child = spawn(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', `
    import { createGatewayServers } from ${JSON.stringify(new URL('../core/http/server.ts', import.meta.url).href)};
    const g = createGatewayServers({master_key_env:'MASTER',models:[{id:'m',backends:{ocg:'native'}}],
      backends:[{name:'sub',family:'ocg',base_url:${JSON.stringify(base_url)},key_env:'KEY'}]},
      {env:{MASTER:'test-master',KEY:'test-upstream',CPR_SESSIONS_DB:${JSON.stringify(path.join(dir, 'sessions.db'))}},logger:{warn(){}}});
    g.adminServer.listen(0,'127.0.0.1',()=>g.forwardServer.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({
      url:'http://127.0.0.1:'+g.forwardServer.address().port,admin:'http://127.0.0.1:'+g.adminServer.address().port}))));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [line] = await once(child.stdout, 'data');
  // Child stdout JSON boundary: the subprocess announces its listening URLs.
  const { url, admin } = JSON.parse(line.toString()) as ChildAddresses;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const req = http.request(`${url}/v1/chat/completions`, { method: 'POST', headers: {
      authorization: 'Bearer test-master', 'x-session-id': 'heap', 'content-type': 'application/json',
    } }, (res) => {
      res.on('data', (chunk: Buffer) => { assert.equal(finished && bytes === 0, false, 'first bytes must arrive before upstream finishes'); bytes += chunk.length; });
      res.on('error', reject);
      res.on('end', resolve);
    });
    req.setTimeout(10000, () => req.destroy(new Error('large stream deadline')));
    req.on('error', reject);
    req.end('{"model":"m","stream":true}');
  });
  assert.equal(bytes, 6 + blocks * block.length + tail.length);
  // HTTP JSON boundary: the admin endpoint returns audit rows.
  const rows = (JSON.parse((await request(admin, { target: '/api/audit/requests?identity=heap' })).bytes.toString()) as AuditResponse).requests;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 200);
  assert.equal(rows[0].prompt_tokens, 17);
  assert.equal(rows[0].completion_tokens, 3);
  assert.equal(rows[0].cache_hit_tokens, 12);
});

test('malformed admin URLs return 400 without terminating the gateway process', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(scratch, 'cpr-admin-url-'));
  // Isolate a potential unhandled rejection: a broken admin request must not kill the process.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createGatewayServers } from ${JSON.stringify(new URL('../core/http/server.ts', import.meta.url).href)};
    const g = createGatewayServers({ models: [], backends: [] }, {
      env: { CPR_SESSIONS_DB: ${JSON.stringify(path.join(dir, 'sessions.db'))} }, logger: { warn() {} }
    });
    g.forwardServer.listen(0, '127.0.0.1');
    g.adminServer.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + g.adminServer.address().port));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [line] = await once(child.stdout, 'data');
  const url = line.toString().trim();
  for (const target of ['/api/audit/sessions/%', 'http://[']) {
    const response = await request(url, { target }).catch((error) => ({ status: error.message }));
    assert.equal(response.status, 400, stderr);
  }
  assert.equal((await request(url, { target: '/api/audit/summary' })).status, 200);
});
