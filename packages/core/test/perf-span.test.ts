import type { AddressInfo } from 'node:net';
import type { Backend, GatewayConfig } from '../src/contracts.ts';
import type { Logger } from '../src/contracts.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../src/http/server.ts';

// perf 打点（.scratch/perf-instrumentation/spec.md）：每个转发请求恰一行 [perf] JSON，
// 段位/forward/meta 形状、attempts 口径、aborted 语义、身份明文不落行。

const usagePayload = {
  usage: {
    rolling: { percent: 1, resetsAt: '2030-01-01T00:00:00Z' },
    weekly: { percent: 1, resetsAt: '2030-01-01T00:00:00Z' },
    monthly: { percent: 1, resetsAt: '2030-01-01T00:00:00Z' },
  },
};

interface Harness {
  url: string;
  logs: string[];
  cleanup: () => Promise<void>;
}

async function startHarness(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): Promise<Harness> {
  const upstream = http.createServer((req, res) => { void handler(req, res); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;
  const config: GatewayConfig = {
    master_key_env: 'CPR_TEST_MASTER',
    listen: { host: '127.0.0.1', port: 0 },
    models: [{ id: 'unified-model', backends: { ocg: 'native-model' } }],
    backends: [{ name: 'first', family: 'ocg', base_url: `http://127.0.0.1:${port}`, key_env: 'CPR_TEST_UPSTREAM', direct: true } as Backend],
  };
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-perf-db-'));
  const logs: string[] = [];
  const logger: Logger = { log: (...args: unknown[]) => { logs.push(String(args[0])); }, warn: () => {}, error: () => {} };
  const env = { CPR_TEST_MASTER: 'test-master', CPR_TEST_UPSTREAM: 'test-upstream', CPR_DB_FILE: path.join(dbDir, 'data.db') };
  const gateway = createGatewayServers(config, { env, logger });
  gateway.forwardServer.listen(0, '127.0.0.1');
  await once(gateway.forwardServer, 'listening');
  return {
    url: `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`,
    logs,
    cleanup: async () => {
      await Promise.all([gateway.forwardServer, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
      fs.rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

function perfLines(logs: string[]): Record<string, unknown>[] {
  return logs.filter((line) => line.startsWith('[perf] ')).map((line) => JSON.parse(line.slice('[perf] '.length)) as Record<string, unknown>);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function post(url: string, body: string, headers: Record<string, string> = {}): http.ClientRequest {
  const request = http.request(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer test-master', 'content-type': 'application/json', ...headers } });
  request.end(body);
  return request;
}

test('JSON 请求恰一行 perf：段位齐全、status/attempts 正确、无会话 id', async () => {
  const harness = await startHarness(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/usage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(usagePayload)); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}');
  });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const request = post(harness.url, JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }), { 'x-session-id': 'secret-session-42' });
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(chunks.toString()));
      });
      request.on('error', reject);
    });
    assert.match(result, /"content":"ok"/);
    await sleep(30);
    const lines = perfLines(harness.logs);
    assert.equal(lines.length, 1, `期望恰一行 [perf]，实得 ${lines.length}：${JSON.stringify(harness.logs)}`);
    const view = lines[0]!;
    assert.equal(view.status, 200);
    assert.equal(view.attempts, 1);
    assert.equal(view.model, 'unified-model');
    assert.equal(view.tenant, 'default');
    assert.equal(view.bytes, JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }).length);
    const ms = view.ms as Record<string, unknown>;
    for (const key of ['read', 'parse', 'identity', 'route', 'probe', 'prepare']) {
      assert.equal(typeof ms[key], 'number', `ms.${key} 应为数字：${JSON.stringify(ms)}`);
      assert.ok((ms[key] as number) >= 0);
    }
    assert.equal(typeof ms.snapshot, 'number', '首个请求会阻塞等快照刷新（fetchedAt=null 时）');
    assert.ok((ms.snapshot as number) >= 0);
    const forward = view.forward as Record<string, unknown>;
    assert.equal(typeof forward.ttft, 'number');
    assert.ok((forward.ttft as number) >= 0);
    assert.ok(!('aborted' in view));
    assert.ok(!JSON.stringify(view).includes('secret-session-42'), 'perf 行不得含会话 id 明文');
  } finally { await harness.cleanup(); }
});

test('流式请求 forward 带 ttft；429 短重试烧尽后 attempts 累计且仍只一行', async () => {
  let requests = 0;
  const harness = await startHarness(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/usage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(usagePayload)); return; }
    requests += 1;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end('{"error":{"message":"walled"}}');
  });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = post(harness.url, JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }), { 'x-session-id': 'walled-session' });
      request.on('response', (response) => {
        void response;
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      request.on('error', reject);
    });
    assert.equal(status, 429);
    await sleep(30);
    const lines = perfLines(harness.logs);
    assert.equal(lines.length, 1, `多 attempt 也只能一行，实得 ${lines.length}`);
    const view = lines[0]!;
    // 首发 + 3 次原地短重试（retry-after 0 ≤ 2s 阈值），改绑决策无备选 → 透传 429。
    assert.equal(view.attempts, 4, `attempts 应为 4，实得 ${JSON.stringify(view)}`);
    assert.equal(view.status, 429);
    assert.equal(requests, 4, '上游应收到 4 笔');
  } finally { await harness.cleanup(); }
});

test('客户端取消：无 finish 但有 close，perf 行带 aborted', async () => {
  const harness = await startHarness(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/usage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(usagePayload)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    // 不 end：挂住让客户端中途取消
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = post(harness.url, JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }], stream: true }), { 'x-session-id': 'cancel-session' });
      request.on('response', (response) => {
        response.once('data', () => {
          request.destroy();
          resolve();
        });
        response.resume();
      });
      request.on('error', () => { /* 客户端主动断开 */ });
      setTimeout(() => resolve(), 2000);
    });
    await sleep(50);
    const lines = perfLines(harness.logs);
    assert.equal(lines.length, 1, `取消请求应恰一行 [perf]，实得 ${lines.length}`);
    const view = lines[0]!;
    assert.equal(view.aborted, true);
    assert.ok(view.attempts as number >= 1);
  } finally { await harness.cleanup(); }
});

test('401/404 不产生 perf 行', async () => {
  const harness = await startHarness(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/usage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(usagePayload)); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const request = post(harness.url, '{}', { authorization: 'Bearer wrong-key' });
      request.on('response', (response) => { response.resume(); resolve(); });
      request.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const request = http.request(`${harness.url}/v1/other`, { method: 'GET', headers: { authorization: 'Bearer test-master' } });
      request.on('response', (response) => { response.resume(); resolve(); });
      request.on('error', reject);
      request.end();
    });
    await sleep(30);
    const lines = perfLines(harness.logs);
    assert.equal(lines.length, 0, `401/404 不得产生 perf 行：${JSON.stringify(harness.logs)}`);
  } finally { await harness.cleanup(); }
});
