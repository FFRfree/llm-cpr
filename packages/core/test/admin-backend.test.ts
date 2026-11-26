import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayServers } from '../src/http/server.ts';
import { UsageAudit } from '../src/store/audit.ts';
import { CaptureStore } from '../src/store/capture.ts';
import type { GatewayConfig } from '../src/contracts.ts';
import { DatabaseSync } from 'node:sqlite';

const close = (server: Server): Promise<Error | undefined> => new Promise<Error | undefined>((resolve) => server.close(resolve));

// ---- 后台 v2 后端：分页/排序/聚合（audit.ts）与静态分发/事件端点（server.ts） ----

test('listRequestsPaged: page/total/sort/filters with whitelisted sort columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-admin-paged-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  for (let i = 0; i < 25; i++) {
    audit.record({ ts: 1000 + i, tenant: i < 15 ? 'main' : 'hermes', identity: `s-${i % 5}`, identity_kind: 'session',
      subscription: i % 2 ? 'sub-b' : 'sub-a', model: i % 3 ? 'm-1' : 'm-2', status: i % 7 === 0 ? 429 : 200, ms: 100 - i },
      i % 2 ? { prompt_tokens: 10 + i, completion_tokens: 5 } : null);
  }
  // 分页 + total
  const page1 = audit.listRequestsPaged({ page: 1, pageSize: 10 });
  assert.equal(page1.total, 25);
  assert.equal(page1.page_size, 10);
  assert.equal(page1.requests.length, 10);
  assert.equal(page1.requests[0].ts, 1024); // 默认 ts DESC
  const page3 = audit.listRequestsPaged({ page: 3, pageSize: 10 });
  assert.equal(page3.requests.length, 5);
  // 排序：ms ASC（ts 同序键用 id 二次排序）
  const byMs = audit.listRequestsPaged({ sort: 'ms', order: 'asc', pageSize: 10 });
  assert.equal(byMs.requests[0].ms, 76); // 25 行 ms=100..76，最小 76
  // 排序白名单：非法键回落 ts（不注入）
  const safe = audit.listRequestsPaged({ sort: 'ts; DROP TABLE requests', pageSize: 10 });
  assert.equal(safe.requests[0].ts, 1024);
  // 筛选：租户 + 模型 + 状态 + days
  assert.equal(audit.listRequestsPaged({ tenant: 'hermes' }).total, 10);
  assert.equal(audit.listRequestsPaged({ tenant: 'main', model: 'm-2' }).total, 5);
  assert.equal(audit.listRequestsPaged({ status: 429 }).total, 4);
  assert.equal(audit.listRequestsPaged({ days: 1, now: 1024 }).total, 25); // 窗口盖住全部
  assert.equal(audit.listRequestsPaged({ days: 1, now: 1002 }).total, 25); // days 只有下界（ts>=since），老于 now 的行也盖进来
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usageByDay: per subscription per BJT day bucket from the ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-usage-day-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  const BJT = 8 * 3_600_000;
  // now 取一个北京时间正午：当天桶 + 前一天桶（跨日边界）
  const now = Math.floor((Date.now() + BJT) / 86_400_000) * 86_400_000 - BJT + 12 * 3_600_000; // 今天的 BJT 12:00 (epoch 语义近似)
  const todayLocal = now;
  const yesterdayLocal = now - 86_400_000;
  audit.record({ ts: todayLocal, identity: 's', identity_kind: 'session', subscription: 'sub-a', status: 200 },
    { prompt_tokens: 100, completion_tokens: 10 });
  audit.record({ ts: todayLocal, tenant: 'hermes', identity: 's', identity_kind: 'session', subscription: 'sub-a', status: 403 }, null);
  audit.record({ ts: yesterdayLocal, identity: 's', identity_kind: 'session', subscription: 'sub-b', status: 200 },
    { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } });
  const usage = audit.usageByDay({ days: 7, now });
  assert.equal(usage.day_boundary, 'Asia/Shanghai (UTC+8)');
  assert.equal(usage.days.length, 7);
  const subA = usage.subscriptions.find((s) => s.subscription === 'sub-a');
  const subB = usage.subscriptions.find((s) => s.subscription === 'sub-b');
  assert.ok(subA && subB);
  assert.equal(subA.total.requests, 2);
  assert.equal(subA.total.errors, 1);
  assert.equal(subA.total.total_tokens, 110); // 只有租户默认那行有 usage
  assert.equal(subB.total.total_tokens, 44);
  assert.equal(subB.total.cache_hit_tokens, 30);
  // 桶数：两行同日合一桶，昨天一桶
  assert.equal(Object.keys(subA.by_day).length, 1);
  // 租户过滤
  assert.equal(audit.usageByDay({ days: 7, tenant: 'hermes', now }).subscriptions[0].total.requests, 1);
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessionsPaged: sort by computed full_miss_rate with null-last and pagination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-sessions-paged-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  // s-miss：两次请求，第二次全 miss → full_miss_rate=1
  audit.record({ ts: 1, identity: 's-miss', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } });
  audit.record({ ts: 2, identity: 's-miss', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } });
  // s-ok：两次全命中 → rate=0
  audit.record({ ts: 3, identity: 's-ok', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } });
  audit.record({ ts: 4, identity: 's-ok', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 100 } });
  // s-nocache：无 cache 观察 → full_miss_rate=null（排末尾）
  audit.record({ ts: 5, identity: 's-nocache', identity_kind: 'session', subscription: 'sub' }, { prompt_tokens: 10, completion_tokens: 1 });
  const paged = audit.listSessionsPaged({ sort: 'full_miss_rate', order: 'desc' });
  assert.equal(paged.total, 3);
  // null-last：没观察过 cache 的会话（rate=null）排在有数据的后面，且不受方向影响
  assert.deepEqual(paged.sessions.map((s) => s.identity), ['s-miss', 's-ok', 's-nocache']);
  assert.deepEqual(audit.listSessionsPaged({ sort: 'full_miss_rate', order: 'asc' }).sessions.map((s) => s.identity), ['s-ok', 's-miss', 's-nocache']);
  assert.equal(audit.listSessionsPaged({ sort: 'requests', order: 'desc' }).sessions[0].identity, 's-miss');
  assert.equal(audit.listSessionsPaged({ days: 1, now: 3 }).total, 3); // days 只有下界（同 requests 口径）
  assert.equal(audit.listSessionsPaged({ page: 2, pageSize: 10 }).sessions.length, 0); // 越界页空
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin v2 HTTP: paged endpoints, usage aggregation, events whitelist and static traversal guard', async (t: TestContext): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-admin-v2-'));
  const env = { CPR_SESSIONS_DB: path.join(dir, 'sessions.db'), CPR_USAGE_DB: path.join(dir, 'usage.db') };
  const config: GatewayConfig = {
    models: [{ id: 'unified', backends: { ccg: 'native' } }],
    backends: [{ name: 'sub-a', family: 'ccg', account: 'acct-a', base_url: 'http://127.0.0.1:1', key_env: 'KEY' }],
    admin: { port: 8740 },
  };
  const gateway = createGatewayServers(config, { env, logger: { warn() {}, log() {} } });
  gateway.adminServer.listen(0, '127.0.0.1');
  await once(gateway.adminServer, 'listening');
  t.after(async () => { await close(gateway.adminServer); await close(gateway.forwardServer); gateway.audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${(gateway.adminServer.address() as AddressInfo).port}`;
  gateway.audit.record({ ts: Date.now(), identity: 's-1', identity_kind: 'session', subscription: 'sub-a', model: 'unified', status: 200, ms: 10 },
    { prompt_tokens: 10, completion_tokens: 2 });
  gateway.audit.record({ ts: Date.now(), identity: 's-1', identity_kind: 'session', subscription: 'sub-a', model: 'unified', status: 200, ms: 12 },
    { prompt_tokens: 10, completion_tokens: 2 });

  // 分页形态（带 page）与旧形态（不带）并存
  const paged = await fetch(`${root}/api/audit/requests?page=1&page_size=10&sort=ms&order=asc`).then((r) => r.json());
  assert.equal(paged.total, 2);
  assert.equal(paged.requests.length, 2);
  assert.equal(paged.page_size, 10); // clamp 下限 10
  const legacy = await fetch(`${root}/api/audit/requests?limit=1`).then((r) => r.json());
  assert.equal(legacy.requests.length, 1);
  const sessionsPaged = await fetch(`${root}/api/audit/sessions?page=1&page_size=10&sort=last_ts&order=desc`).then((r) => r.json());
  assert.equal(sessionsPaged.total, 1);
  assert.equal(sessionsPaged.sessions[0].requests, 2);

  // 订阅实际消耗聚合端点
  const usage = await fetch(`${root}/api/audit/usage?days=7`).then((r) => r.json());
  assert.equal(usage.subscriptions[0].subscription, 'sub-a');
  assert.equal(usage.subscriptions[0].total.requests, 2);

  // 事件端点：kind 白名单内过滤；白名单外回落全量（不 500）
  await fetch(`${root}/api/events`).then(async (r) => { assert.equal(r.status, 200); return r.json(); });
  const events = await fetch(`${root}/api/events?kind=route.bind`).then((r) => r.json());
  assert.ok(Array.isArray(events.events));
  const evil = await fetch(`${root}/api/events?kind=route.bind%27%20OR%201%3D1--`).then((r) => r.json());
  assert.ok(Array.isArray(evil.events));

  // 静态分发：页面 200 + text/html；css 200 + text/css；穿越与未知路径 404
  const index = await fetch(`${root}/index.html`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
  const css = await fetch(`${root}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  assert.equal((await fetch(`${root}/trajectory.html`)).status, 200);
  assert.equal((await fetch(`${root}/nope.html`)).status, 404);
  assert.equal((await fetch(`${root}/../package.json`)).status, 404);
  assert.equal((await fetch(`${root}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${root}/api/audit/requests`)).status, 200); // API 不受静态分支影响
});

