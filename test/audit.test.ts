import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createGatewayServers } from '../lib/http/server.ts';
import { UsageAudit } from '../lib/store/audit.ts';
import type { Gateway } from '../lib/http/server.ts';
import type { TestContext } from 'node:test';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditRow, GatewayConfig, Logger } from '../lib/contracts.ts';

interface RequestPayload extends Record<string, unknown> { stream?: boolean }
interface FixtureOptions { body?: RequestPayload; logger?: Logger; dbPath?: string }
interface AuditFixture {
  gateway: Gateway;
  env: { CPR_MASTER: string; KEY: string; CPR_DB_FILE: string };
  dir: string;
  send(payload?: RequestPayload): Promise<Response>;
  logger: Logger;
}
interface StoredAuditRow extends AuditRow { usage_json: string }

const listen = async (server: Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));
async function fixture(t: TestContext, { body, logger = { warn() {}, log() {} }, dbPath }: FixtureOptions = {}): Promise<AuditFixture> {
  const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    // HTTP JSON request boundary: the mock reads only the stream flag.
    const request = JSON.parse(Buffer.concat(chunks).toString()) as RequestPayload;
    const result = { id: 'response', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 50 } } };
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(result)}\n\n`);
      await delay(30); // 流式夹具：拉开首字节与结束的时刻，保证 stream_ms 可测
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  });
  const baseUrl = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-'));
  const env = { CPR_MASTER: 'master', KEY: 'upstream', CPR_DB_FILE: dbPath ?? path.join(dir, 'data.db') };
  const config: GatewayConfig = { master_key_env: 'CPR_MASTER', models: [{ id: 'unified', backends: { ocg: 'native' } }], backends: [{ name: 'subscription-a', family: 'ocg', account: 'account-a', base_url: baseUrl, key_env: 'KEY' }] };
  const gateway = createGatewayServers(config, { env, logger });
  gateway.forwardServer.listen(0, '127.0.0.1');
  await once(gateway.forwardServer, 'listening');
  t.after(async () => { await close(gateway.forwardServer); await close(upstream); gateway.audit?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (payload: RequestPayload = body ?? { model: 'unified', messages: [{ role: 'user', content: 'TOP_SECRET_PROMPT' }] }): Promise<Response> => fetch(`http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': 'session-a' }, body: JSON.stringify(payload) });
  return { gateway, env, dir, send, logger };
};

test('audit stores complete request metadata and parsed upstream usage, never request body', async (t: TestContext): Promise<void> => {
  const { gateway, env, send } = await fixture(t);
  const response = await send();
  assert.equal(response.status, 200);
  const db = new DatabaseSync(env.CPR_DB_FILE);
  // node:sqlite row boundary: this query returns the inserted request and its raw usage.
  const row = db.prepare('SELECT * FROM requests').get() as unknown as StoredAuditRow;
  assert.equal(row.identity, 'session-a');
  assert.equal(row.identity_kind, 'session');
  assert.equal(row.subscription, 'subscription-a');
  assert.equal(row.account, 'account-a');
  assert.equal(row.model, 'unified');
  assert.equal(row.translated_model, 'native');
  assert.equal(row.status, 200);
  assert.equal(row.prompt_tokens, 100);
  assert.equal(row.completion_tokens, 20);
  assert.equal(row.cache_hit_tokens, 50);
  assert.equal(row.total_tokens, 120);
  assert.equal(row.cache_outcome, 'partial');
  assert.match(row.usage_json, /cached_tokens/);
  assert.doesNotMatch(JSON.stringify(row), /TOP_SECRET_PROMPT/);
  assert.equal(gateway.audit.sessionSummary('session-a').requests, 1);
  db.close();
});

test('cache miss summaries use full-miss session rate and prior-prompt 0.6 loss rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-unit-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  for (const [ts, hit] of [[1, 0], [2, 59], [3, 60]]) {
    audit.record({ ts, identity: 's', identity_kind: 'session', subscription: 'sub', account: 'a' },
      { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: hit } });
  }
  const summary = audit.sessionSummary('s');
  assert.equal(summary.full_miss_rate, 1 / 3);
  assert.deepEqual(summary.loss_events.map((event) => event.ts), [2]);
  audit.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('streaming responses and concurrent requests each produce one audit row', async (t: TestContext): Promise<void> => {
  const { env, send } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => send({ model: 'unified', stream: index === 0 })));
  assert.ok(responses.every((response) => response.status === 200));
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  const db = new DatabaseSync(env.CPR_DB_FILE);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n, 6);
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM requests WHERE usage_json IS NOT NULL').get() as { n: number }).n === 6);
  db.close();
});

