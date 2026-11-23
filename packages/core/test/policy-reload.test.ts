// Policy 热更新（工单 .scratch/policy-hot-reload/）：签名懒检查、坏文件保旧、冷区守卫、
// 审计事件/备份快照、管理口两端点。语义参照 Hermes last-known-good：改坏文件绝不让流量变道。
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createGatewayServers } from '../core/http/server.ts';
import { sha256File } from '../core/policy/reload.ts';
import type { SystemEventRow } from '../core/store/events.ts';

const listen = async (server: http.Server): Promise<string> => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: http.Server): Promise<void> => new Promise<void>((resolve) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
});
const chat = (url: string, session: string): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify({ model: 'm' }) });

// 用户 policy 真身：两个后端 + decide 内联表达式。各版本长度/内容必不同 → 文件签名必变。
const policySource = (first: string, second: string, decide: string, extra = '', prelude = ''): string => `${prelude}export default class {
  master_key_env = 'CPR_MASTER';
  backends = [
    { name: 'first', family: 'ocg', base_url: '${first}', key_env: 'K0', priority: 0 },
    { name: 'second', family: 'ocg', base_url: '${second}', key_env: 'K1', priority: 1 },
  ];
  models = [{ id: 'm', backends: { ocg: 'native-m' } }];
  ${extra}
  decide(ctx) { ${decide} }
}`;
const pick = (name: string): string => `return { backend: '${name}' };`;

interface App {
  url: string;
  adminUrl: string;
  file: string;
  dir: string;
  urls: [string, string];
  events: { listEvents(args?: { kind?: string; limit?: number }): SystemEventRow[] };
  policyGet(): Promise<Record<string, unknown>>;
  policyReload(): Promise<{ outcome: { kind: string }; status: Record<string, unknown> }>;
}

