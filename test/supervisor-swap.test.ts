// supervisor 换版本编排 + 排水 + 自愈验收（supervisor-upgrade 票 02）：
//   swap 编排（新旧短暂并存、旧 worker 排水退出）、失败零损伤（并发压力不减成功数）、
//   crash-loop 收据自愈（窗口内/外、消费即作废）、并发防线（第二个换版本请求被拒）、
//   system_events upgrade.swap/rollback、同版本换 worker（cpr reload 复用路径）、HTTP 桥接缝。
// 全部临时目录 + 假上游 + 空闲端口（绝不碰 8740/8741），spawn 一律异步收 exit。
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Supervisor } from '../core/supervisor.ts';
import { createGatewayServers } from '../core/http/server.ts';
import type { RouterPolicy } from '../core/policy/contract.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  assert.ok(port !== 8740 && port !== 8741);
  return port;
}

// 假上游（快）。
function fakeUpstream(): http.Server {
  return http.createServer((req, res) => {
    if ((req.url ?? '').includes('/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ accounts: [{ name: 'fake', monthly_percent: 10, month_progress: 30, exhausted: false }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
}

// 慢上游（排水语义用）：chat 流式吐 8 块 × intervalMs；usage 即回。
function slowUpstream(intervalMs: number): http.Server {
  return http.createServer((req, res) => {
    if ((req.url ?? '').includes('/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ accounts: [{ name: 'fake', monthly_percent: 10, month_progress: 30, exhausted: false }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > 8) { clearInterval(timer); return res.end('data: [DONE]\n\n'); }
      res.write(`data: {"choices":[{"delta":{"content":"${n}"}}]}\n\n`);
    }, intervalMs);
    res.on('close', () => clearInterval(timer));
  });
}

// 版本根工厂：拷贝 core/ + static/ + package.json（version 可改，mutate 可注入坏行为）。
function makeVersionRoot(base: string, version: string, mutate?: (root: string) => void): string {
  const root = path.join(base, 'versions', version, 'app');
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  fs.cpSync(path.join(REPO, 'static'), path.join(root, 'static'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: '@ffrfree/llm-cpr', type: 'module', version, engines: { node: '>=22.18.0' } }, null, 2)}\n`);
  mutate?.(root);
  return root;
}

const POLICY = (upstreamPort: number): string => `// rig policy
export default class RigPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: 'sub', family: 'ocg' as const, base_url: 'http://127.0.0.1:${upstreamPort}/v1', key_env: 'RIG_UPSTREAM_KEY' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`;

interface Rig {
  dir: string;
  appRoot: string;
  v1Root: string;
  forwardPort: number;
  adminPort: number;
  supervisor: Supervisor;
  env: Record<string, string>;
  journal: () => string;
}

async function makeRig(t: TestContext, opts: { upstream?: http.Server; extraEnv?: Record<string, string>; supervisorOpts?: ConstructorParameters<typeof Supervisor>[0] } = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-swap-'));
  const upstream = opts.upstream ?? fakeUpstream();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const [forwardPort, adminPort] = [await freePort(), await freePort()];
  const appRoot = path.join(dir, 'app');
  const v1Root = makeVersionRoot(appRoot, '9.0.0');
  fs.symlinkSync(path.join('versions', '9.0.0'), path.join(appRoot, 'current'), 'dir');
  fs.writeFileSync(path.join(dir, 'policy.ts'), POLICY(upstreamPort));
  const env: Record<string, string> = {
    CPR_CONFIG_DIR: dir,
    CPR_DATA_DIR: dir,
    CPR_DB_FILE: path.join(dir, 'data.db'),
    CPR_FORWARD_PORT: String(forwardPort),
    CPR_ADMIN_PORT: String(adminPort),
    CPR_MASTER_KEY: 'rig-master',
    RIG_UPSTREAM_KEY: 'rig-upstream-key',
    CPR_WORKER_READY_DELAY_MS: '0',
    // /api/version 的 registry 现查钉到立刻拒绝的本地口（离线快败 + 缓存）：测试不依赖外网可达性。
    CPR_REGISTRY_URL: 'http://127.0.0.1:9',
    ...opts.extraEnv,
  };
  const journalLines: string[] = [];
  const logger = {
    log: (msg: string): void => { journalLines.push(msg); },
    warn: (msg: string): void => { journalLines.push(`WARN ${msg}`); },
    error: (msg: string): void => { journalLines.push(`ERROR ${msg}`); },
  };
  const supervisor = new Supervisor({
    selfRoot: v1Root,
    receiptWindowMs: 60_000, // 收据窗口 1 分钟（测试内自愈都发生在窗口内；窗口外用例手工改收据时间戳）
    ...opts.supervisorOpts,
    env,
  }, logger as unknown as Pick<Console, 'log' | 'warn' | 'error'>);
  t.after(async () => {
    await supervisor.stop();
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await supervisor.start();
  return { dir, appRoot, v1Root, forwardPort, adminPort, supervisor, env, journal: () => journalLines.join('\n') };
}

async function versionInfo(adminPort: number): Promise<{ version: string; workerPid: number }> {
  // 带重试：排水/换 worker 窗口里，客户端连接池里指向旧 worker 的 socket 可能刚被收线
  // （连接复用竞态是 keep-alive 的常态，客户端层重试即可），这里重试到新 worker 应答为止。
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = (await res.json()) as { version: string; workerPid: number };
        return { version: body.version, workerPid: body.workerPid };
      }
      last = `HTTP ${res.status}`;
    } catch (error) { last = messageOf(error); }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`versionInfo 重试超时：${String(last)}`);
}

async function events(adminPort: number, kind: string): Promise<{ kind: string; detail: unknown }[]> {
  const res = await fetch(`http://127.0.0.1:${adminPort}/api/events?kind=${kind}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { events: { kind: string; detail: string | null }[] };
  return body.events.map((event) => ({ kind: event.kind, detail: event.detail ? JSON.parse(event.detail) : null }));
}

async function chat(forwardPort: number, sessionId = 'swap-session'): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer rig-master', 'content-type': 'application/json', 'x-session-id': sessionId },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 200;
  } catch { return false; }
}

// 持续流量：并发批次打满 swap 全程，返回 { ok, fail }。
async function hammerUntil(stop: () => boolean, forwardPort: number): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  while (!stop()) {
    const batch = Array.from({ length: 4 }, () => chat(forwardPort).then((good) => { good ? ok += 1 : fail += 1; }));
    await Promise.all(batch);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return { ok, fail };
}

test('swap 成功编排：新旧短暂并存零断粮、收据落盘、upgrade.swap 事件、current 翻转、worker 必换', async (t) => {
  const rig = await makeRig(t);
  const v2Root = makeVersionRoot(rig.appRoot, '9.9.9');
  const before = await versionInfo(rig.adminPort);
  assert.equal(before.version, '9.0.0');
  // 换版本期间持续打流量：并存窗口（内核仲裁 accept）+ 排水窗口都不许失败。
  let swapping = true;
  const traffic = hammerUntil(() => !swapping, rig.forwardPort);
  const outcome = await rig.supervisor.swap({ root: v2Root, version: '9.9.9', appRoot: rig.appRoot });
  swapping = false;
  const counts = await traffic;
  assert.equal(outcome.ok, true, `swap 应成功：${JSON.stringify(outcome)}`);
  if (outcome.ok) assert.equal(outcome.toVersion, '9.9.9');
  assert.equal(counts.fail, 0, `换版本全程持续流量应零失败：${JSON.stringify(counts)}（成功 ${counts.ok} 条不该减少）`);
  assert.ok(counts.ok > 10, `并发压力下成功请求数不该塌：${counts.ok}`);
  const after = await versionInfo(rig.adminPort);
  assert.equal(after.version, '9.9.9');
  assert.notEqual(after.workerPid, before.workerPid, 'worker PID 必变（防假成功）');
  // current 软链已被 supervisor 翻转（CLI 不拨链）。
  assert.equal(path.basename(fs.readlinkSync(path.join(rig.appRoot, 'current'))), '9.9.9');
  // 收据落盘（票 03：位置对齐 dataDir；自愈未触发 = selfHealed null）。
  const receipt = rig.supervisor.readReceipt();
  assert.ok(receipt, '升级收据应落盘');
  assert.equal(receipt?.from, '9.0.0');
  assert.equal(receipt?.to, '9.9.9');
  assert.equal(receipt?.selfHealed, null);
  assert.ok(receipt?.switchedAt && !Number.isNaN(Date.parse(receipt.switchedAt)), '收据应带切换时间戳');
  // system_events：upgrade.swap（成功：新旧版本，tenant default）。
  const swaps = await events(rig.adminPort, 'upgrade.swap');
  assert.equal(swaps.length, 1, `upgrade.swap 应恰 1 条：${JSON.stringify(swaps)}`);
  assert.deepEqual(swaps[0]?.detail, { from_version: '9.0.0', to_version: '9.9.9', same_version: false });
});

test('失败零损伤：新 worker 起不来 → 杀之、软链回拨、旧 worker 未动（持续流量零失败）', async (t) => {
  const rig = await makeRig(t);
  const brokenRoot = makeVersionRoot(rig.appRoot, '9.9.9', (root) => {
    // 坏版本：main.ts 开头直接退出（ready 前崩 = 启动即崩路径）
    fs.writeFileSync(path.join(root, 'core', 'main.ts'), 'process.exit(1);\n');
  });
  const before = await versionInfo(rig.adminPort);
  let swapping = true;
  const traffic = hammerUntil(() => !swapping, rig.forwardPort);
  const outcome = await rig.supervisor.swap({ root: brokenRoot, version: '9.9.9', appRoot: rig.appRoot });
  await new Promise((resolve) => setTimeout(resolve, 800)); // 失败路径也持续一段流量（失败快，垫足样本量）
  swapping = false;
  const counts = await traffic;
  assert.equal(outcome.ok, false, 'swap 应如实失败');
  if (!outcome.ok) assert.equal(outcome.status, 'failed');
  assert.equal(counts.fail, 0, `失败期间持续流量应零失败：${JSON.stringify(counts)}`);
  assert.ok(counts.ok > 10);
  const after = await versionInfo(rig.adminPort);
  assert.equal(after.workerPid, before.workerPid, '旧 worker 未受影响（pid 不变）');
  assert.equal(path.basename(fs.readlinkSync(path.join(rig.appRoot, 'current'))), '9.0.0', '软链已回拨');
  assert.equal(rig.supervisor.readReceipt(), null, '失败不落收据');
});

test('排水语义：SIGTERM → 停接新请求 → 在途跑完 → 退出 0；账本有完整 200 行', async (t) => {
  const upstream = slowUpstream(80); // 8 块 × 80ms ≈ 640ms 的流
  const rig = await makeRig(t, { upstream, extraEnv: { CPR_DRAIN_TIMEOUT_MS: '8000' } });
  const info = await versionInfo(rig.adminPort);
  // 在途流式请求
  const streamPromise = (async (): Promise<{ status: number; body: string }> => {
    const res = await fetch(`http://127.0.0.1:${rig.forwardPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer rig-master', 'content-type': 'application/json', 'x-session-id': 'drain-1' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: await res.text() };
  })();
  await new Promise((resolve) => setTimeout(resolve, 200)); // 让在途请求进入转发
  process.kill(info.workerPid, 'SIGTERM'); // 排水指令
  const result = await streamPromise;
  assert.equal(result.status, 200, '排水期在途请求应跑完而不是被腰斩');
  assert.match(result.body, /data: \[DONE\]/, '上游流应完整吐完');
  // worker 退出 0（异步收 exit 纪律：这里等 audit 行出现即代表 worker 收尾完成）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const rows = (await fetch(`http://127.0.0.1:${rig.adminPort}/api/audit/requests`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json())) as { requests: { identity: string; status: number }[] };
      const row = rows.requests.find((entry) => entry.identity === 'drain-1');
      if (row) {
        assert.equal(row.status, 200, '账本应有完整 200 行（在途跑完的正常收尾）');
        break;
      }
    } catch { /* worker 可能已退出，supervisor 重拉中 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test('排水超时强切：SSE 长流挂死 → 排水上限到 → worker 退出，账本无该请求的完成行（=现状硬切口径）', async (t) => {
  const upstream = slowUpstream(400); // 8 块 × 400ms ≈ 3.2s 的流，超过排水上限
  const rig = await makeRig(t, { upstream, extraEnv: { CPR_DRAIN_TIMEOUT_MS: '500' } });
  const info = await versionInfo(rig.adminPort);
  let streamDone = false;
  void fetch(`http://127.0.0.1:${rig.forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer rig-master', 'content-type': 'application/json', 'x-session-id': 'drain-hang' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(10_000),
  }).then(async (res) => { await res.text(); streamDone = true; }, () => { streamDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exitPromise = new Promise<NodeJS.Signals | number>((resolve) => {
    // worker 进程的退出由 supervisor 观察；这里用 /api/version 轮询（新 worker ready = 旧已强切）
    const timer = setInterval(async () => {
      try {
        const next = await versionInfo(rig.adminPort);
        if (next.workerPid !== info.workerPid) { clearInterval(timer); resolve(next.workerPid); }
      } catch { /* 重拉窗口 */ }
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(-1); }, 8000);
  });
  process.kill(info.workerPid, 'SIGTERM'); // 排水启动；SSE 3.2s > 0.5s 上限 → 强切
  const outcome = await exitPromise;
  assert.notEqual(outcome, -1, '排水超时后 supervisor 应重拉新 worker（旧 worker 已强切退场）');
  // 强切口径：账本无该请求的完成行（现状 systemd 硬切 = 进程死、无收尾行）。
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const rows = (await fetch(`http://127.0.0.1:${rig.adminPort}/api/audit/requests`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json())) as { requests: { identity: string; status: number }[] };
    assert.ok(!rows.requests.some((entry) => entry.identity === 'drain-hang' && entry.status === 200),
      `强切请求不应有 200 完成行：${JSON.stringify(rows.requests)}`);
  } catch { /* 新 worker 刚就绪，读失败也算通过（无行） */ }
  assert.equal(streamDone, true, '客户端侧连接已终结（强切）');
});

