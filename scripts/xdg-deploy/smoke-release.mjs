#!/usr/bin/env node
// 发布副本冒烟：用本机假上游验证一份运行副本能起、能转发、能钉会话、能记账、能出看板。
// 不触碰真实订阅额度；全部读写落在临时目录。
//
// 用法： node scripts/xdg-deploy/smoke-release.mjs [releaseDir]
//   releaseDir 默认 /root/.local/lib/coding-plan-router/current
// 退出码 0 = 全部通过。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const releaseDir = path.resolve(process.argv[2] || '/root/.local/lib/coding-plan-router/current');
const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cpr-release-smoke-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const freePort = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const steps = [];
const record = (name, detail = '') => { steps.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const upstreamHits = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  upstreamHits.push({ url: req.url, headers: req.headers, body });
  if (req.url === '/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [{ name: 'fake-account', monthly_percent: 10, month_progress: 30, exhausted: false }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    if (JSON.parse(body).stream) {
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
const upstreamPort = upstream.address().port;

const forwardPort = await freePort();
const adminPort = await freePort();
const configFile = path.join(tmpRoot, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  master_key_env: 'CPR_MASTER_KEY',
  identity_header: 'x-session-id',
  routing: { snapshot_interval_ms: 3_600_000, long_session_min_requests: 10 },
  backends: [{ name: 'fake-backend', family: 'ocg', base_url: `http://127.0.0.1:${upstreamPort}/v1`, key_env: 'FAKE_UPSTREAM_KEY' }],
  models: [{ id: 'unified-model', backends: { ocg: 'native-model' } }],
}, null, 2));

const sessionsDb = path.join(dataDir, 'sessions.db');
const child = spawn(process.execPath, [path.join(releaseDir, 'lib', 'main.mjs')], {
  cwd: releaseDir,
  env: {
    ...process.env,
    CPR_CONFIG_FILE: configFile,
    CPR_SESSIONS_DB: sessionsDb,
    CPR_MASTER_KEY: 'smoke-master',
    FAKE_UPSTREAM_KEY: 'fake-upstream-key',
    CPR_FORWARD_PORT: String(forwardPort),
    CPR_ADMIN_PORT: String(adminPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (chunk) => { childLog += chunk; });
child.stderr.on('data', (chunk) => { childLog += chunk; });

const forwardUrl = `http://127.0.0.1:${forwardPort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;

const waitReady = async (url, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`release process exited early (code ${child.exitCode}):\n${childLog}`);
    try {
      const response = await fetch(`${url}/api/snapshots`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`admin not ready: HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`release did not become ready: ${lastError?.message}\n${childLog}`);
};

try {
  assert.ok(fs.existsSync(path.join(releaseDir, 'lib', 'main.mjs')), `missing lib/main.mjs in ${releaseDir}`);
  assert.ok(fs.existsSync(path.join(releaseDir, 'static', 'dashboard.html')), `missing static/dashboard.html in ${releaseDir}`);
  record('发布副本结构', `${releaseDir}`);

  await waitReady(adminUrl);
  record('进程启动', `forward=${forwardPort} admin=${adminPort}`);

  const models = await fetch(`${forwardUrl}/v1/models`, { headers: { authorization: 'Bearer smoke-master' } });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map((model) => model.id), ['unified-model']);
  assert.equal((await fetch(`${forwardUrl}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  record('模型列表与鉴权', '/v1/models 200；错 key 401');

  const chat = await fetch(`${forwardUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer smoke-master', 'content-type': 'application/json', 'x-session-id': 'smoke-session' },
    body: JSON.stringify({ model: 'unified-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, 'ok');
  const chatHit = upstreamHits.find((hit) => hit.url === '/v1/chat/completions');
  assert.equal(chatHit.headers.authorization, 'Bearer fake-upstream-key');
  assert.equal(JSON.parse(chatHit.body).model, 'native-model');
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
  const routeStatusBody = await routeStatus.json();
  assert.ok(Array.isArray(routeStatusBody.preference), 'route/status 应带 preference 排名');
  record('管理口 /api/route/status', `preference=${JSON.stringify(routeStatusBody.preference)}`);

  const ledger = await fetch(`${adminUrl}/api/audit/requests?limit=5`);
  assert.equal(ledger.status, 200);
  const ledgerRows = (await ledger.json()).requests ?? [];
  assert.ok(ledgerRows.length >= 3, `账本应有 >=3 行，实际 ${ledgerRows.length}`);
  assert.ok(ledgerRows.every((row) => row.subscription === 'fake-backend'), '账本订阅名应为 fake-backend');
  record('账本写入', `${ledgerRows.length} 行，订阅名 fake-backend`);

  const sessions = await fetch(`${adminUrl}/api/audit/sessions?limit=5`);
  assert.equal(sessions.status, 200);
  const sessionRows = (await sessions.json()).sessions ?? [];
  assert.ok(sessionRows.length >= 2, '会话列表应有 >=2 个会话');
  record('会话聚合', `${sessionRows.length} 个会话`);

  const dashboard = await fetch(`${adminUrl}/`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.ok(dashboardHtml.includes('<html'), '看板应为 HTML');
  assert.ok(dashboardHtml.length > 5000, '看板内容长度异常');
  record('看板静态资源', `${dashboardHtml.length} 字节`);

  assert.ok(fs.existsSync(sessionsDb), '应使用显式指定的 sessions.db');
  assert.ok(fs.existsSync(path.join(dataDir, 'usage.db')), 'usage.db 应跟随 sessions.db 同目录');
  const strayDbs = fs.readdirSync(releaseDir).filter((name) => name.endsWith('.db'));
  assert.deepEqual(strayDbs, [], `发布目录不应出现数据库文件：${strayDbs.join(', ')}`);
  // 发布副本在 releases/ 下时，父目录也不能出现库文件；在临时 scratch 目录里跑就不查父目录（那里本就有别的测试残留）。
  if (path.basename(path.dirname(releaseDir)) === 'releases') {
    const parentDbs = fs.readdirSync(path.dirname(releaseDir)).filter((n) => n.endsWith('.db'));
    assert.deepEqual(parentDbs, [], `发布父目录不应出现数据库文件：${parentDbs.join(', ')}`);
  }
  record('数据落位', `${dataDir}（sessions.db + usage.db），发布目录无库文件`);
} catch (error) {
  child.kill('SIGKILL');
  upstream.close();
  console.error(`✗ 冒烟失败：${error.message}`);
  if (steps.length) console.error(`已通过：\n- ${steps.join('\n- ')}`);
  console.error(`临时目录保留以供排查：${tmpRoot}`);
  process.exitCode = 1;
  process.exit();
}

child.kill('SIGTERM');
await once(child, 'exit').catch(() => {});
upstream.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`✓ 发布副本冒烟全部通过（${releaseDir}）`);
for (const step of steps) console.log(`- ${step}`);
