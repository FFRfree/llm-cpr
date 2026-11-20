// run-scenarios.ts — e2e 场景运行器：把 fake-upstream + cpr-instance + pi-driver 拼成三个真跑场景。
//
// 用法：node run-scenarios.ts [--scenario=1|2|5]（逗号分隔可多选；缺省全跑 1/2/5）
//            [--repo-dir=<路径>]（可选，npm pack 源；缺省=本套件所在仓的仓根自身）
//            [--worktree=<路径>]（可选，覆盖 --repo-dir：临时工作树/别的检出的 pack 源）
//
// 场景定义（与任务书对齐）：
//   1 冒烟+工具调用：ok 剧本 + write 工具参数 + 1 cpr 实例；runPi 让 pi 建 hello.txt。
//   2 亲和粘住：同实例同 sessionId 两轮 runPi，都打 be-a，route.bind 恰 1 条无 rebind。
//   5 热更新三连：(a) 首轮过 → (b) decide 钉 be-b（热区，policy.reload 落账）→
//                (c) 语法坏文件保旧（policy.reload.error，错误摘要不含文件全文）→
//                (d) 冷区加 be-c，cpr reload CLI 喂 N 拒重启，随后仍走 be-b。
//
// 硬红线（脚本内强制）：
//   · 端口断言避开 {8740, 8741}（pickPort + startCprInstance/fake-upstream 双层各查一遍）。
//   · 绝不读写 /root/.llm-cpr、/root/.config、~/.hermes（合规 TMPDIR scratch 区除外）——所有落盘
//     路径都断言在本 e2e 目录或 TMPDIR 下；CLI 进程再垫 CPR_CONFIG_DIR/CPR_DATA_DIR 改道。
//   · 绝不调用 systemctl 启停：唯一允许的是只读生产 PID 比对
//     （XDG_RUNTIME_DIR=/run/user/0 systemctl --user show llm-cpr -p MainPID,ActiveState）；
//     cpr reload CLI 经 CPR_SYSTEMCTL 接缝指向 stub（记 argv 进日志），喂 N 拒绝重启确认 +
//     CPR_UNIT_NAME=e2e-cpr-test.service 安全垫双保险，跑完断言 stub 日志为空 = 零 systemctl 调用。
//   · 每轮 runPi / CLI 跑前记生产 MainPID、跑后验不变，变了整套判失败。
//
// 与任务定义的一处已声明偏差：场景 1「--record 过滤 POST 聊天请求恰 1 条」在真实工具执行回路下
// 不可能成立——首轮回 tool_calls、pi 执行 write 工具、次轮回灌 role:tool 拿最终回答，必然 2 条
// POST（假上游的工具启发本身也按两轮设计）。脚本按「带工具调用的首轮恰 1 条 + 全部 Bearer
// e2e-test-key」校验，并在输出里注明。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  startCprInstance,
  E2E_MASTER_KEY,
  E2E_MASTER_KEY_ENV,
  E2E_MODEL_ID,
  type CprInstance,
  type CprPorts,
} from './cpr-instance.ts';
import { runPi } from './pi-driver.ts';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
// 套件住在 <仓根>/scripts/e2e/ 下：缺省打包对象 = 仓根自身（“每次改动收尾跑一行”不需要任何参数）。
const defaultRepoDir = path.resolve(here, '..', '..');
let packDir = defaultRepoDir;
const fakeUpstreamPath = path.join(here, 'fake-upstream.ts');
const piCwdName = 'pi-cwd';
const piHomeName = 'pi-home';

const FORBIDDEN_PORTS: readonly number[] = [8740, 8741];
const PROTECTED_PREFIXES: readonly string[] = ['/root/.llm-cpr', '/root/.config', '/root/.hermes'];
const SANCTIONED_TMP = process.env.TMPDIR || os.tmpdir();
const PROD_UNIT = 'llm-cpr';
const PROD_ENV = { XDG_RUNTIME_DIR: '/run/user/0' };

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const runsRoot = path.join(here, 'runs', STAMP);

// —— 红线：路径护栏 ——————————————————————————————————————————————