test('turnBody exposes per-message refs for the trajectory dedup view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-traj-refs-'));
  const capture = new CaptureStore({ dbFile: path.join(dir, 'capture.db'), ttlDays: 1, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  const body = { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] };
  const a = capture.capture({ tenant: 'main', identity: 's', identityKind: 'session', model: 'm', body, rawBytes: 100 });
  const b = capture.capture({ tenant: 'main', identity: 's', identityKind: 'session', model: 'm', body, rawBytes: 100 });
  assert.ok(a.captureId && b.captureId);
  capture.sweepNow(); // 落盘后 turnBody 才能从库里拼装（同 capture.test.ts 口径）
  const restored = capture.turnBody(capture.listTurns({}).find((t) => t.capture_id === b.captureId)!.id);
  assert.ok(restored);
  assert.equal(Array.isArray(restored.refs), true);
  assert.equal(restored.refs.length, 2); // 逐消息哈希
  const first = capture.turnBody(capture.listTurns({}).find((t) => t.capture_id === a.captureId)!.id);
  assert.deepEqual(restored.refs, first!.refs); // 相同正文 → 相同哈希序列（轨迹页「同上轮」判据）
  capture.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 轨迹聚合（tree / tree-diffs）：后端建树 + 新增段分页（tree-aggregation-api.md） ----

interface TreeFixture { capture: CaptureStore; ids: number[]; dir: string; dbFile: string; }
function buildTreeFixture(): TreeFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tree-'));
  const dbFile = path.join(dir, 'capture.db');
  const capture = new CaptureStore({ dbFile, ttlDays: 1, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  // 5 轮：t1 起点 → t2 续（新增回答+新输入）→ t3 = t2 重试（refs 全等）→ t4 同前缀分岔 → t5 压缩重启（无共享前缀）
  const bodies = [
    { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }] },
    { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }] },
    { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }] },
    { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u4-branch' }] },
    { model: 'm', messages: [{ role: 'system', content: 'sys-v2' }, { role: 'user', content: 'u3' }] },
  ];
  const ids: number[] = [];
  for (const body of bodies) {
    const out = capture.capture({ tenant: 'main', identity: 's', identityKind: 'session', model: 'm', body, rawBytes: 100 });
    assert.ok(out.captureId);
    capture.sweepNow(); // 立即落盘，listTurns 才查得到（flush 队列 250ms）
    ids.push(capture.listTurns({}).find((t) => t.capture_id === out.captureId)!.id);
  }
  return { capture, ids, dir, dbFile };
}

