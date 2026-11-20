#!/usr/bin/env node
// 发布副本冒烟：用本机假上游验证一份运行副本能起、能转发、能钉会话、能记账、能出看板。
// 不触碰真实订阅额度；全部读写落在临时目录。
//
// 用法： node scripts/xdg-deploy/smoke-release.ts [releaseDir | npm包.tgz]
//   v0.2.0 发布纪律：给 `npm pack` 出的 .tgz，本脚本解包（package/ 前缀）后冒烟——验的即发布的字节；
//   也接受已解包的目录（含 core/ package.json）；缺省指本机旧 release 软链（阶段 3 切换前的生产实况）。
// 退出码 0 = 全部通过。
import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const input = process.argv[2] || '/root/.local/lib/coding-plan-router/current';
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cpr-release-smoke-'));
let releaseDir = path.resolve(input);
if (input.endsWith('.tgz')) {
  // npm pack 产物：tar 包内根目录是 package/，解到 tmp 后冒烟那份。
  const extract = spawnSync('tar', ['-xf', releaseDir, '-C', tmpRoot], { encoding: 'utf8' });
  if (extract.status !== 0) {
    console.error(`cpr: 解包 ${releaseDir} 失败：${extract.stderr ?? ''}`);
    process.exit(1);
  }
  releaseDir = path.join(tmpRoot, 'package');
}
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const freePort = async (): Promise<number> => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve: () => void): void => { server.close((): void => resolve()); });
  return port;
};

const steps: string[] = [];
const record = (name: string, detail: string = ''): void => { steps.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const upstreamHits: { url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
const upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Unexpected request chunk');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  upstreamHits.push({ url: req.url, headers: req.headers, body });
  if (req.url === '/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [{ name: 'fake-account', monthly_percent: 10, month_progress: 30, exhausted: false }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'stream' in parsed && parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
const upstreamPort = upstreamAddress.port;

const forwardPort = await freePort();
const adminPort = await freePort();
// 配置即代码：冒烟不跑 release 的 main.ts（那是生产声明），用临时启动器直传假 policy。
const launcher = path.join(tmpRoot, 'smoke-launcher.mjs');
fs.writeFileSync(launcher, [
  `import { startGateway } from ${JSON.stringify(path.join(releaseDir, 'core', 'http', 'server.ts'))};`,
  `await startGateway({`,
  `  master_key_env: 'CPR_MASTER_KEY',`,
  `  identity_header: 'x-session-id',`,
  `  routing: { snapshot_interval_ms: 3_600_000, long_session_min_requests: 10 },`,
  `  backends: [{ name: 'fake-backend', family: 'ocg', base_url: ${JSON.stringify(`http://127.0.0.1:${upstreamPort}/v1`)}, key_env: 'FAKE_UPSTREAM_KEY' }],`,
  `  models: [{ id: 'unified-model', backends: { ocg: 'native-model' } }],`,
  `});`,
].join('\n'));

const sessionsDb = path.join(dataDir, 'data.db');
const child = spawn(process.execPath, [launcher], {
  cwd: tmpRoot,
  env: {
    ...process.env,
    CPR_DB_FILE: sessionsDb,
    CPR_MASTER_KEY: 'smoke-master',
    FAKE_UPSTREAM_KEY: 'fake-upstream-key',
    CPR_FORWARD_PORT: String(forwardPort),
    CPR_ADMIN_PORT: String(adminPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (chunk: unknown): void => { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) childLog += chunk; else throw new TypeError('Unexpected child output'); });
child.stderr.on('data', (chunk: unknown): void => { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) childLog += chunk; else throw new TypeError('Unexpected child output'); });

const forwardUrl = `http://127.0.0.1:${forwardPort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;

const waitReady = async (url: string, timeoutMs: number = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`release process exited early (code ${child.exitCode}):\n${childLog}`);
    try {
      const response = await fetch(`${url}/api/snapshots`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`admin not ready: HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 150); });
  }
  throw new Error(`release did not become ready: ${lastError instanceof Error ? lastError.message : undefined}\n${childLog}`);
};