function assertPathSafe(target: string, what: string): void {
  const resolved = path.resolve(target);
  const inProtected = PROTECTED_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`));
  const sanctionedTmp = resolved === SANCTIONED_TMP || resolved.startsWith(`${SANCTIONED_TMP}/`);
  const inE2e = resolved === here || resolved.startsWith(`${here}/`);
  const inTmp = resolved === os.tmpdir() || resolved.startsWith(`${os.tmpdir()}/`);
  assert.ok(!inProtected || sanctionedTmp || inE2e || inTmp,
    `${what} 不允许落在受保护目录（${PROTECTED_PREFIXES.join(' / ')}）：${resolved}`);
}

// —— 端口分配（避开生产保留口 + 本运行去重） ———————————————————————

const usedPorts = new Set<number>();

async function pickPort(label: string): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const picked = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(picked));
    });
  });
  assert.ok(!FORBIDDEN_PORTS.includes(port), `${label} 抽到生产保留端口 ${port}，拒绝使用`);
  assert.ok(!usedPorts.has(port), `${label} 端口 ${port} 与本运行已分配端口冲突`);
  usedPorts.add(port);
  return port;
}

async function pickPorts(): Promise<CprPorts> {
  return {
    infer: await pickPort('infer'),
    admin: await pickPort('admin'),
    upstreamA: await pickPort('upstreamA'),
    upstreamB: await pickPort('upstreamB'),
  };
}

// —— 进程台账（收尾断言无残留） ————————————————————————————————————

const liveProcesses: { label: string; pid: number }[] = [];

async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function forgetPid(pid: number): void {
  const index = liveProcesses.findIndex((entry) => entry.pid === pid);
  if (index >= 0) liveProcesses.splice(index, 1);
}

// —— 假上游驱动 ————————————————————————————————————————————————————

interface FakeUpstream {
  pid: number;
  port: number;
  recordPath: string;
  stderr(): string;
  stop(): Promise<void>;
}

async function startFakeUpstream(opts: {
  label: string;
  port: number;
  scenario: string;
  recordPath: string;
  toolCall?: string;
  toolArgs?: string;
}): Promise<FakeUpstream> {
  assert.ok(!FORBIDDEN_PORTS.includes(opts.port), `${opts.label} 端口 ${opts.port} 命中生产保留口，拒绝启动`);
  assertPathSafe(opts.recordPath, `${opts.label} --record`);
  fs.mkdirSync(path.dirname(opts.recordPath), { recursive: true });
  const argv = [fakeUpstreamPath, '--port', String(opts.port), '--scenario', opts.scenario, '--record', opts.recordPath];
  if (opts.toolCall !== undefined) argv.push('--tool-call', opts.toolCall);
  if (opts.toolArgs !== undefined) argv.push('--tool-args', opts.toolArgs);
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
  const pid = child.pid!;
  liveProcesses.push({ label: opts.label, pid });
  const ready = await new Promise<boolean>((resolve) => {
    const check = (): boolean => stderrBuf.includes(`listening http://127.0.0.1:${opts.port}`);
    const timer = setTimeout(() => { clearInterval(interval); resolve(false); }, 10_000);
    const interval = setInterval(() => { if (check()) { clearTimeout(timer); clearInterval(interval); resolve(true); } }, 100);
    child.once('exit', () => { clearTimeout(timer); clearInterval(interval); resolve(false); });
    if (check()) { clearTimeout(timer); clearInterval(interval); resolve(true); }
  });
  if (!ready) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    forgetPid(pid);
    throw new Error(`fake-upstream(${opts.label}) 10s 内未就绪：${stderrBuf.slice(-800)}`);
  }
  return {
    pid,
    port: opts.port,
    recordPath: opts.recordPath,
    stderr: () => stderrBuf,
    async stop(): Promise<void> {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(); }, 3_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      const gone = await waitPidGone(pid, 3_000);
      if (!gone) throw new Error(`fake-upstream(${opts.label}) pid=${pid} stop 后仍存活`);
      forgetPid(pid);
    },
  };
}

interface RecordLine {
  ts: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function readRecord(recordPath: string): RecordLine[] {
  try {
    return fs.readFileSync(recordPath, 'utf8')
      .split('\n').filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RecordLine);
  } catch { return []; }
}

function chatPosts(lines: RecordLine[]): RecordLine[] {
  return lines.filter((line) => line.method === 'POST'
    && (line.url ?? '').split('?')[0].endsWith('/chat/completions'));
}

// —— 管理口读侧 ————————————————————————————————————————————————————

async function adminJson(adminPort: number, pathname: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${adminPort}${pathname}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(res.status, 200, `管理口 GET ${pathname} 应 200，实际 ${res.status}`);
  return await res.json();
}

