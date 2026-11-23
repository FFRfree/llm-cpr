import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayServers } from '../core/http/server.ts';
import { UsageAudit } from '../core/store/audit.ts';
import { CaptureStore } from '../core/store/capture.ts';
import type { GatewayConfig } from '../core/contracts.ts';

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

test('usageByHour: per subscription per BJT hour bucket with 7-day window cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-usage-hour-'));
  const audit = new UsageAudit({ dbFile: path.join(dir, 'usage.db') });
  const BJT = 8 * 3_600_000;
  // now 取北京时间某天 13:30：当小时桶 + 前一小时桶（跨小时边界）
  const dayStart = Math.floor((Date.now() + BJT) / 86_400_000) * 86_400_000 - BJT; // 今天 BJT 00:00 (epoch 语义近似)
  const now = dayStart + 13 * 3_600_000 + 30 * 60_000;
  const h13 = dayStart + 13 * 3_600_000;
  const h12 = dayStart + 12 * 3_600_000;
  const yesterday15 = dayStart - 86_400_000 + 15 * 3_600_000;
  audit.record({ ts: h13 + 60_000, identity: 's', identity_kind: 'session', subscription: 'sub-a', status: 200 },
    { prompt_tokens: 100, completion_tokens: 10 });
  audit.record({ ts: h13 + 120_000, tenant: 'hermes', identity: 's', identity_kind: 'session', subscription: 'sub-a', status: 403 }, null);
  audit.record({ ts: h12 + 60_000, identity: 's', identity_kind: 'session', subscription: 'sub-b', status: 200 },
    { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } });
  audit.record({ ts: yesterday15, identity: 's', identity_kind: 'session', subscription: 'sub-a', status: 200 },
    { prompt_tokens: 5, completion_tokens: 1 });
  const hour = audit.usageByHour({ days: 7, now });
  assert.equal(hour.granularity, 'hour');
  assert.equal(hour.day_boundary, 'Asia/Shanghai (UTC+8)');
  assert.equal(hour.hours.length, 168); // 7 天 = 168 个小时桶
  // 标签形如 YYYY-MM-DDTHH，且最新桶是 now 所在小时
  assert.match(hour.hours[0], /^\d{4}-\d{2}-\d{2}T\d{2}$/);
  const subA = hour.subscriptions.find((s) => s.subscription === 'sub-a');
  const subB = hour.subscriptions.find((s) => s.subscription === 'sub-b');
  assert.ok(subA && subB);
  assert.equal(subA.total.requests, 3);
  assert.equal(subA.total.errors, 1);
  assert.equal(subA.total.total_tokens, 116); // 110（今天）+ 6（昨天 15 时）
  assert.equal(Object.keys(subA.by_hour).length, 2); // 两个有数据的桶：h13 两行合一桶 + 昨天 15 时
  assert.equal(subA.by_hour[hourLabel(h13)].requests, 2);
  assert.equal(subB.by_hour[hourLabel(h12)].total_tokens, 44);
  assert.equal(subB.by_hour[hourLabel(h12)].cache_hit_tokens, 30);
  // 窗口上限：days 超喂也被压到 7 天
  assert.equal(audit.usageByHour({ days: 30, now }).hours.length, 168);
  // 租户过滤
  assert.equal(audit.usageByHour({ days: 7, tenant: 'hermes', now }).subscriptions[0].total.requests, 1);
  audit.close();
  fs.rmSync(dir, { recursive: true, force: true });
  function hourLabel(ts: number): string {
    return new Date(Math.floor((ts + BJT) / 3_600_000) * 3_600_000 - BJT).toISOString().slice(0, 13);
  }
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

  // 订阅实际消耗聚合端点（日桶 + 小时桶两种粒度）
  const usage = await fetch(`${root}/api/audit/usage?days=7`).then((r) => r.json());
  assert.equal(usage.subscriptions[0].subscription, 'sub-a');
  assert.equal(usage.subscriptions[0].total.requests, 2);
  const usageHour = await fetch(`${root}/api/audit/usage?bucket=hour&days=7`).then((r) => r.json());
  assert.equal(usageHour.granularity, 'hour');
  assert.ok(usageHour.hours.length <= 168); // 小时桶窗口硬上限 7 天
  assert.equal(usageHour.subscriptions[0].total.requests, 2); // 同账本同口径

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
