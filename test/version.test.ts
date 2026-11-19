// 工单 07：管理口版本端点——打开看板才现查 npm registry（缓存 1h），进程零轮询；
// registry 不可达时降级只报当前版不炸。夹具 = core 拷贝 + twin policy + 本地假 registry。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const TWIN_MINE = `// 测试替身：本机 fixture 后端，绝不外联
import type { RouterPolicy } from './contract.ts';
export default class TwinMine implements RouterPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: 'twin-stub', family: 'ocg' as const, base_url: 'http://127.0.0.1:1/', key_env: 'TWIN_NOPE' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide(): null { return null; }
}
`;

interface RegistryStub { url: string; hits: () => number; close(): Promise<void> }

// 假 registry：/llm-cpr/latest → {"version":"9.9.9"}；每次命中计数（验证缓存窗口）。
async function makeRegistry(): Promise<RegistryStub> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/llm-cpr/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return port;
}

interface Engine { adminUrl: string; stop(): Promise<void> }

async function bootEngine(registryUrl: string, extra: Record<string, string> = {}): Promise<Engine> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-ver-'));
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  // package.json 带 name/version：RUNTIME_VERSION 从这里读（server.ts 同源）
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ type: 'module', name: 'llm-cpr', version: '0.1.0' }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'core', 'policy', 'mine.ts'), TWIN_MINE);
  const [forwardPort, adminPort] = await Promise.all([freePort(), freePort()]);
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-ver-db-'));
  const child = spawn(process.execPath, ['core/main.ts'], {
    cwd: root,
    env: {
      ...process.env,
      CPR_CONFIG_DIR: dbs,
      CPR_DATA_DIR: dbs,
      CPR_SESSIONS_DB: path.join(dbs, 'sessions.db'),
      CPR_USAGE_DB: path.join(dbs, 'usage.db'),
      CPR_FORWARD_PORT: String(forwardPort),
      CPR_ADMIN_PORT: String(adminPort),
      CPR_REGISTRY_URL: registryUrl,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  // 等管理口起来（用 route/status 探活——刻意不碰 /api/version，别污染 registry 命中计数）
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      const res = await fetch(`${adminUrl}/api/route/status`);
      if (res.ok) break;
    } catch { /* 未起，重试 */ }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`main.ts 未在时限内起来：${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    adminUrl,
    stop: async () => {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => { /* 已退出 */ });
    },
  };
}

test('版本端点：现查一次 + 缓存窗口内零重复请求（默认 TTL 1h）', async () => {
  const reg = await makeRegistry();
  const engine = await bootEngine(reg.url);
  try {
    const r1 = (await fetch(`${engine.adminUrl}/api/version`).then((r) => r.json())) as { version: string; latest: string | null; checkedAt: number };
    assert.equal(r1.version, '0.1.0'); // 当前运行版（engine package.json 同源）
    assert.equal(r1.latest, '9.9.9');
    assert.ok(r1.checkedAt > 0);
    assert.equal(reg.hits(), 1); // 现查恰好一次
    const r2 = (await fetch(`${engine.adminUrl}/api/version`).then((r) => r.json())) as { latest: string | null };
    assert.equal(r2.latest, '9.9.9');
    assert.equal(reg.hits(), 1); // 缓存窗口内：再打开看板也不重复打 registry
  } finally {
    await engine.stop();
    await reg.close();
  }
});

test('版本端点：TTL=0 接缝下每次现查（验证缓存窗口逻辑）', async () => {
  const reg = await makeRegistry();
  const engine = await bootEngine(reg.url, { CPR_LATEST_TTL_MS: '0' });
  try {
    await fetch(`${engine.adminUrl}/api/version`).then((r) => r.json());
    const hitsBefore = reg.hits();
    await fetch(`${engine.adminUrl}/api/version`).then((r) => r.json());
    assert.equal(reg.hits(), hitsBefore + 1); // TTL 0 → 缓存即过期，每次交互现查
  } finally {
    await engine.stop();
    await reg.close();
  }
});

test('版本端点：registry 不可达 → latest=null 降级不炸（看板照常显示当前版）', async () => {
  const deadPort = await freePort(); // 没人监听的端口 = registry 不可达
  const engine = await bootEngine(`http://127.0.0.1:${deadPort}`);
  try {
    const res = await fetch(`${engine.adminUrl}/api/version`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: string; latest: string | null };
    assert.equal(body.version, '0.1.0');
    assert.equal(body.latest, null); // 降级：查不到就报「不知道」，不炸端点
  } finally {
    await engine.stop();
  }
});