test('buildTree: parent by longest refs prefix, ×N retry merged, roles and window bounds', () => {
  const { capture, ids, cleanup } = (() => { const f = buildTreeFixture(); return { ...f, cleanup: () => { f.capture.close(); fs.rmSync(f.dir, { recursive: true, force: true }); } }; })();
  const tree = capture.buildTree('main', 's', 500);
  assert.equal(tree.nodes.length, 4); // t1 / t2+t3 同节点 / t4 / t5
  assert.equal(tree.window_turns, 5);
  assert.equal(tree.out_of_window, 0);
  const t1 = tree.nodes.find((n) => n.turns.some((t) => t.turn_id === ids[0]))!;
  const t23 = tree.nodes.find((n) => n.turns.length === 2)!;
  const t4 = tree.nodes.find((n) => n.turns.some((t) => t.turn_id === ids[3]))!;
  const t5 = tree.nodes.find((n) => n.turns.some((t) => t.turn_id === ids[4]))!;
  assert.ok(t1 && t23 && t4 && t5);
  assert.equal(t1.parent, null); // 线程起点
  assert.equal(t23.parent, t1.id); assert.equal(t23.parent_len, 2);
  assert.equal(t4.parent, t1.id); assert.equal(t4.parent_len, 2); // 与 t2 同父 → 兄弟分支
  assert.equal(t5.parent, null); // 压缩重启：与谁都不是前缀 → 新根
  assert.deepEqual(t1.added_count, 2);
  assert.deepEqual(t23.added_count, 2);
  assert.deepEqual(t23.added_roles, ['assistant', 'user']); // 回答+新输入（气泡判别口径）
  assert.deepEqual(t5.added_roles, ['system', 'user']);
  assert.ok((t1.added_bytes ?? 0) > 0 && (t23.added_bytes ?? 0) > 0);
  assert.deepEqual(tree.roots.sort(), [t1.id, t5.id].sort());
  assert.ok(Object.keys(tree.thread_labels).length >= 2); // 两个 thread_key（u1 系 / u3）
  assert.ok(tree.window.since_ts > 0 && tree.window.upto_ts >= tree.window.since_ts);
  cleanup();
});