async function setup(t: TestContext, decide: string): Promise<App> {
  const upstreams = ['first', 'second'].map((name) => http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ backend: name }))));
  const urls = await Promise.all(upstreams.map(listen));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-reload-'));
  // 外置 policy 目录的 ESM 判定靠 package.json type:module（缺它 NodeNext/Node 探测判 CJS）。
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const file = path.join(dir, 'policy.ts');
  fs.writeFileSync(file, policySource(urls[0], urls[1], decide));
  const mod = (await import(pathToFileURL(file).href)) as { default: new () => unknown };
  const policy = new mod.default() as Parameters<typeof createGatewayServers>[0];
  const env = { CPR_MASTER: 'master', CPR_DB_FILE: path.join(dir, 'data.db'), CPR_DATA_DIR: dir, K0: 'key0', K1: 'key1' };
  const gateway = createGatewayServers(policy, { env, logger: { warn() {}, log() {} }, policyFile: file });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  const adminUrl = `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`;
  t.after(async () => {
    await close(gateway.forwardServer); await close(gateway.adminServer); await Promise.all(upstreams.map(close));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`,
    adminUrl, file, dir, urls: [urls[0], urls[1]],
    events: gateway.events,
    policyGet: async () => (await (await fetch(`${adminUrl}/api/policy`)).json()) as Record<string, unknown>,
    policyReload: async () => (await (await fetch(`${adminUrl}/api/policy/reload`, { method: 'POST' })).json()) as { outcome: { kind: string }; status: Record<string, unknown> },
  };
}

const edit = (app: App, first: string, second: string, decide: string, extra = '', prelude = ''): void => { fs.writeFileSync(app.file, policySource(first, second, decide, extra, prelude)); };
const seen = async (app: App): Promise<string[]> => {
  const out: string[] = [];
  for (const event of app.events.listEvents()) {
    if (event.kind === 'route.bind' || event.kind === 'route.rebind') out.push(event.backend_name ?? '');
  }
  return out.reverse(); // listEvents 倒序返回，这里转时间正序好读
};
const reloadEvents = (app: App, kind: string): SystemEventRow[] => app.events.listEvents().filter((event) => event.kind === kind);

test('decide edit hot-swaps on the next request; audit event + status + backup snapshot land', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  assert.deepEqual(await seen(app), ['first']);
  const before = await app.policyGet();
  assert.equal(before.reloads, 0);

  edit(app, app.urls[0], app.urls[1], pick('second'));
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'second']); // 新请求即新策略，无需重启

  const after = await app.policyGet();
  assert.equal(after.reloads, 1);
  assert.equal(typeof after.sha256, 'string');
  const reloaded = reloadEvents(app, 'policy.reload');
  assert.equal(reloaded.length, 1);
  const detail = JSON.parse(reloaded[0].detail ?? '{}') as { trigger?: string; from_hash?: string; to_hash?: string };
  assert.equal(detail.trigger, 'file-change');
  assert.match(detail.to_hash ?? '', /^[0-9a-f]{64}$/);
  assert.match(detail.from_hash ?? '', /^[0-9a-f]{64}$/); // 新旧哈希都在，可对账
  // 备份快照：dataDir/backups/policy/ 落一份当时跑的文件
  const backups = fs.readdirSync(path.join(app.dir, 'backups', 'policy'));
  assert.equal(backups.length, 1);
  assert.equal(sha256File(path.join(app.dir, 'backups', 'policy', backups[0])), detail.to_hash);
});

test('syntax error keeps the old policy and reports once per content (no event spam)', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  edit(app, app.urls[0], app.urls[1], 'broken syntax here {');
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first']); // 保旧：流量不变道
  const status = await app.policyGet();
  assert.equal(status.reloads, 0);
  assert.equal(status.failedReloads, 1);
  assert.match(String(status.lastError), /policy\.ts/);
  const failures = reloadEvents(app, 'policy.reload.error');
  assert.equal(failures.length, 1);
  assert.equal((JSON.parse(failures[0].detail ?? '{}') as { reason?: string }).reason, 'load-failed');
  // 同一坏内容再来一请求：deduped，不追加事件
  assert.equal((await chat(app.url, 's3')).status, 200);
  assert.equal(reloadEvents(app, 'policy.reload.error').length, 1);
  // 修好文件 → 自然重载
  edit(app, app.urls[0], app.urls[1], pick('second'));
  assert.equal((await chat(app.url, 's4')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first', 'first', 'second']);
  assert.equal(reloadEvents(app, 'policy.reload').length, 1);
});

test('validateConfig failure keeps the old policy', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  fs.writeFileSync(app.file, "export default class { backends = []; models = [{ id: 'm', backends: {} }]; }");
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first']);
  const status = await app.policyGet();
  assert.equal(status.reloads, 0);
  assert.match(String(status.lastError), /config\.backends must contain at least one backend/);
  const failures = reloadEvents(app, 'policy.reload.error');
  assert.equal((JSON.parse(failures[0].detail ?? '{}') as { reason?: string }).reason, 'load-failed');
});

test('cold-zone change refuses the whole swap and lists differing fields', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  // 冷区字段一：backends 改名
  fs.writeFileSync(app.file, policySource(app.urls[0], app.urls[1], pick('first')).replace("name: 'first'", "name: 'renamed'"));
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first']); // 整份拒绝：decide 也没换
  let status = await app.policyGet();
  assert.equal(status.reloads, 0);
  assert.deepEqual(status.lastColdChanged, ['backends']);
  let failure = JSON.parse(reloadEvents(app, 'policy.reload.error')[0].detail ?? '{}') as { reason?: string; cold_changed?: string[] };
  assert.equal(failure.reason, 'cold-zone-change');
  assert.deepEqual(failure.cold_changed, ['backends']);
  // 冷区字段二：routing.snapshot_interval_ms（routing 整体是热区，仅此项冷）
  edit(app, app.urls[0], app.urls[1], pick('first'), `routing = { snapshot_interval_ms: 123456 };`);
  assert.equal((await chat(app.url, 's3')).status, 200);
  status = await app.policyGet();
  assert.equal(status.reloads, 0);
  assert.deepEqual(status.lastColdChanged, ['routing.snapshot_interval_ms']);
  // 热区 routing 参数（不在冷区清单）正常热换
  edit(app, app.urls[0], app.urls[1], pick('first'), `routing = { rebind_cooldown_ms: 555 };`);
  assert.equal((await chat(app.url, 's4')).status, 200);
  const healthy = await app.policyGet();
  assert.equal(healthy.reloads, 1);
  assert.equal(healthy.lastColdChanged, null); // 成功即清失败现场（review-1 P3-2）
  assert.equal(healthy.lastError, null);
});

test('deleted policy file keeps the old policy and reports the removal once', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  fs.rmSync(app.file);
  assert.equal((await chat(app.url, 's2')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first']); // 不回落内置：静默换内置 = 静默改路由
  const status = await app.policyGet();
  assert.match(String(status.lastError), /policy file removed/);
  assert.equal(reloadEvents(app, 'policy.reload.error').length, 1);
  assert.equal((await chat(app.url, 's3')).status, 200);
  assert.equal(reloadEvents(app, 'policy.reload.error').length, 1); // 缺失态同样去重
  // 文件回来 → 恢复重载
  edit(app, app.urls[0], app.urls[1], pick('second'));
  assert.equal((await chat(app.url, 's4')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first', 'first', 'second']);
});

test('manual reload endpoint shares the same machinery with trigger=manual', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  edit(app, app.urls[0], app.urls[1], pick('second'));
  const manual = await app.policyReload();
  assert.equal(manual.outcome.kind, 'reloaded');
  assert.equal(manual.status.lastTrigger, 'manual');
  assert.equal(manual.status.reloads, 1);
  const detail = JSON.parse(reloadEvents(app, 'policy.reload')[0].detail ?? '{}') as { trigger?: string };
  assert.equal(detail.trigger, 'manual'); // 与文件拾取可区分
  // 再改文件 + 一条请求 → 拾取触发器覆盖记录，reload 次数 +1
  edit(app, app.urls[0], app.urls[1], `return { backend: 'second' }; `);
  assert.equal((await chat(app.url, 's2')).status, 200);
  const viaFile = await app.policyGet();
  assert.equal(viaFile.lastTrigger, 'file-change');
  assert.equal(viaFile.reloads, 2);
});

test('builtin mode (no policyFile) stays zero-behavior', async (t) => {
  const upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
  const url = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-reload-builtin-'));
  const policy = {
    master_key_env: 'CPR_MASTER',
    backends: [{ name: 'first', family: 'ocg' as const, base_url: url, key_env: 'K0', priority: 0 }],
    models: [{ id: 'm', backends: { ocg: 'native-m' } }],
  };
  const gateway = createGatewayServers(policy, { env: { CPR_MASTER: 'master', CPR_DB_FILE: path.join(dir, 'data.db'), K0: 'k' }, logger: { warn() {}, log() {} } });
  gateway.forwardServer.listen(0, '127.0.0.1'); gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  const adminUrl = `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`;
  t.after(async () => { await close(gateway.forwardServer); await close(gateway.adminServer); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const forward = `http://127.0.0.1:${(gateway.forwardServer.address() as AddressInfo).port}`;
  assert.equal((await chat(forward, 's1')).status, 200);
  const status = (await (await fetch(`${adminUrl}/api/policy`)).json()) as Record<string, unknown>;
  assert.equal(status.source, 'core/policy/mine.ts');
  assert.equal(status.sha256, null);
  assert.equal(status.reloads, 0);
  await fetch(`${adminUrl}/api/policy/reload`, { method: 'POST' });
  assert.equal(gateway.events.listEvents().filter((event) => event.kind.startsWith('policy.reload')).length, 0); // 零行为：无事件
});