async function pollAdmin(adminPort: number, pathname: string, until: (data: any) => boolean, what: string, timeoutMs = 6_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  for (;;) {
    last = await adminJson(adminPort, pathname);
    if (until(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`等待超时：${what}；最后数据=${JSON.stringify(last)?.slice(0, 800)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface ParsedEvent { backend_name: string | null; detail: any; kind: string }

function parseEvents(payload: any): ParsedEvent[] {
  return (payload?.events ?? []).map((row: any) => ({
    kind: row.kind,
    backend_name: row.backend_name ?? null,
    detail: typeof row.detail === 'string' ? safeParse(row.detail) : row.detail ?? null,
  }));
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return { __raw: text }; }
}

// —— 生产 PID 只读比对（唯一允许的 systemctl 用法） ——————————————————

interface ProdState { pid: number | null; state: string; raw: string }

async function prodState(): Promise<ProdState> {
  if (process.env.CPR_E2E_SKIP_PID_GUARD === '1') {
    // CI 容器内没有宿主 systemd；豁免只在显式 env 下生效，本地跑永远不豁免。
    return { pid: null, state: 'skipped', raw: 'PID 护栏豁免（CPR_E2E_SKIP_PID_GUARD=1）' };
  }
  const { stdout } = await execFileAsync('systemctl',
    ['--user', 'show', PROD_UNIT, '-p', 'MainPID,ActiveState'],
    { env: { ...process.env, ...PROD_ENV }, timeout: 15_000, encoding: 'utf8' });
  const pid = Number(/^MainPID=(\d+)$/m.exec(stdout)?.[1] ?? '');
  const state = /^ActiveState=(.+)$/m.exec(stdout)?.[1]?.trim() ?? '';
  return { pid: Number.isFinite(pid) && pid > 0 ? pid : null, state, raw: stdout.trim() };
}

async function prodUnchanged(before: ProdState): Promise<void> {
  if (before.pid === null) return; // 豁免模式（CI）
  const after = await prodState();
  assert.equal(after.pid, before.pid,
    `生产 ${PROD_UNIT} 的 MainPID 变了：${before.pid} → ${after.pid}（e2e 绝不允许扰动生产进程）`);
  assert.equal(after.state, before.state,
    `生产 ${PROD_UNIT} ActiveState 变了：${before.state} → ${after.state}`);
}

// —— runPi 轮次包装：跑前记生产 PID、跑后验不变 ——————————————————————

interface RoundOptions {
  inferPort: number;
  sessionId: string;
  prompt: string;
  cwd: string;
  homeDir: string;
}

async function piRound(opts: RoundOptions): Promise<Awaited<ReturnType<typeof runPi>>> {
  const before = await prodState();
  assert.ok(before.pid !== null || process.env.CPR_E2E_SKIP_PID_GUARD === '1',
    `跑前读生产 ${PROD_UNIT} 状态失败：${before.raw}`);
  const pi = await runPi({
    inferPort: opts.inferPort,
    model: E2E_MODEL_ID,
    sessionId: opts.sessionId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    homeDir: opts.homeDir,
    timeoutMs: 120_000,
  });
  await prodUnchanged(before);
  return pi;
}

// —— 共用断言 ————————————————————————————————————————————————————

function assertChatBearer(chats: RecordLine[], what: string): void {
  for (const chat of chats) {
    assert.equal(chat.headers['authorization'], `Bearer ${E2E_MASTER_KEY}`,
      `${what} 的上游 Authorization 应为 Bearer e2e-test-key，实际=${chat.headers['authorization']}`);
  }
}

function assertAuditRows(rows: any[], what: string): void {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${what}：管理口账本应为非空`);
  for (const row of rows) {
    assert.equal(row.status, 200, `${what}：账本行 status 应 200，实际=${row.status}`);
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      assert.ok(Number.isFinite(row[key]) && row[key] !== null,
        `${what}：账本行 usage ${key} 应为非空数字，实际=${JSON.stringify(row[key])}`);
    }
  }
}

async function assertInstanceStopped(inst: CprInstance): Promise<void> {
  await inst.stop();
  const gone = await waitPidGone(inst.pid, 3_000);
  if (!gone) throw new Error(`cpr 实例 pid=${inst.pid} stop 后仍存活`);
  forgetPid(inst.pid);
}

// —— 场景 1：冒烟 + write 工具调用 ——————————————————————————————————

async function scenario1(runDir: string): Promise<void> {
  const ports = await pickPorts();
  const recordA = path.join(runDir, 'upstream-a.jsonl');
  const fakeA = await startFakeUpstream({
    label: 's1-be-a', port: ports.upstreamA, scenario: 'ok', recordPath: recordA,
    toolCall: 'write', toolArgs: JSON.stringify({ path: 'hello.txt', content: 'e2e-ok' }),
  });
  const inst = await startCprInstance({
    repoDir: packDir, ports,
    configDir: path.join(runDir, 'cpr-config'), dataDir: path.join(runDir, 'cpr-data'),
  });
  liveProcesses.push({ label: 's1-cpr', pid: inst.pid });
  try {
    const piCwd = path.join(runDir, piCwdName);
    const piHome = path.join(runDir, piHomeName);
    const pi = await piRound({
      inferPort: ports.infer, sessionId: 'e2e-s1',
      prompt: 'create hello.txt containing e2e-ok', cwd: piCwd, homeDir: piHome,
    });
    assert.equal(pi.exitCode, 0, `pi 应 exit 0，实际=${pi.exitCode}（stderr=${pi.stderr.slice(0, 600)}）`);
    assert.equal(pi.timedOut, false, 'pi 不应超时');

    // ② hello.txt 存在且内容对（write 工具参数原文写入）
    const helloPath = path.join(piCwd, 'hello.txt');
    assert.ok(fs.existsSync(helloPath), `hello.txt 应存在（pi cwd=${piCwd}）`);
    const hello = fs.readFileSync(helloPath, 'utf8');
    assert.equal(hello.trim(), 'e2e-ok', `hello.txt 内容应为 e2e-ok，实际=${JSON.stringify(hello)}`);

    // ③ pi JSONL 有 tool_execution 事件（write 工具）
    const toolEvents = pi.events.filter((event) => String(event.type ?? '').startsWith('tool_execution'));
    assert.ok(toolEvents.some((event) => event.toolName === 'write'),
      `JSONL 应有 toolName=write 的 tool_execution 事件；事件类型=${JSON.stringify(pi.events.map((event) => event.type))}`);

    // ④ 假上游 --record：POST 聊天请求。真实工具执行回路必然两轮（工具轮 + 回灌最终回答轮），
    //    「恰 1 条」按「带工具调用的首轮恰 1 条」校验（偏差已在文件头声明）。
    const chats = chatPosts(readRecord(recordA));
    assert.equal(chats.length, 2,
      `假上游 A 的 POST 聊天请求应为 2 条（工具轮+最终轮），实际=${chats.length}`);
    assertChatBearer(chats, 's1');
    const toolTurns = chats.filter((chat) => Array.isArray((chat.body as any)?.tools)
      && (chat.body as any).tools.length > 0
      && !((chat.body as any)?.messages ?? []).some((m: any) => m?.role === 'tool'));
    assert.equal(toolTurns.length, 1, '带 tools 且无 role:tool 的首轮请求应恰 1 条');
    assert.ok(chats.some((chat) => ((chat.body as any)?.messages ?? []).some((m: any) => m?.role === 'tool')),
      '次轮请求应回灌 role:tool 工具结果');

    // ⑤ 管理口账本：该请求 status 200 且 usage 数字非空
    const audit = await pollAdmin(ports.admin, '/api/audit/requests',
      (data) => (data?.requests?.length ?? 0) >= 2, 'audit requests >= 2');
    assert.equal(audit.requests.length, 2, `账本应恰 2 行，实际=${audit.requests.length}`);
    for (const row of audit.requests) {
      assert.equal(row.subscription, 'be-a', `账本行 subscription 应 be-a，实际=${row.subscription}`);
      assert.equal(row.identity, 'e2e-s1', `账本行 identity 应 e2e-s1，实际=${row.identity}`);
    }
    assertAuditRows(audit.requests, 's1');

    // ⑥ system_events：route.bind 且 backend_name=be-a
    const binds = parseEvents(await pollAdmin(ports.admin, '/api/events?kind=route.bind',
      (data) => (data?.events?.length ?? 0) >= 1, 'route.bind >= 1'));
    assert.equal(binds.length, 1, `route.bind 应恰 1 条，实际=${binds.length}`);
    assert.equal(binds[0]!.backend_name, 'be-a', `route.bind backend_name 应 be-a，实际=${binds[0]!.backend_name}`);
  } finally {
    await assertInstanceStopped(inst).catch((error) => { console.error(`[s1] 实例停止异常：${error}`); });
    await fakeA.stop().catch((error) => { console.error(`[s1] 假上游停止异常：${error}`); });
  }
}

// —— 场景 2：亲和粘住（同实例同 sessionId 两轮） ————————————————————

async function scenario2(runDir: string): Promise<void> {
  const ports = await pickPorts();
  const recordA = path.join(runDir, 'upstream-a.jsonl');
  const recordB = path.join(runDir, 'upstream-b.jsonl');
  const fakeA = await startFakeUpstream({ label: 's2-be-a', port: ports.upstreamA, scenario: 'ok', recordPath: recordA });
  const fakeB = await startFakeUpstream({ label: 's2-be-b', port: ports.upstreamB, scenario: 'ok', recordPath: recordB });
  const inst = await startCprInstance({
    repoDir: packDir, ports,
    configDir: path.join(runDir, 'cpr-config'), dataDir: path.join(runDir, 'cpr-data'),
  });
  liveProcesses.push({ label: 's2-cpr', pid: inst.pid });
  try {
    const piCwd = path.join(runDir, piCwdName);
    const piHome = path.join(runDir, piHomeName);
    const round = (prompt: string): RoundOptions => ({
      inferPort: ports.infer, sessionId: 'e2e-s2', prompt, cwd: piCwd, homeDir: piHome,
    });
    const r1 = await piRound(round('say hi'));
    assert.equal(r1.exitCode, 0, `第一轮 pi 应 exit 0（stderr=${r1.stderr.slice(0, 400)}）`);
    assert.ok(r1.finalText.length > 0, `第一轮 finalText 应非空，实际=${JSON.stringify(r1.finalText)}`);

    const r2 = await piRound(round('answer in plain text only'));
    assert.equal(r2.exitCode, 0, `第二轮 pi 应 exit 0（stderr=${r2.stderr.slice(0, 400)}）`);
    assert.ok(r2.finalText.length > 0, `第二轮 finalText 应非空，实际=${JSON.stringify(r2.finalText)}`);

    // 两轮聊天请求都打 be-a（be-b 假上游在跑但应零聊天请求）
    const chatsA = chatPosts(readRecord(recordA));
    assert.equal(chatsA.length, 2, `be-a 应收到恰 2 条聊天请求（两轮各一），实际=${chatsA.length}`);
    assertChatBearer(chatsA, 's2');
    for (const chat of chatsA) {
      // llm-cpr 透传亲和头时归一为 x-opencode-session（实测），两种键名都认。
      const identity = chat.headers['x-opencode-session'] ?? chat.headers['x-session-id'];
      assert.equal(identity, 'e2e-s2',
        `亲和头应透传为 e2e-s2，实际=${identity}`);
    }
    const chatsB = chatPosts(readRecord(recordB));
    assert.equal(chatsB.length, 0, `be-b 不应收到聊天请求，实际=${chatsB.length}`);

    // 账本：两行都 be-a、status 200、usage 非空
    const audit = await pollAdmin(ports.admin, '/api/audit/requests',
      (data) => (data?.requests?.length ?? 0) >= 2, 'audit requests >= 2');
    assert.equal(audit.requests.length, 2, `账本应恰 2 行，实际=${audit.requests.length}`);
    for (const row of audit.requests) {
      assert.equal(row.subscription, 'be-a', `账本行 subscription 应 be-a，实际=${row.subscription}`);
      assert.equal(row.identity, 'e2e-s2', `账本行 identity 应 e2e-s2，实际=${row.identity}`);
    }
    assertAuditRows(audit.requests, 's2');

    // route.bind 恰 1 条（第二轮靠亲和，不新增）且无 rebind
    const binds = parseEvents(await pollAdmin(ports.admin, '/api/events?kind=route.bind',
      (data) => (data?.events?.length ?? 0) >= 1, 'route.bind >= 1'));
    assert.equal(binds.length, 1, `route.bind 应恰 1 条，实际=${binds.length}`);
    assert.equal(binds[0]!.backend_name, 'be-a', `route.bind backend_name 应 be-a，实际=${binds[0]!.backend_name}`);
    const rebinds = parseEvents(await adminJson(ports.admin, '/api/events?kind=route.rebind'));
    assert.equal(rebinds.length, 0, `不应有 route.rebind，实际=${rebinds.length}`);
  } finally {
    await assertInstanceStopped(inst).catch((error) => { console.error(`[s2] 实例停止异常：${error}`); });
    await fakeA.stop().catch((error) => { console.error(`[s2] 假上游 A 停止异常：${error}`); });
    await fakeB.stop().catch((error) => { console.error(`[s2] 假上游 B 停止异常：${error}`); });
  }
}

// —— 场景 5：策略热更新三连（独立实例独立端口） ——————————————————————

async function runCprReloadCli(opts: { adminPort: number; runDir: string }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  systemctlCalls: string[];
}> {
  // systemctl stub：真 systemctl 的替身（记 argv 进日志，零副作用）——CLI 若越轨调用即被抓现行。
  const logPath = path.join(opts.runDir, 'systemctl-calls.log');
  const stubPath = path.join(opts.runDir, 'systemctl-stub.sh');
  fs.writeFileSync(stubPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`);
  fs.chmodSync(stubPath, 0o755);
  const before = await prodState();
  assert.ok(before.pid !== null || process.env.CPR_E2E_SKIP_PID_GUARD === '1',
    `CLI 跑前读生产状态失败：${before.raw}`);
  const child = spawn(process.execPath, [path.join(packDir, 'scripts', 'cpr.ts'), 'reload'], {
    env: {
      ...process.env,
      CPR_ADMIN_PORT: String(opts.adminPort),
      CPR_UNIT_NAME: 'e2e-cpr-test.service', // 安全垫：万一走 systemctl 也只指向不存在的 unit
      CPR_SYSTEMCTL: stubPath,              // 双保险：任何 systemctl 调用都被 stub 截获记账
      CPR_CONFIG_DIR: path.join(opts.runDir, 'cli-config'),
      CPR_DATA_DIR: path.join(opts.runDir, 'cli-data'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin!.write('N\n'); // 拒绝代跑重启（非 TTY 下 CLI 本就自动答 N，这里再喂一遍）
  child.stdin!.end();
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(null); }, 30_000);
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  await prodUnchanged(before);
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    : [];
  return { code, stdout: stdoutBuf, stderr: stderrBuf, systemctlCalls: calls };
}

async function scenario5(runDir: string): Promise<void> {
  const ports = await pickPorts();
  const recordA = path.join(runDir, 'upstream-a.jsonl');
  const recordB = path.join(runDir, 'upstream-b.jsonl');
  const fakeA = await startFakeUpstream({ label: 's5-be-a', port: ports.upstreamA, scenario: 'ok', recordPath: recordA });
  const fakeB = await startFakeUpstream({ label: 's5-be-b', port: ports.upstreamB, scenario: 'ok', recordPath: recordB });
  const inst = await startCprInstance({
    repoDir: packDir, ports,
    configDir: path.join(runDir, 'cpr-config'), dataDir: path.join(runDir, 'cpr-data'),
  });
  liveProcesses.push({ label: 's5-cpr', pid: inst.pid });
  try {
    const policyPath = inst.policyPath;
    const piCwd = path.join(runDir, piCwdName);
    const piHome = path.join(runDir, piHomeName);
    const round = (prompt: string): RoundOptions => ({
      inferPort: ports.infer, sessionId: 'e2e-s5', prompt, cwd: piCwd, homeDir: piHome,
    });
    const countChats = (recordPath: string): number => chatPosts(readRecord(recordPath)).length;
    const newestRow = async (): Promise<any> => {
      const audit = await pollAdmin(ports.admin, '/api/audit/requests',
        (data) => (data?.requests?.length ?? 0) >= 1, 'audit rows', 6_000);
      assertAuditRows([audit.requests[0]!], 's5 newest row');
      return audit.requests[0];
    };

    // (a) 首轮：内置路由 → be-a
    const pa = await piRound(round('say hi'));
    assert.equal(pa.exitCode, 0, `(a) pi 应 exit 0（stderr=${pa.stderr.slice(0, 400)}）`);
    assert.equal(pa.finalText.trim(), 'e2e ok', `(a) finalText 应为 e2e ok，实际=${JSON.stringify(pa.finalText)}`);
    assert.equal(countChats(recordA), 1, '(a) be-a 应收到恰 1 条聊天请求');
    assert.equal(countChats(recordB), 0, '(a) be-b 不应收到聊天请求');
    assert.equal((await newestRow()).subscription, 'be-a', '(a) 账本最新行 subscription 应 be-a');

    // (b) 热区变更：decide 钉死 be-b → 下轮请求打 be-b 且 policy.reload 落账
    const originalPolicy = fs.readFileSync(policyPath, 'utf8');
    assert.ok(originalPolicy.includes('decide() { return null; }'), '生成的 policy.ts 应含恒 null 的 decide');
    const pinnedPolicy = originalPolicy.replace(
      'decide() { return null; }',
      "decide() { return { backend: 'be-b', reason: 'e2e-pin-be-b' }; }",
    );
    assert.notEqual(pinnedPolicy, originalPolicy, '(b) 热区编辑应实际改动文件');
    fs.writeFileSync(policyPath, pinnedPolicy);
    const pb = await piRound(round('say hi again'));
    assert.equal(pb.exitCode, 0, `(b) pi 应 exit 0（stderr=${pb.stderr.slice(0, 400)}）`);
    assert.equal(pb.finalText.trim(), 'e2e ok', `(b) finalText 应为 e2e ok，实际=${JSON.stringify(pb.finalText)}`);
    assert.equal(countChats(recordA), 1, '(b) be-a 不应再收到聊天请求');
    assert.equal(countChats(recordB), 1, '(b) be-b 应收到恰 1 条聊天请求');
    assert.equal((await newestRow()).subscription, 'be-b', '(b) 账本最新行 subscription 应 be-b');
    const reloadOk = parseEvents(await pollAdmin(ports.admin, '/api/events?kind=policy.reload',
      (data) => (data?.events?.length ?? 0) >= 1, 'policy.reload >= 1'));
    assert.equal(reloadOk.length, 1, '(b) policy.reload 事件应恰 1 条');
    assert.equal(reloadOk[0]!.detail?.trigger, 'file-change', '(b) policy.reload trigger 应为 file-change');
    assert.ok(typeof reloadOk[0]!.detail?.to_hash === 'string' && reloadOk[0]!.detail.to_hash.length > 0,
      '(b) policy.reload 应带 to_hash');

    // (c) 语法坏文件：保旧、请求仍成功、policy.reload.error 存在且不含文件全文
    const sentinel = `E2E-SENTINEL-${crypto.randomUUID()}`;
    const brokenPolicy = `// e2e (c) 故意写坏的 policy（语法错误）。哨兵行在最末尾——断言 reload 错误摘要不含全文/哨兵。
export default class E2eBrokenPolicy {
  backends = [
    { name: 'be-a', family: 'ocg' as const, base_url: 'http://127.0.0.1:${ports.upstreamA}/v1', key_env: '${E2E_MASTER_KEY_ENV}', priority: 1 },
    { name: 'be-b', family: 'ccg' as const, base_url: 'http://127.0.0.1:${ports.upstreamB}/v1', key_env: '${E2E_MASTER_KEY_ENV}', priority: 2 },
  ];
  models = [
    { id: '${E2E_MODEL_ID}', backends: { ocg: '${E2E_MODEL_ID}', ccg: '${E2E_MODEL_ID}' } },
  ];
  decide() { return { backend: 'be-b', reason: 'e2e-pin-be-b' }; }
  brokenSyntax =
}
/* ${sentinel} */
`;
    fs.writeFileSync(policyPath, brokenPolicy);
    const pc = await piRound(round('say hi once more'));
    assert.equal(pc.exitCode, 0, `(c) pi 应 exit 0（坏文件保旧，请求不应失败；stderr=${pc.stderr.slice(0, 400)}）`);
    assert.equal(pc.finalText.trim(), 'e2e ok', `(c) finalText 应为 e2e ok，实际=${JSON.stringify(pc.finalText)}`);
    assert.equal(countChats(recordA), 1, '(c) be-a 不应收到新聊天请求');
    assert.equal(countChats(recordB), 2, '(c) be-b 应收到第 2 条聊天请求（保旧策略仍指 be-b）');
    assert.equal((await newestRow()).subscription, 'be-b', '(c) 账本最新行 subscription 应仍 be-b');
    const reloadErrors = parseEvents(await pollAdmin(ports.admin, '/api/events?kind=policy.reload.error',
      (data) => (data?.events?.length ?? 0) >= 1, 'policy.reload.error >= 1'));
    const loadFailed = reloadErrors.find((event) => event.detail?.reason === 'load-failed'
      && event.detail?.trigger === 'file-change');
    assert.ok(loadFailed, `(c) 应有 trigger=file-change reason=load-failed 的 policy.reload.error 事件；实际=${JSON.stringify(reloadErrors.map((event) => event.detail)).slice(0, 400)}`);
    const errorText = String(loadFailed!.detail?.error ?? '');
    assert.ok(errorText.length > 0 && errorText.length <= 400,
      `(c) 错误摘要应为 ≤400 字符的摘要，实际长度=${errorText.length}`);
    assert.ok(!errorText.includes(sentinel), '(c) 错误摘要不应含文件哨兵（=不含文件全文）');
    assert.ok(!errorText.includes('brokenSyntax ='), '(c) 错误摘要不应含文件正文片段');

    // (d) 冷区变更（backends 新增 be-c）→ cpr reload CLI 喂 N 拒重启 → 随后仍走 be-b
    const coldPolicy = pinnedPolicy.replace(
      '  backends = [',
      `  backends = [\n    { name: 'be-c', family: 'ocg' as const, base_url: 'http://127.0.0.1:9/v1', key_env: '${E2E_MASTER_KEY_ENV}', priority: 3 },`,
    );
    assert.notEqual(coldPolicy, pinnedPolicy, '(d) 冷区编辑应实际改动文件');
    assert.ok(coldPolicy.includes("name: 'be-c'"), '(d) 冷区编辑应引入 be-c');
    fs.writeFileSync(policyPath, coldPolicy);
    const cli = await runCprReloadCli({ adminPort: ports.admin, runDir });
    const combined = `${cli.stdout}\n${cli.stderr}`;
    assert.equal(cli.systemctlCalls.length, 0,
      `(d) systemctl 零调用断言失败，stub 记录到：${cli.systemctlCalls.join(' | ')}`);
    assert.ok(combined.includes('冷区字段') && combined.includes('重启才生效'),
      `(d) CLI 输出应报冷区变更需重启，实际输出=${JSON.stringify(combined.slice(0, 800))}`);
    assert.ok(combined.includes('backends'), `(d) CLI 应列出变更字段 backends，实际=${JSON.stringify(combined.slice(0, 400))}`);
    assert.ok(combined.includes('未重启'), `(d) CLI 应报未重启，实际=${JSON.stringify(combined.slice(0, 400))}`);
    assert.ok(combined.includes('e2e-cpr-test.service'), `(d) 手工口径应指向安全垫 unit 名，实际=${JSON.stringify(combined.slice(0, 400))}`);
    assert.ok(combined.includes('N'), `(d) 重启确认应答 N（非交互自动拒绝），实际=${JSON.stringify(combined.slice(0, 400))}`);
    const coldErrors = parseEvents(await adminJson(ports.admin, '/api/events?kind=policy.reload.error'));
    assert.ok(coldErrors.some((event) => event.detail?.reason === 'cold-zone-change'),
      '(d) 冷区拒绝应落 policy.reload.error（reason=cold-zone-change）');

    const pd = await piRound(round('say hi final'));
    assert.equal(pd.exitCode, 0, `(d) pi 应 exit 0（stderr=${pd.stderr.slice(0, 400)}）`);
    assert.equal(pd.finalText.trim(), 'e2e ok', `(d) finalText 应为 e2e ok，实际=${JSON.stringify(pd.finalText)}`);
    assert.equal(countChats(recordA), 1, '(d) be-a 不应收到新聊天请求');
    assert.equal(countChats(recordB), 3, '(d) be-b 应收到第 3 条聊天请求');
    assert.equal((await newestRow()).subscription, 'be-b', '(d) 账本最新行 subscription 应仍 be-b');
  } finally {
    await assertInstanceStopped(inst).catch((error) => { console.error(`[s5] 实例停止异常：${error}`); });
    await fakeA.stop().catch((error) => { console.error(`[s5] 假上游 A 停止异常：${error}`); });
    await fakeB.stop().catch((error) => { console.error(`[s5] 假上游 B 停止异常：${error}`); });
  }
}

// —— 场景调度与收尾 ——————————————————————————————————————————————————

interface RunArgs { scenarios: number[]; repoDir?: string; worktree?: string }

function parseArgs(argv: string[]): RunArgs {
  const out: RunArgs = { scenarios: [1, 2, 5] };
  let raw: string | undefined;
  const nextValue = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要跟一个路径参数`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--scenario=')) raw = arg.slice('--scenario='.length);
    else if (arg === '--scenario') { raw = nextValue(i, '--scenario'); i += 1; }
    else if (arg.startsWith('--repo-dir=')) out.repoDir = arg.slice('--repo-dir='.length);
    else if (arg === '--repo-dir') { out.repoDir = nextValue(i, '--repo-dir'); i += 1; }
    else if (arg.startsWith('--worktree=')) out.worktree = arg.slice('--worktree='.length);
    else if (arg === '--worktree') { out.worktree = nextValue(i, '--worktree'); i += 1; }
    else throw new Error(`未知参数 ${arg}（支持 --scenario=1|2|5、--repo-dir=<路径>、--worktree=<路径>，缺省全跑仓根）`);
  }
  if (raw !== undefined && raw !== '' && raw !== 'all') {
    const ids = raw.split(',').map((part) => Number(part.trim()));
    for (const id of ids) {
      if (![1, 2, 5].includes(id)) throw new Error(`--scenario 只接受 1|2|5，得到 ${String(id)}`);
    }
    out.scenarios = ids;
  }
  return out;
}

async function assertPortClosed(port: number): Promise<void> {
  const open = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 800);
  });
  assert.ok(!open, `端口 ${port} 仍在监听（残留进程）`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const filter = args.scenarios;
  packDir = path.resolve(args.worktree ?? args.repoDir ?? defaultRepoDir);
  assert.ok(fs.existsSync(path.join(packDir, 'package.json')), `pack 源目录缺 package.json：${packDir}`);
  const packSource = args.worktree !== undefined ? '--worktree 覆盖'
    : args.repoDir !== undefined ? '--repo-dir 指定' : '缺省=仓根自身';
  assertPathSafe(runsRoot, 'runsRoot');
  fs.mkdirSync(runsRoot, { recursive: true });

  const prodBefore = await prodState();
  assert.ok(prodBefore.pid !== null || process.env.CPR_E2E_SKIP_PID_GUARD === '1',
    `读生产 ${PROD_UNIT} 状态失败：${prodBefore.raw}`);
  console.log(`[run-scenarios] 生产 ${PROD_UNIT} ${prodBefore.pid === null ? 'PID 护栏豁免（CI）' : `MainPID=${prodBefore.pid}（只读比对基准）`}`);
  console.log(`[run-scenarios] 场景=${filter.join('/')} pack 源=${packDir}（${packSource}）现场根=${runsRoot}`);

  const runners: Record<number, (runDir: string) => Promise<void>> = { 1: scenario1, 2: scenario2, 5: scenario5 };
  const outcomes: { id: number; pass: boolean; keptDir?: string }[] = [];

  for (const id of filter) {
    const runDir = path.join(runsRoot, `scenario-${id}`);
    console.log(`\n===== 场景 ${id}（现场 ${runDir}）=====`);
    let pass = false;
    let failure = '';
    try {
      await runners[id]!(runDir);
      pass = true;
    } catch (error) {
      failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    }
    if (pass) {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (error) {
        console.error(`[run-scenarios] 成功场景现场清理失败（保留 ${runDir}）：${error}`);
      }
      console.log(`场景 ${id}: PASS（成功即清理，临时目录已删）`);
    } else {
      assertPathSafe(runDir, '失败现场');
      console.log(`场景 ${id}: FAIL（现场保留：${runDir}）\n${failure}`);
    }
    outcomes.push({ id, pass, keptDir: pass ? undefined : runDir });
  }

  // 收尾：无残留进程 / 监听口
  const leftovers: string[] = [];
  for (const entry of liveProcesses) {
    if (!(await waitPidGone(entry.pid, 2_000))) leftovers.push(`${entry.label} pid=${entry.pid}`);
  }
  for (const port of usedPorts) {
    try { await assertPortClosed(port); } catch (error) { leftovers.push(String((error as Error).message)); }
  }
  await prodUnchanged(prodBefore);

  console.log('\n===== 结果汇总 =====');
  for (const outcome of outcomes) {
    console.log(`场景 ${outcome.id}: ${outcome.pass ? 'PASS' : `FAIL${outcome.keptDir ? `（现场：${outcome.keptDir}）` : ''}`}`);
  }
  if (leftovers.length > 0) {
    console.error(`收尾检查失败（残留进程/监听口）：${leftovers.join('；')}`);
    return 1;
  }
  console.log('[run-scenarios] 无残留进程/监听口；生产 PID 比对全程一致 ✔');
  return outcomes.every((outcome) => outcome.pass) ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error('[run-scenarios] 运行器崩溃：', error);
  process.exitCode = 1;
});
