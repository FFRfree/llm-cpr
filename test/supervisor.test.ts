// supervisor 骨架验收（supervisor-upgrade 票 01）：
//   bind 两口 → spawn worker（core/main.ts --worker）→ handle 交接 → ready → 就绪态；
//   fd 引用边界（worker 退出后 supervisor 持口不受影响、新连接仍可达）、roles 接缝、
//   journal 启动行两级版本、ready 超时杀 worker 报错退出。
// 全部走临时目录 + 假上游 + 空闲端口（绝不碰 8740/8741），spawn 一律异步收 exit。
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../core/supervisor.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// 假上游：/v1/chat/completions 回固定 JSON + /usage 回快照形状（快照轮询探活不炸）。
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

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  assert.ok(port !== 8740 && port !== 8741);
  return port;
}

interface Rig {
  env: Record<string, string>;
  forwardPort: number;
  adminPort: number;
  upstream: http.Server;
  upstreamPort: number;
  dir: string;
  journal: () => string[];
}

// 搭一个 supervisor 集成环境：临时 config/data 目录（CPR_* 接缝全集显式钉死）+ 假上游 + 空闲端口。
// supervisor 类在测试进程内运行，worker 是真子进程（node core/main.ts --worker，REPO 根的源码）。
async function makeRig(t: TestContext, extraEnv: Record<string, string> = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-supervisor-'));
  const upstream = fakeUpstream();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const [forwardPort, adminPort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(dir, 'policy.ts'), `// rig policy
export default class RigPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: 'sub', family: 'ocg' as const, base_url: 'http://127.0.0.1:${upstreamPort}/v1', key_env: 'RIG_UPSTREAM_KEY' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`);
  const env: Record<string, string> = {
    CPR_CONFIG_DIR: dir,
    CPR_DATA_DIR: dir,
    CPR_DB_FILE: path.join(dir, 'data.db'),
    CPR_FORWARD_PORT: String(forwardPort),
    CPR_ADMIN_PORT: String(adminPort),
    CPR_MASTER_KEY: 'rig-master',
    RIG_UPSTREAM_KEY: 'rig-upstream-key',
    CPR_WORKER_READY_DELAY_MS: '0',
    ...extraEnv,
  };
  const lines: string[] = [];
  const logger = {
    log: (msg: string): void => { lines.push(msg); },
    warn: (msg: string): void => { lines.push(`WARN ${msg}`); },
    error: (msg: string): void => { lines.push(`ERROR ${msg}`); },
  };
  const supervisor = new Supervisor({ env }, logger as unknown as Pick<Console, 'log' | 'warn' | 'error'>);
  t.after(async () => {
    await supervisor.stop();
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await supervisor.start();
  return { env, forwardPort, adminPort, upstream, upstreamPort, dir, journal: () => lines };
}

// 管理口就绪轮询（比 ready 消息更端到端：HTTP 真通才算）。
async function waitAdmin(adminPort: number, what: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      last = `HTTP ${res.status}`;
    } catch (error) { last = messageOf(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`管理口未就绪（${what}）：${last}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function chat(forwardPort: number, expectStatus = 200): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer rig-master', 'content-type': 'application/json', 'x-session-id': 'rig-session' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, expectStatus);
  if (expectStatus === 200) {
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    assert.equal(body.choices?.[0]?.message?.content, 'ok');
  }
  return res.status;
}

test('supervisor：bind 两口 → spawn worker → 交接 → ready → 网关经交接口服务（journal 报两级版本+角色）', async (t) => {
  const rig = await makeRig(t);
  await waitAdmin(rig.adminPort, 'ready 后管理口应 200');
  await chat(rig.forwardPort);
  const journal = rig.journal().join('\n');
  assert.match(journal, /llm-cpr supervisor 0\.6\.0 — roles: all — worker 0\.6\.0 pid \d+（forward :\d+ admin :\d+）/,
    `journal 启动行应报 supervisor/worker 两级版本与角色，实际=${journal}`);
});

test('fd 引用边界：worker 被 kill 后 supervisor 持口不空，新 worker 顶上后新连接仍可达', async (t) => {
  const rig = await makeRig(t);
  await waitAdmin(rig.adminPort, '首 worker 就绪');
  await chat(rig.forwardPort);
  const workerPid = Number((await waitAdmin(rig.adminPort, 'workerPid')).workerPid);
  assert.ok(Number.isInteger(workerPid) && workerPid > 0, '/api/version 应回 workerPid（fd 边界断言的锚点）');
  // 硬杀 worker：进程消失 ≠ 端口消失——supervisor 持有的监听口必须原地活着。
  process.kill(workerPid, 'SIGKILL');
  // 等 supervisor 重拉（warn 日志 + 新 worker ready）。
  const deadline = Date.now() + 10_000;
  let newPid = -1;
  while (Date.now() < deadline) {
    try {
      const info = (await fetch(`http://127.0.0.1:${rig.adminPort}/api/version`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json())) as { workerPid?: number };
      if (typeof info.workerPid === 'number' && info.workerPid !== workerPid) { newPid = info.workerPid; break; }
    } catch { /* 新 worker 未就绪，重试 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.notEqual(newPid, -1, 'worker 被 kill 后 supervisor 应重拉新 worker');
  await chat(rig.forwardPort); // 新连接仍可达（端口全程没空窗，也没 bind 冲突）
});

test('ready 超时：worker 拖着不发 ready → 被杀、supervisor 报错退出非 0（CLI 入口直跑验证）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-sup-timeout-'));
  const upstream = fakeUpstream();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const [forwardPort, adminPort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(dir, 'policy.ts'), `// rig policy
export default class RigPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: 'sub', family: 'ocg' as const, base_url: 'http://127.0.0.1:${upstreamPort}/v1', key_env: 'RIG_UPSTREAM_KEY' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`);
  const child = spawn(process.execPath, [path.join(REPO, 'core', 'supervisor.ts')], {
    cwd: REPO,
    env: {
      ...process.env,
      CPR_CONFIG_DIR: dir, CPR_DATA_DIR: dir, CPR_DB_FILE: path.join(dir, 'data.db'),
      CPR_FORWARD_PORT: String(forwardPort), CPR_ADMIN_PORT: String(adminPort),
      CPR_MASTER_KEY: 'rig-master', RIG_UPSTREAM_KEY: 'rig-upstream-key',
      CPR_WORKER_READY_DELAY_MS: '5000',      // 拖过 ready 门
      CPR_SUPERVISOR_READY_TIMEOUT_MS: '1500', // 门比拖延迟短：1.5s 即判超时
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3000); });
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.notEqual(code, 0, `ready 超时后 supervisor 应非 0 退出，stderr=${stderr}`);
  assert.match(stderr, /ready 超时/);
});

test('worker 开库失败照旧 fail fast：库打不开（CPR_DB_FILE 指向目录）→ worker 未发 ready 即退出，supervisor 报错', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-sup-bad-db-'));
  const upstream = fakeUpstream();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const [forwardPort, adminPort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(dir, 'policy.ts'), `// rig policy
export default class RigPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: 'sub', family: 'ocg' as const, base_url: 'http://127.0.0.1:${upstreamPort}/v1', key_env: 'RIG_UPSTREAM_KEY' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`);
  const supervisor = new Supervisor({
    env: {
      CPR_CONFIG_DIR: dir, CPR_DATA_DIR: dir,
      CPR_DB_FILE: dir, // 指向目录本身 → node:sqlite 打不开（fail fast 路径；root 下 chmod 拦不住，用形状错误拦）
      CPR_FORWARD_PORT: String(forwardPort), CPR_ADMIN_PORT: String(adminPort),
      CPR_MASTER_KEY: 'rig-master', RIG_UPSTREAM_KEY: 'rig-upstream-key',
    },
  }, { log: () => {}, warn: () => {}, error: (msg: string) => { stderrLines.push(msg); } } as unknown as Pick<Console, 'log' | 'warn' | 'error'>);
  const stderrLines: string[] = [];
  t.after(async () => {
    await supervisor.stop();
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(() => supervisor.start(), /未发 ready 即退出|开库/);
});

test('roles 接缝：非 all 角色构造即拒绝（本批只实现 all，结构留门）', () => {
  assert.throws(() => new Supervisor({ roles: [{ role: 'all' }, { role: 'relay' }] as never }), /角色 relay 未实现/);
});

test('resolveSupervisorEndpoints：env 优先、policy 缺省、坏值回落', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-sup-ep-'));
  try {
    const { resolveSupervisorEndpoints } = await import('../core/supervisor.ts');
    // 全 env 钉死：按 env 优先
    const viaEnv = await resolveSupervisorEndpoints({ CPR_FORWARD_PORT: '10001', CPR_ADMIN_PORT: '10002' } as NodeJS.ProcessEnv);
    assert.deepEqual(viaEnv, { host: '127.0.0.1', forwardPort: 10001, adminPort: 10002 });
    // 无 env 无 policy：默认口
    const defaults = await resolveSupervisorEndpoints({ CPR_CONFIG_DIR: path.join(dir, 'absent') } as NodeJS.ProcessEnv);
    assert.deepEqual(defaults, { host: '127.0.0.1', forwardPort: 8741, adminPort: 8740 });
    // policy 声明端口（无 env）：读 policy
    fs.writeFileSync(path.join(dir, 'policy.ts'), `export default class P { listen = { host: '127.0.0.1', port: 19001 }; admin = { host: '127.0.0.1', port: 19002 }; }`);
    const viaPolicy = await resolveSupervisorEndpoints({ CPR_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    assert.deepEqual(viaPolicy, { host: '127.0.0.1', forwardPort: 19001, adminPort: 19002 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
