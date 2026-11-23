#!/usr/bin/env node
// perf 基准（spec .scratch/perf-instrumentation/spec.md）：本机假上游，量「经网关 vs 直连」的转发开销。
// 不打真实上游、不烧订阅额度。用法：
//   node scripts/perf-overhead.ts [--runs 30] [--delay-ms 50] [--sizes 10k,1m,3.4m] [--stream]
// 输出：每档 body 的直连/经网关 TTFT p50、各 perf 段 p50（从 [perf] 行解析）、假上游连接数（keepAlive 复用观察）。
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGatewayServers } from '../src/http/server.ts';
import type { GatewayConfig, Logger } from '../src/contracts.ts';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const RUNS = Number(arg('runs', '30'));
const DELAY_MS = Number(arg('delay-ms', '50'));
const STREAM = args.includes('--stream');
const SIZES = arg('sizes', '10k,1m,3.4m').split(',').map((token) => {
  const match = token.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) return 10_000;
  const base = Number(match[1]!);
  const multiplier = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1_000_000 : 1;
  const value = base * multiplier;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 10_000;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

interface Upstream {
  url: string;
  connections: number;
  close: () => Promise<void>;
  server: http.Server;
}

function startUpstream(): Upstream {
  let connections = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === '/usage') {
      const at = '2030-01-01T00:00:00Z';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { rolling: { percent: 1, resetsAt: at }, weekly: { percent: 1, resetsAt: at }, monthly: { percent: 1, resetsAt: at } } }));
      return;
    }
    await sleep(DELAY_MS); // 模拟上游推理首字延迟
    if (STREAM) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}');
  });
  server.on('connection', () => { connections += 1; });
  server.listen(0, '127.0.0.1');
  return {
    url: '',
    get connections() { return connections; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    server,
  };
}

function post(url: string, body: string): Promise<{ ttft: number; status: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = http.request(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer bench', 'content-type': 'application/json' } }, (response) => {
      response.once('data', () => {
        resolve({ ttft: performance.now() - startedAt, status: response.statusCode ?? 0 });
        response.resume();
      });
      response.resume();
    });
    request.on('error', reject);
    request.end(body);
  });
}

function makeBody(size: number): string {
  // 撑到目标字节的普通对话体：一条系统提示 + 一条填充用户消息。
  const filler = 'x'.repeat(Math.max(0, size - 200));
  return JSON.stringify({ model: 'bench-model', messages: [{ role: 'system', content: 'You are a benchmark.' }, { role: 'user', content: filler }] });
}

const upstream = startUpstream();
await once(upstream.server, 'listening');
const upstreamPort = (upstream.server.address() as AddressInfo).port;
upstream.url = `http://127.0.0.1:${upstreamPort}`;

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-perf-bench-'));
const logs: string[] = [];
const logger: Logger = { log: (line) => { if (String(line).startsWith('[perf] ')) logs.push(String(line)); } };
const config: GatewayConfig = {
  master_key_env: 'CPR_BENCH_MASTER',
  listen: { host: '127.0.0.1', port: 0 },
  models: [{ id: 'bench-model', backends: { ocg: 'native-bench' } }],
  backends: [{ name: 'bench', family: 'ocg', base_url: upstream.url, key_env: 'CPR_BENCH_UPSTREAM', direct: true }],
};
const gateway = createGatewayServers(config, { env: { CPR_BENCH_MASTER: 'bench', CPR_BENCH_UPSTREAM: 'bench', CPR_DB_FILE: path.join(dbDir, 'data.db') }, logger });
gateway.forwardServer.listen(0, '127.0.0.1');
await once(gateway.forwardServer, 'listening');
const gatewayUrl = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;

const perfRows: Record<string, unknown>[] = [];
for (const size of SIZES) {
  const body = makeBody(size);
  // 预热一轮：首请求吃快照阻塞刷新与连接建立，不计入统计。
  await post(gatewayUrl, body);
  const directTtft: number[] = [];
  const gatewayTtft: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    directTtft.push((await post(upstream.url, body)).ttft);
    gatewayTtft.push((await post(gatewayUrl, body)).ttft);
  }
  // perf 行是全批累计的；只取本档最后一轮的行做分段展示（每请求一行，近尾声的行为本档形态）。
  const rows = logs.splice(0).map((line) => JSON.parse(line.slice('[perf] '.length)) as Record<string, unknown>);
  perfRows.push(...rows);
  const stage = (key: string): number => median(rows.map((row) => Number((row.ms as Record<string, unknown>)[key] ?? 0)));
  const table = rows.length ? rows : [{ ms: {}, forward: {} }];
  const row = table[table.length - 1]!;
  console.log(`\n== body ≈ ${size} bytes ==`);
  console.log(`direct  TTFT p50: ${median(directTtft).toFixed(1)}ms`);
  console.log(`gateway TTFT p50: ${median(gatewayTtft).toFixed(1)}ms  (差值 ≈ ${(median(gatewayTtft) - median(directTtft)).toFixed(1)}ms)`);
  console.log(`perf 段 p50: read=${stage('read')} parse=${stage('parse')} identity=${stage('identity')} route=${stage('route')} probe=${stage('probe')} prepare=${stage('prepare')} (ms)`);
  console.log(`样例行: ${JSON.stringify(row)}`);
}

console.log(`\n假上游连接数: ${upstream.connections}（请求总数 ≈ ${RUNS * SIZES.length * 2 + SIZES.length + 1}；远小于请求数 = keepAlive 复用生效）`);
const attempts = perfRows.map((row) => Number(row.attempts ?? 1));
console.log(`perf 行数: ${perfRows.length}，attempts 合计 ${attempts.reduce((a, b) => a + b, 0)}（=请求数则无隐藏重试）`);
gateway.forwardServer.close();
await upstream.close();
fs.rmSync(dbDir, { recursive: true, force: true });