try {
  assert.ok(fs.existsSync(path.join(releaseDir, 'core', 'main.ts')), `missing core/main.ts in ${releaseDir}`);
  // 后台 v2：单页 dashboard.html 已拆为多页（index + 4 页 + 共享 assets），断言随契约更新
  assert.ok(fs.existsSync(path.join(releaseDir, 'static', 'index.html')), `missing static/index.html in ${releaseDir}`);
  for (const asset of ['requests.html', 'sessions.html', 'trajectory.html', 'observability.html', path.join('assets', 'app.css'), path.join('assets', 'app.js')]) {
    assert.ok(fs.existsSync(path.join(releaseDir, 'static', asset)), `missing static/${asset} in ${releaseDir}`);
  }
  // .ts 的模块类型由最近的 package.json 决定；缺了它就只能靠 Node 语法探测兜底。
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(releaseDir, 'package.json'), 'utf8'));
  assert.ok(isRecord(manifest) && manifest.type === 'module', '发布副本必须带 package.json 且 "type": "module"');
  record('发布副本结构', `${releaseDir}`);

  await waitReady(adminUrl);
  record('进程启动', `forward=${forwardPort} admin=${adminPort}`);

  const models = await fetch(`${forwardUrl}/v1/models`, { headers: { authorization: 'Bearer smoke-master' } });
  assert.equal(models.status, 200);
  const modelsBody: unknown = await models.json();
  assert.ok(isRecord(modelsBody) && Array.isArray(modelsBody.data));
  assert.deepEqual(modelsBody.data.map((model: unknown): unknown => isRecord(model) ? model.id : undefined), ['unified-model']);
  assert.equal((await fetch(`${forwardUrl}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  record('模型列表与鉴权', '/v1/models 200；错 key 401');

  const chat = await fetch(`${forwardUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer smoke-master', 'content-type': 'application/json', 'x-session-id': 'smoke-session' },
    body: JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);
  const chatBody: unknown = await chat.json();
  assert.ok(isRecord(chatBody) && Array.isArray(chatBody.choices));
  const choice: unknown = chatBody.choices[0];
  assert.ok(isRecord(choice) && isRecord(choice.message));
  assert.equal(choice.message.content, 'ok');
  const chatHit = upstreamHits.find((hit: { url: string | undefined; headers: IncomingHttpHeaders; body: string }): boolean => hit.url === '/v1/chat/completions');
  assert.ok(chatHit);
  assert.equal(chatHit.headers.authorization, 'Bearer fake-upstream-key');
  const hitBody: unknown = JSON.parse(chatHit.body);
  assert.ok(isRecord(hitBody));
  assert.equal(hitBody.model, 'native-model');
  assert.equal(chatHit.headers['x-opencode-session'], 'smoke-session');
  record('聊天转发', '上行换 key、换模型名、保留 OCG session 头');

  const again = await fetch(`${forwardUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer smoke-master', 'content-type': 'application/json', 'x-session-id': 'smoke-session' },
    body: JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'again' }] }),
  });
  assert.equal(again.status, 200);
  await again.text();

  const stream = await fetch(`${forwardUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer smoke-master', 'content-type': 'application/json', 'x-session-id': 'smoke-stream' },
    body: JSON.stringify({ model: 'unified-model', stream: true }),
  });
  assert.equal(stream.status, 200);
  assert.equal(await stream.text(), 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  record('SSE 直通', '字节级一致');

  const routeStatus = await fetch(`${adminUrl}/api/route/status`);
  assert.equal(routeStatus.status, 200);
  const routeStatusBody: unknown = await routeStatus.json();
  assert.ok(isRecord(routeStatusBody));
  assert.ok(Array.isArray(routeStatusBody.preference), 'route/status 应带 preference 排名');
  record('管理口 /api/route/status', `preference=${JSON.stringify(routeStatusBody.preference)}`);

  const ledger = await fetch(`${adminUrl}/api/audit/requests?limit=5`);
  assert.equal(ledger.status, 200);
  const ledgerBody: unknown = await ledger.json();
  assert.ok(isRecord(ledgerBody));
  const ledgerRows: unknown = ledgerBody.requests ?? [];
  assert.ok(Array.isArray(ledgerRows));
  assert.ok(ledgerRows.length >= 3, `账本应有 >=3 行，实际 ${ledgerRows.length}`);
  assert.ok(ledgerRows.every((row: unknown): boolean => isRecord(row) && row.subscription === 'fake-backend'), '账本订阅名应为 fake-backend');
  record('账本写入', `${ledgerRows.length} 行，订阅名 fake-backend`);

  const sessions = await fetch(`${adminUrl}/api/audit/sessions?limit=5`);
  assert.equal(sessions.status, 200);
  const sessionsBody: unknown = await sessions.json();
  assert.ok(isRecord(sessionsBody));
  const sessionRows: unknown = sessionsBody.sessions ?? [];
  assert.ok(Array.isArray(sessionRows));
  assert.ok(sessionRows.length >= 2, '会话列表应有 >=2 个会话');
  record('会话聚合', `${sessionRows.length} 个会话`);

  const dashboard = await fetch(`${adminUrl}/`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.ok(dashboardHtml.includes('<html'), '看板应为 HTML');
  assert.ok(dashboardHtml.length > 5000, '看板内容长度异常');
  record('看板静态资源', `${dashboardHtml.length} 字节`);

  assert.ok(fs.existsSync(sessionsDb), '应使用显式指定的 data.db');
  const strayDbs = fs.readdirSync(releaseDir).filter((name: string): boolean => name.endsWith('.db'));
  assert.deepEqual(strayDbs, [], `发布目录不应出现数据库文件：${strayDbs.join(', ')}`);
  // 发布副本在 releases/ 下时，父目录也不能出现库文件；在临时 scratch 目录里跑就不查父目录（那里本就有别的测试残留）。
  if (path.basename(path.dirname(releaseDir)) === 'releases') {
    const parentDbs = fs.readdirSync(path.dirname(releaseDir)).filter((n: string): boolean => n.endsWith('.db'));
    assert.deepEqual(parentDbs, [], `发布父目录不应出现数据库文件：${parentDbs.join(', ')}`);
  }
  record('数据落位', `${dataDir}（data.db 单库双表），发布目录无库文件`);
} catch (error) {
  child.kill('SIGKILL');
  upstream.close();
  console.error(`✗ 冒烟失败：${error instanceof Error ? error.message : undefined}`);
  if (steps.length) console.error(`已通过：\n- ${steps.join('\n- ')}`);
  console.error(`临时目录保留以供排查：${tmpRoot}`);
  process.exitCode = 1;
  process.exit();
}

// ---- supervisor 形态冒烟段（supervisor-upgrade 票 04）----
// 同一假上游再喂一个 supervisor 实例：临时 policy.ts + node core/supervisor.ts + 同版本 swap 一次
// （ready 门 + fd 交接 + 排水换 worker 全链路；workerPid 必变 = 换人实锤）。旧发布件没有
// core/supervisor.ts 时如实跳过（v0.1.0 形态副本无 supervisor 可冒烟）。
if (fs.existsSync(path.join(releaseDir, 'core', 'supervisor.ts'))) {
  const supConfig = path.join(tmpRoot, 'sup-config');
  const supData = path.join(tmpRoot, 'sup-data');
  fs.mkdirSync(supConfig, { recursive: true });
  fs.mkdirSync(supData, { recursive: true });
  fs.writeFileSync(path.join(supConfig, 'policy.ts'), [
    `// 冒烟临时 policy（supervisor 形态段 @ ${new Date().toISOString()}）：与 launcher 同一套假声明，`,
    '// 但走 policy.ts 文件加载路（supervisor 形态的实况：worker 按 CPR_CONFIG_DIR/policy.ts 起）。',
    'export default class SmokeSupPolicy {',
    "  master_key_env = 'CPR_MASTER_KEY';",
    "  identity_header = 'x-session-id';",
    `  backends = [{ name: 'fake-backend', family: 'ocg' as const, base_url: 'http://127.0.0.1:${upstreamPort}/v1', key_env: 'FAKE_UPSTREAM_KEY' }];`,
    "  models = [{ id: 'unified-model', backends: { ocg: 'native-model' } }];",
    '  decide() { return null; }',
    '}',
    '',
  ].join('\n'));
  const supForwardPort = await freePort();
  const supAdminPort = await freePort();
  const supChild = spawn(process.execPath, [path.join(releaseDir, 'core', 'supervisor.ts')], {
    cwd: releaseDir,
    env: {
      ...process.env,
      CPR_CONFIG_DIR: supConfig,
      CPR_DATA_DIR: supData,
      CPR_DB_FILE: path.join(supData, 'data.db'),
      CPR_APP_ROOT: path.join(tmpRoot, 'sup-app-root'),
      CPR_FORWARD_PORT: String(supForwardPort),
      CPR_ADMIN_PORT: String(supAdminPort),
      CPR_MASTER_KEY: 'smoke-master',
      FAKE_UPSTREAM_KEY: 'fake-upstream-key',
      CPR_REGISTRY_URL: 'http://127.0.0.1:9', // /api/version 现查 registry：钉死口，冒烟不碰网
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let supLog = '';
  supChild.stdout.on('data', (chunk: unknown): void => { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) supLog += chunk; });
  supChild.stderr.on('data', (chunk: unknown): void => { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) supLog += chunk; });
  try {
    const supAdminUrl = `http://127.0.0.1:${supAdminPort}`;
    const supForwardUrl = `http://127.0.0.1:${supForwardPort}`;
    const waitSupVersion = async (): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 15_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        if (supChild.exitCode !== null) throw new Error(`supervisor exited early (code ${supChild.exitCode}):\n${supLog}`);
        try {
          const response = await fetch(`${supAdminUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) return (await response.json()) as Record<string, unknown>;
          lastError = new Error(`admin not ready: HTTP ${response.status}`);
        } catch (error) { lastError = error; }
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 150); });
      }
      throw new Error(`supervisor admin not ready: ${lastError instanceof Error ? lastError.message : ''}\n${supLog}`);
    };
    const supV1 = await waitSupVersion();
    const pid1: unknown = supV1.workerPid;
    assert.ok(typeof pid1 === 'number' && pid1 > 0, `/api/version 应回 workerPid，实际=${JSON.stringify(supV1)}`);
    const swapRes = await fetch(`${supAdminUrl}/api/supervisor/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
    const swapText = await swapRes.text();
    assert.equal(swapRes.status, 200, `同版本 swap 应 200，实际 ${swapRes.status}：${swapText.slice(0, 300)}`);
    const swapBody: unknown = JSON.parse(swapText);
    assert.ok(isRecord(swapBody) && swapBody.ok === true, `同版本 swap 应成功：${swapText.slice(0, 300)}`);
    assert.ok(isRecord(swapBody) && typeof swapBody.workerPid === 'number' && swapBody.workerPid !== pid1,
      `swap 后 workerPid 必变：${String(pid1)} → ${isRecord(swapBody) ? String(swapBody.workerPid) : '?'}`);
    const supChat = await fetch(`${supForwardUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer smoke-master', 'content-type': 'application/json', 'x-session-id': 'smoke-sup' },
      body: JSON.stringify({ model: 'unified-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(supChat.status, 200, `supervisor 形态聊天转发应 200：${(await supChat.text()).slice(0, 200)}`);
    record('supervisor 形态冒烟', `同版本 swap 换 worker（pid ${String(pid1)}→${isRecord(swapBody) ? String(swapBody.workerPid) : '?'}），经交接口转发 200`);
  } catch (error) {
    supChild.kill('SIGKILL');
    upstream.close();
    console.error(`✗ 冒烟失败（supervisor 形态段）：${error instanceof Error ? error.message : undefined}`);
    if (steps.length) console.error(`已通过：\n- ${steps.join('\n- ')}`);
    console.error(`临时目录保留以供排查：${tmpRoot}`);
    process.exitCode = 1;
    process.exit();
  }
  supChild.kill('SIGTERM');
  await once(supChild, 'exit').catch((): void => {});
} else {
  console.log('- supervisor 形态冒烟：跳过（副本无 core/supervisor.ts——v0.1.0 形态发布件）');
}

child.kill('SIGTERM');
await once(child, 'exit').catch((): void => {});
upstream.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`✓ 发布副本冒烟全部通过（${releaseDir}）`);
for (const step of steps) console.log(`- ${step}`);