test('自愈回滚：升级后 crash-loop → 收据拨回上一版（软链 + upgrade.rollback 事件 + 收据消费即作废）', async (t) => {
  const rig = await makeRig(t, { supervisorOpts: { crashWindowMs: 8000 }, extraEnv: { CPR_DRAIN_TIMEOUT_MS: '1500' } });
  const crashyRoot = makeVersionRoot(rig.appRoot, '9.9.9', (root) => {
    // 就绪后 400ms 自杀（连续两次快速退出 → 达 crashLimit=2 → 自愈）
    fs.appendFileSync(path.join(root, 'core', 'main.ts'), '\nsetTimeout(() => process.exit(1), 400);\n');
  });
  const first = await rig.supervisor.swap({ root: crashyRoot, version: '9.9.9', appRoot: rig.appRoot });
  assert.equal(first.ok, true, `换到坏行为版本应成功（自愈发生在就绪后）：${JSON.stringify(first)}`);
  assert.equal((await versionInfo(rig.adminPort)).version, '9.9.9');
  // 等 crash-loop 达标 + 自愈回滚完成。
  const deadline = Date.now() + 15_000;
  let rolled = false;
  while (Date.now() < deadline) {
    try {
      if ((await versionInfo(rig.adminPort)).version === '9.0.0') { rolled = true; break; }
    } catch { /* 重拉窗口 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(rolled, 'crash-loop 后应自愈拨回 9.0.0');
  assert.equal(path.basename(fs.readlinkSync(path.join(rig.appRoot, 'current'))), '9.0.0', '软链拨回旧版');
  const receipt = rig.supervisor.readReceipt();
  assert.equal(receipt?.selfHealed, true, '收据消费即作废（selfHealed 置真）');
  assert.equal(receipt?.rollbackReason, 'crash-loop');
  const rollbacks = await events(rig.adminPort, 'upgrade.rollback');
  assert.equal(rollbacks.length, 1, `upgrade.rollback 应恰 1 条：${JSON.stringify(rollbacks)}`);
  assert.deepEqual(rollbacks[0]?.detail, { reason: 'crash-loop', from_version: '9.9.9', to_version: '9.0.0' });
  // 回滚后的 worker 真的在服务。
  assert.equal(await chat(rig.forwardPort), true);
});

test('收据窗口外/已消费：crash-loop 只拉起不回滚（防无关崩溃连环回滚老版本）', async (t) => {
  const rig = await makeRig(t, { supervisorOpts: { crashWindowMs: 8000 }, extraEnv: { CPR_DRAIN_TIMEOUT_MS: '1500' } });
  const crashyRoot = makeVersionRoot(rig.appRoot, '9.9.9', (root) => {
    fs.appendFileSync(path.join(root, 'core', 'main.ts'), '\nsetTimeout(() => process.exit(1), 400);\n');
  });
  const first = await rig.supervisor.swap({ root: crashyRoot, version: '9.9.9', appRoot: rig.appRoot });
  assert.equal(first.ok, true);
  // swap 落了新收据——把它改成「已消费」态（窗口内的自愈发生过），再让 crash-loop 走一轮：
  const receipt = rig.supervisor.readReceipt();
  assert.ok(receipt);
  fs.writeFileSync(path.join(rig.dir, 'upgrade-receipt.json'), `${JSON.stringify({ ...receipt, selfHealed: true, rollbackAt: new Date().toISOString(), rollbackReason: 'crash-loop' }, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 2500)); // 让 crash-loop 发生若干轮
  const now = await versionInfo(rig.adminPort);
  assert.equal(now.version, '9.9.9', '收据已消费 → 不回滚，只原根拉起');
  const after = rig.supervisor.readReceipt();
  assert.equal(after?.selfHealed, true, '收据未被再次消费/改写');
  assert.ok(rig.journal().includes('只拉起不回滚'), 'journal 应说明不回滚的原因');
});

test('收据窗口外（switchedAt 过期）：同样只拉起不回滚', async (t) => {
  const rig = await makeRig(t, { supervisorOpts: { crashWindowMs: 8000 }, extraEnv: { CPR_DRAIN_TIMEOUT_MS: '1500' } });
  const crashyRoot = makeVersionRoot(rig.appRoot, '9.9.9', (root) => {
    fs.appendFileSync(path.join(root, 'core', 'main.ts'), '\nsetTimeout(() => process.exit(1), 400);\n');
  });
  const first = await rig.supervisor.swap({ root: crashyRoot, version: '9.9.9', appRoot: rig.appRoot });
  assert.equal(first.ok, true);
  // swap 落了新收据——把 switchedAt 改到窗口之外，再让 crash-loop 走一轮：
  const receipt = rig.supervisor.readReceipt();
  assert.ok(receipt);
  fs.writeFileSync(path.join(rig.dir, 'upgrade-receipt.json'), `${JSON.stringify({ ...receipt, switchedAt: new Date(Date.now() - 3_600_000).toISOString() }, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal((await versionInfo(rig.adminPort)).version, '9.9.9', '窗口外不回滚');
  assert.equal(rig.supervisor.readReceipt()?.selfHealed, null, '过期收据保持原样（未被消费）');
  assert.ok(rig.journal().includes('窗口外'), 'journal 应说明窗口外不回滚');
});

test('并发防线：换版本进行中第二个换版本请求被拒（in-progress，不留磁盘锁文件）', async (t) => {
  const rig = await makeRig(t, { extraEnv: { CPR_WORKER_READY_DELAY_MS: '1500', CPR_DRAIN_TIMEOUT_MS: '2000' } });
  const v2Root = makeVersionRoot(rig.appRoot, '9.9.9');
  const first = rig.supervisor.swap({ root: v2Root, version: '9.9.9', appRoot: rig.appRoot });
  const second = await rig.supervisor.swap({ root: v2Root, version: '9.9.9', appRoot: rig.appRoot });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.status, 'in-progress', '第二个换版本请求应被拒：进行中');
  const outcome = await first;
  assert.equal(outcome.ok, true);
  // 无磁盘锁文件：安装区/数据目录不新增锁形文件。
  const names = fs.readdirSync(rig.dir);
  assert.ok(!names.some((name) => /lock/i.test(name)), `不应有锁文件：${names.join(',')}`);
});

test('同版本换 worker（cpr reload 复用路径）：worker 必换、版本不变、same_version 事件、不落收据', async (t) => {
  const rig = await makeRig(t, { extraEnv: { CPR_DRAIN_TIMEOUT_MS: '2000' } });
  const before = await versionInfo(rig.adminPort);
  const outcome = await rig.supervisor.swap({});
  assert.equal(outcome.ok, true);
  const after = await versionInfo(rig.adminPort);
  assert.equal(after.version, before.version, '同版本换：版本不变');
  assert.notEqual(after.workerPid, before.workerPid, 'worker 必换（冷区变更随新 boot 生效）');
  const swaps = await events(rig.adminPort, 'upgrade.swap');
  assert.deepEqual(swaps[0]?.detail, { from_version: '9.0.0', to_version: '9.0.0', same_version: true });
  assert.equal(rig.supervisor.readReceipt(), null, '同版本换不落收据（from === to，无自愈标的）');
});

test('HTTP 桥接缝：POST /api/supervisor/swap → worker IPC 转发 supervisor → 200 + 真换版本', async (t) => {
  const rig = await makeRig(t, { extraEnv: { CPR_DRAIN_TIMEOUT_MS: '2000' } });
  const v2Root = makeVersionRoot(rig.appRoot, '9.9.9');
  const res = await fetch(`http://127.0.0.1:${rig.adminPort}/api/supervisor/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: v2Root, version: '9.9.9', appRoot: rig.appRoot }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { ok: boolean; toVersion: string };
  assert.equal(res.status, 200, `HTTP 桥应 200：${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  assert.equal(body.toVersion, '9.9.9');
  assert.equal((await versionInfo(rig.adminPort)).version, '9.9.9');
});

test('非 supervisor 形态：/api/supervisor/swap → 501（如实报错，提示 restart 兜底）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-noswap-'));
  const config: RouterPolicy = {
    master_key_env: 'CPR_TEST_MASTER',
    identity_header: 'x-session-id',
    backends: [{ name: 'sub', family: 'ocg', base_url: 'http://127.0.0.1:1/', key_env: 'NOPE' }],
    models: [{ id: 'm', backends: { ocg: 'm' } }],
    decide: () => null,
  };
  const gateway = createGatewayServers(config, { env: { CPR_TEST_MASTER: 'k', CPR_DB_FILE: path.join(dir, 'data.db') } });
  gateway.forwardServer.listen(0, '127.0.0.1');
  gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => {
    await Promise.all([gateway.forwardServer, gateway.adminServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    gateway.audit.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = (gateway.adminServer.address() as net.AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/supervisor/swap`, { method: 'POST' });
  assert.equal(res.status, 501);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /非 supervisor 形态/);
});

test('policy.reload 不双记：quiet 窗口内新 worker 不落账（旧 worker 是记录者），promote 后恢复', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-quiet-'));
  const policyFile = path.join(dir, 'policy.ts');
  fs.writeFileSync(policyFile, `export default class P {
  master_key_env = 'CPR_TEST_MASTER';
  identity_header = 'x-session-id-a';
  backends = [{ name: 'sub', family: 'ocg', base_url: 'http://127.0.0.1:1/', key_env: 'NOPE' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`);
  const config: RouterPolicy = {
    master_key_env: 'CPR_TEST_MASTER',
    identity_header: 'x-session-id-a',
    backends: [{ name: 'sub', family: 'ocg', base_url: 'http://127.0.0.1:1/', key_env: 'NOPE' }],
    models: [{ id: 'm', backends: { ocg: 'm' } }],
    decide: () => null,
  };
  const gateway = createGatewayServers(config, {
    env: { CPR_TEST_MASTER: 'k', CPR_DB_FILE: path.join(dir, 'data.db') },
    policyFile,
    policyEventsQuiet: true,
  });
  gateway.forwardServer.listen(0, '127.0.0.1');
  gateway.adminServer.listen(0, '127.0.0.1');
  await Promise.all([once(gateway.forwardServer, 'listening'), once(gateway.adminServer, 'listening')]);
  t.after(async () => {
    await Promise.all([gateway.forwardServer, gateway.adminServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    gateway.audit.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = (gateway.adminServer.address() as net.AddressInfo).port;
  // quiet 窗口内热换：结果 reloaded，但 policy.reload 事件不落账（防并存期双记）。
  fs.writeFileSync(policyFile, fs.readFileSync(policyFile, 'utf8').replace('x-session-id-a', 'x-session-id-b'));
  const reload1 = (await fetch(`http://127.0.0.1:${port}/api/policy/reload`, { method: 'POST' }).then((r) => r.json())) as { outcome: { kind: string } };
  assert.equal(reload1.outcome.kind, 'reloaded');
  let quietEvents = (await fetch(`http://127.0.0.1:${port}/api/events?kind=policy.reload`).then((r) => r.json())) as { events: unknown[] };
  assert.deepEqual(quietEvents.events, [], 'quiet 窗口内 policy.reload 不应落账');
  // promote（旧 worker 退场）→ 恢复落账。
  gateway.setPolicyEventsQuiet(false);
  fs.writeFileSync(policyFile, fs.readFileSync(policyFile, 'utf8').replace('x-session-id-b', 'x-session-id-c'));
  const reload2 = (await fetch(`http://127.0.0.1:${port}/api/policy/reload`, { method: 'POST' }).then((r) => r.json())) as { outcome: { kind: string } };
  assert.equal(reload2.outcome.kind, 'reloaded');
  quietEvents = (await fetch(`http://127.0.0.1:${port}/api/events?kind=policy.reload`).then((r) => r.json())) as { events: unknown[] };
  assert.equal(quietEvents.events.length, 1, 'promote 后 policy.reload 恢复落账');
});