test('treeDiffs: keyset pagination covers every turn exactly once with diff slices', () => {
  const { capture, ids, cleanup } = (() => { const f = buildTreeFixture(); return { ...f, cleanup: () => { f.capture.close(); fs.rmSync(f.dir, { recursive: true, force: true }); } }; })();
  const tree = capture.buildTree('main', 's', 500);
  const w = tree.window;
  const seen: Array<{ turn_id: number; start: number; messages: unknown[] }> = [];
  let afterTs = 0, afterId = 0, pages = 0;
  while (pages < 10) {
    const page = capture.treeDiffs('main', 's', { afterTs, afterId, sinceTs: w.since_ts, sinceId: w.since_id, uptoTs: w.upto_ts, limitTurns: 2 });
    pages += 1;
    for (const item of page.items) seen.push({ turn_id: item.turn_id, start: item.start, messages: item.messages as unknown[] });
    if (page.done) break;
    assert.ok(page.next_after);
    afterTs = page.next_after.ts; afterId = page.next_after.id;
  }
  assert.deepEqual(seen.map((s) => s.turn_id).sort((x, y) => x - y), [...ids].sort((x, y) => x - y)); // 每轮恰好一次
  const byId = new Map(seen.map((s) => [s.turn_id, s]));
  assert.equal(byId.get(ids[0])!.start, 0);
  assert.equal(byId.get(ids[0])!.messages.length, 2);
  const t2 = byId.get(ids[1])!;
  const t3 = byId.get(ids[2])!;
  assert.equal(t2.start, 2); // 新增段从父轮长度起
  assert.deepEqual((t2.messages[0] as { role: string }).role, 'assistant');
  assert.deepEqual((t2.messages[1] as { role: string }).role, 'user');
  assert.deepEqual(t3.messages, t2.messages); // 重试轮 diff 与原轮一致（refs 全等）
  assert.equal(byId.get(ids[4])!.start, 0); // 压缩重启：全量即新增
  const full = capture.turnBody(ids[1])!; // turnBody 交叉验证：diff 切片与全量拼装一致
  assert.deepEqual(t2.messages[0] as object, (full.body.messages as unknown[])[2]);
  cleanup();
});

