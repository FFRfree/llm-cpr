import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { GatewayConfig } from '../src/contracts.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGatewayServers } from '../src/http/server.ts';

const close = (server: http.Server): Promise<void> => new Promise<void>((resolve) => server.close(() => resolve()));

// 缓慢流式吐字的上游：每个 data 块间隔 60ms，共 8 块 + [DONE]。
// 返回 { server, sawAbort, finished }：sawAbort=上游被提前掐断；finished=上游吐完了全部内容。
function slowStreamUpstream(): { server: http.Server; state: { sawAbort: boolean; finished: boolean } } {
  const state = { sawAbort: false, finished: false };
  const server = http.createServer((req, res) => {
    // 非聊天路径（如 ocg 快照刷新的 GET /usage）回 JSON，别让 SSE 流拖住快照刷新
    if (!(req.url as string).includes('chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ usage: { rolling: { percent: 10, resetsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, weekly: { percent: 10, resetsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, monthly: { percent: 10, resetsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"1"}}]}\n\n');
    let n = 1;
    const timer = setInterval(() => {
      n += 1;
      if (n > 8) {
        clearInterval(timer);
        state.finished = true;
        return res.end('data: [DONE]\n\n');
      }
      res.write(`data: {"choices":[{"delta":{"content":"${n}"}}]}\n\n`);
    }, 60);
    res.on('close', () => {
      clearInterval(timer);
      if (!state.finished) state.sawAbort = true;
    });
  });
  return { server, state };
}

function gatewayFor(t: TestContext, upstream: http.Server): Promise<ReturnType<typeof createGatewayServers>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-cancel-'));
  const env = { CPR_TEST_MASTER: 'master', CPR_TEST_UPSTREAM: 'up', CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  const config: GatewayConfig = {
    master_key_env: 'CPR_TEST_MASTER',
    models: [{ id: 'unified', backends: { ocg: 'native' } }],
    backends: [{ name: 'sub-a', family: 'ocg', base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, key_env: 'CPR_TEST_UPSTREAM' }],
  };
  const gateway = createGatewayServers(config, { env, logger: { log() {}, warn() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1');
  gateway.adminServer.listen(0, '127.0.0.1');
  t.after(async () => {
    await Promise.all([gateway.forwardServer, gateway.adminServer, upstream].map(close));
    gateway.audit.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]).then(() => gateway);
}

test('client cancel cuts the upstream request early and records a 499 audit row', async (t) => {
  const { server: upstream, state } = slowStreamUpstream();
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = await gatewayFor(t, upstream);
  const url = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;

  // 客户端：收到第一个 data 块就立刻取消连接（模拟 Agent 停止推理）
  await new Promise<void>((resolve) => {
    const req = http.request(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': 'cancel-1' },
    }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'unified', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  });

  // 等 error 分支收尾（499 落账本）
  for (let i = 0; i < 50; i++) {
    if (gateway.audit.listRequests().some((row) => row.identity === 'cancel-1')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const rows = gateway.audit.listRequests({ identity: 'cancel-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 499);
  assert.equal(state.sawAbort, true, 'upstream must be cut early, not left hanging');
  assert.equal(state.finished, false, 'upstream must not stream to completion after client cancel');
});

test('normal streamed completion records 200 once and never fires the cancel path', async (t) => {
  const { server: upstream, state } = slowStreamUpstream();
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = await gatewayFor(t, upstream);
  const url = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;

  const text = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': 'keep-1' },
    body: JSON.stringify({ model: 'unified', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  }).then((r) => r.text());
  assert.match(text, /data: \[DONE\]/);
  assert.equal(state.sawAbort, false);
  assert.equal(state.finished, true);
  const rows = gateway.audit.listRequests({ identity: 'keep-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 200);
});