test('same-content mtime touch does not reload (no duplicate event, no extra backup)', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  const hashBefore = (await app.policyGet()).sha256;
  const now = new Date();
  // 纯 touch：mtime 变、内容不变（review-1 P3-1 场景）
  fs.utimesSync(app.file, now, now);
  assert.equal((await chat(app.url, 's2')).status, 200);
  const status = await app.policyGet();
  assert.equal(status.reloads, 0);
  assert.equal(reloadEvents(app, 'policy.reload').length, 0);
  assert.ok(!fs.existsSync(path.join(app.dir, 'backups', 'policy'))); // 无成功重载 = 无备份快照
  assert.equal(status.sha256, hashBefore);
});

test('deduped cold-zone refusal keeps reason and coldChanged for the CLI restart flow', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  edit(app, app.urls[0], app.urls[1], pick('first'), "mutate = (() => { this.backends[0].name = 'renamed'; return true; })();"); // 冷区变更（decide 不变）
  assert.equal((await chat(app.url, 's2')).status, 200); // 请求入口懒检查先触发一次拒绝
  const manual = await app.policyReload(); // 同一坏内容的手动触发 → 去重返回，但 reason 保真（review-1 P2-2）
  assert.equal(manual.outcome.kind, 'kept');
  assert.equal((manual.outcome as { reason?: string }).reason, 'cold-zone-change');
  assert.deepEqual((manual.outcome as { coldChanged?: string[] }).coldChanged, ['backends']);
});

test('concurrent reload merges into ONE audit event per content change', async (t) => {
  // 慢 import（顶层 await 300ms）窗口内 3 并发请求 → 只落 1 条 policy.reload（review-1 P2-1 场景）
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  edit(app, app.urls[0], app.urls[1], pick('second'), '', `await new Promise((r) => setTimeout(r, 300));\n`); // 顶层 await 拖慢 import
  const [a, b, c] = await Promise.all([chat(app.url, 'c1'), chat(app.url, 'c2'), chat(app.url, 'c3')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
  const status = await app.policyGet();
  assert.equal(status.lastError, null, `reload 失败现场：${String(status.lastError)}`);
  assert.equal(reloadEvents(app, 'policy.reload').length, 1);
  assert.equal(status.reloads, 1);
  assert.deepEqual(await seen(app), ['first', 'second', 'second', 'second']); // s1 首绑 first；三条并发全走新策略（合流等待，不绕过）
});

test('unreadable declaration (file replaced by a directory) keeps old policy and dedupes', async (t) => {
  const app = await setup(t, pick('first'));
  assert.equal((await chat(app.url, 's1')).status, 200);
  fs.rmSync(app.file);
  fs.mkdirSync(app.file); // statSync 成功但 readFileSync EISDIR（review-1 probe1 D 场景的可测变体；root 下 chmod 000 不成立）
  try {
    assert.equal((await chat(app.url, 's2')).status, 200);
    assert.deepEqual(await seen(app), ['first', 'first']); // 保旧
    const status = await app.policyGet();
    assert.match(String(status.lastError), /read failed/);
    const after1 = reloadEvents(app, 'policy.reload.error').length;
    assert.equal(after1, 1);
    assert.equal((await chat(app.url, 's3')).status, 200);
    assert.equal(reloadEvents(app, 'policy.reload.error').length, after1); // 同态去重
  } finally {
    fs.rmdirSync(app.file);
  }
  edit(app, app.urls[0], app.urls[1], pick('second'));
  assert.equal((await chat(app.url, 's4')).status, 200);
  assert.deepEqual(await seen(app), ['first', 'first', 'first', 'second']); // 恢复后照常热换
  assert.equal((await app.policyGet()).lastError, null);
});