test('treeDiffs: byte cap truncates and lone oversized turn still emitted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-tree-cap-'));
  const capture = new CaptureStore({ dbFile: path.join(dir, 'capture.db'), ttlDays: 1, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  const big = 'x'.repeat(3 * 1024 * 1024);
  const out1 = capture.capture({ tenant: 'main', identity: 's', identityKind: 'session', model: 'm', body: { model: 'm', messages: [{ role: 'user', content: big }] }, rawBytes: 100 });
  const out2 = capture.capture({ tenant: 'main', identity: 's', identityKind: 'session', model: 'm', body: { model: 'm', messages: [{ role: 'user', content: 'small' }] }, rawBytes: 100 });
  assert.ok(out1.captureId && out2.captureId);
  capture.sweepNow();
  const tree = capture.buildTree('main', 's', 500);
  const w = tree.window;
  const page = capture.treeDiffs('main', 's', { sinceTs: w.since_ts, sinceId: w.since_id, uptoTs: w.upto_ts, limitTurns: 60, byteCap: 64 * 1024 });
  assert.equal(page.items.length, 1); // 孤轮豁免：3MB 独轮单独成页
  assert.equal((page.items[0].messages[0] as { content: string }).content.length, 3 * 1024 * 1024);
  assert.equal(page.done, false);
  assert.ok(page.next_after);
  const page2 = capture.treeDiffs('main', 's', { afterTs: page.next_after.ts, afterId: page.next_after.id, sinceTs: w.since_ts, sinceId: w.since_id, uptoTs: w.upto_ts, limitTurns: 60, byteCap: 64 * 1024 });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.done, true);
  capture.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('treeDiffs: content TTL-missing hash degrades to null message, tree added_bytes null', () => {
  const f = buildTreeFixture();
  const t2full = f.capture.turnBody(f.ids[1])!;
  const victim = t2full.refs[2]; // a1 的哈希
  f.capture.close();
  const raw = new DatabaseSync(f.dbFile);
  raw.prepare('DELETE FROM content WHERE hash=?').run(victim);
  raw.close();
  const store = new CaptureStore({ dbFile: f.dbFile, ttlDays: 1, maxBodyBytes: 0, logger: {}, scheduleSweep: false });
  try {
    const tree = store.buildTree('main', 's', 500);
    const t23 = tree.nodes.find((n) => n.turns.some((t) => t.turn_id === f.ids[1]))!;
    assert.equal(t23.added_bytes, null); // 半截降级标记
    assert.deepEqual(t23.added_roles, [null, 'user']); // 首条正文没了 → role null
    const w = tree.window;
    const page = store.treeDiffs('main', 's', { sinceTs: w.since_ts, sinceId: w.since_id, uptoTs: w.upto_ts, limitTurns: 60 });
    const item = page.items.find((i) => i.turn_id === f.ids[1])!;
    assert.equal(item.messages[0], null); // 正文缺失 → null 占位
    assert.deepEqual((item.messages[1] as { role: string }).role, 'user'); // 其余条目不受连累
  } finally {
    store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