test('ttft/stream timings are recorded for streaming, ttft only for non-streaming', async (t: TestContext): Promise<void> => {
  const { env, gateway, send } = await fixture(t);
  await (await send({ model: 'unified', stream: true })).arrayBuffer();
  await (await send()).arrayBuffer();
  const db = new DatabaseSync(env.CPR_DB_FILE);
  // node:sqlite row boundary: SELECT returns the two fixture request rows.
  const [streamRow, plainRow] = db.prepare('SELECT * FROM requests ORDER BY ts, id').all() as unknown as StoredAuditRow[];
  assert.equal(typeof streamRow.ttft_ms, 'number');
  assert.ok((streamRow.ttft_ms as number) >= 0);
  assert.equal(typeof streamRow.stream_ms, 'number');
  assert.ok((streamRow.stream_ms as number) >= 20); // 夹具刻意拉开 30ms
  assert.equal(typeof plainRow.ttft_ms, 'number');
  assert.equal(plainRow.stream_ms, null); // 非流式没有流时长概念
  db.close();
  const summary = gateway.audit.summary();
  const perf = summary.subscriptions[0];
  assert.equal(typeof perf.avg_ttft_ms, 'number');
  assert.ok((perf.tps as number) > 0); // Σtokens / Σstream_ms
});

test('existing ledgers gain ttft/stream columns via migration without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-migrate-'));
  const file = path.join(dir, 'data.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, identity_kind TEXT NOT NULL,
    subscription TEXT, account TEXT, model TEXT, translated_model TEXT, path TEXT, status INTEGER, ms INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
    cache_write_tokens INTEGER, total_tokens INTEGER, cache_observed INTEGER NOT NULL DEFAULT 0,
    cache_outcome TEXT, usage_json TEXT)`);
  legacy.prepare(`INSERT INTO requests(ts,identity_kind,subscription,status,cache_observed) VALUES(1,'session','sub',200,0)`).run();
  legacy.close();
  const audit = new UsageAudit({ dbFile: file });
  const db = audit.db as DatabaseSync;
  const columns = db.prepare('PRAGMA table_info(requests)').all().map((entry) => entry.name);
  assert.ok(columns.includes('ttft_ms') && columns.includes('stream_ms'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n, 1);
  audit.record({ ts: 2, identity_kind: 'session', subscription: 'sub', ttft_ms: 900, stream_ms: 500 }, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM requests WHERE ttft_ms=900 AND stream_ms=500').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM system_events').get() as { n: number }).n, 0); // 旧库同文件补建事件表，不塞历史事件
  audit.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('existing ledgers gain the dashboard query indexes via migration without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-audit-idx-migrate-'));
  const file = path.join(dir, 'usage.db');
  const legacy = new DatabaseSync(file);
  // 老库：无任何索引的旧 schema
  legacy.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, identity_kind TEXT NOT NULL,
    subscription TEXT, account TEXT, model TEXT, translated_model TEXT, path TEXT, status INTEGER, ms INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
    cache_write_tokens INTEGER, total_tokens INTEGER, cache_observed INTEGER NOT NULL DEFAULT 0,
    cache_outcome TEXT, usage_json TEXT)`);
  legacy.prepare(`INSERT INTO requests(ts,identity,identity_kind,subscription,status,cache_observed) VALUES(1,'s1','session','sub',200,0)`).run();
  legacy.close();
  const audit = new UsageAudit({ dbFile: file });
  const db = audit.db as DatabaseSync;
  const indexes = (db.prepare('PRAGMA index_list(requests)').all() as Array<{ name: string }>).map((entry) => entry.name);
  assert.ok(indexes.includes('idx_requests_identity_ts'));
  assert.ok(indexes.includes('idx_requests_sess_group'));
  assert.ok(indexes.includes('idx_requests_sub_agg'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n, 1); // 老行保留
  audit.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('summary filters subscriptions to currently configured names when given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-summary-filter-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  audit.record({ ts: 1, identity_kind: 'session', subscription: 'live-a' }, { completion_tokens: 1 });
  audit.record({ ts: 2, identity_kind: 'session', subscription: 'retired-x' }, { completion_tokens: 1 });
  const all = audit.summary();
  assert.equal(all.subscriptions.length, 2); // 不传参：历史行为不变
  const filtered = audit.summary({ subscriptionNames: ['live-a'] });
  assert.deepEqual(filtered.subscriptions.map((entry) => entry.subscription), ['live-a']);
  assert.equal(filtered.requests, 2); // 全局计数不过滤，只过滤订阅维度
  audit.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('audit write failure logs degraded marker and does not block successful forwarding', async (t: TestContext): Promise<void> => {
  const warnings: string[] = [];
  const logger: Logger = { warn: (...args: unknown[]): number => warnings.push(args.join(' ')), log() {} };
  const { gateway, send, env } = await fixture(t, { logger });
  // 合并库后亲和读失败会拒绝请求（unknown ≠ 新身份，宁保缓存），所以只废写路径：
  // 触发器拒写 requests、读保持健康——验证「写失败降级转发」这一契约本身。
  const breaker = new DatabaseSync(env.CPR_DB_FILE);
  t.after(() => breaker.close());
  breaker.exec(`CREATE TRIGGER reject_requests BEFORE INSERT ON requests BEGIN SELECT RAISE(FAIL, 'test write failure'); END`);
  const response = await send();
  assert.equal(response.status, 200);
  assert.ok(warnings.some((message) => /\[audit\].*degraded|\[audit\].*record failed/i.test(message)));
});
