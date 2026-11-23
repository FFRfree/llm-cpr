// run-install-e2e.ts — 场景 8：安装层 e2e（slow lane）。容器内跑，root，systemd 当 PID 1。
//
// 挂载契约（宿主编排 run-slow-lane.sh）：
//   /mnt/e2e  ro  整个 e2e 目录（复用 fast lane 的 fake-upstream.ts；本脚本与 fake-registry.ts 在 slow-lane/ 下）
//   /mnt/pkg  ro  主仓 npm pack 产物目录（ffrfree-llm-cpr-<version>.tgz）
//   /mnt/run  rw  本次运行产物（report.json / driver-log.txt / fake-upstream-record.jsonl）
//
// 流程：等 systemd 就绪 → 起 root 用户管理器（systemctl --user 通道与宿主生产一致）→
//   起本地假 npm registry → 解包 tgz 当 bootstrap 副本 → `cpr install --yes`（npm 走假 registry，零外网）→
//   安装产物断言（current 软链 / cpr 软链 / unit 文件 / systemctl --user is-active / 管理口 200）→
//   改 policy.ts 指向假上游 → systemctl --user restart → 健康验证 → 起假上游 →
//   一轮真转发冒烟（curl 语义 POST 推理口）→ 账本断言（假上游 record 行 + 管理口审计行）→ 收尾报告。
//
// 退出纪律：成功 → systemctl --no-wall poweroff（容器 exit 0）；失败 → report(ok=false) 后 kill -9 1（exit 137）。
// 容器 --rm 用完即弃，全部临时文件（/tmp/cpr-bootstrap、~/.llm-cpr、~/.local/lib/llm-cpr）随容器销毁。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const RUN = '/mnt/run';
const PKG_DIR = '/mnt/pkg';
const E2E = '/mnt/e2e';
const PORTS = { infer: 8741, admin: 8740, upstream: 8750, registry: 8752 };
const UNIT = 'llm-cpr.service';

interface Step { step: string; ok: boolean; detail: string }
const steps: Step[] = [];
const startedAt = new Date().toISOString();
const logPath = path.join(RUN, 'driver-log.txt');

function log(line: string): void {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  try { fs.appendFileSync(logPath, text + '\n'); } catch { /* 首次建目录前可能失败，忽略 */ }
}

function record(step: string, ok: boolean, detail: string): boolean {
  steps.push({ step, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${step} — ${detail}`);
  return ok;
}

function sh(command: string, opts: { env?: NodeJS.ProcessEnv } = {}): { code: number; out: string; err: string } {
  const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: opts.env ?? process.env, timeout: 120_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function fetchUntil(url: string, init: RequestInit | undefined, want: (res: Response) => boolean, tries: number, gapMs: number): Promise<Response | null> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, init);
      if (want(res)) return res;
    } catch { /* 未就绪/连接拒绝：轮询 */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

const USERCTL_ENV = { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' } as NodeJS.ProcessEnv;
const userctl = (args: string) => sh(`systemctl --user ${args}`, { env: USERCTL_ENV });

// e2e policy：镜像安装层产出的 policy.ts 会被本脚本按真实用户流程改写（配置即代码）。
// 字段形状对照 core/policy/contract.ts（与 fast lane 的 cpr-instance.ts 同源核实）。
const E2E_POLICY = `export default class MyPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  listen = { host: '127.0.0.1', port: ${PORTS.infer} };
  admin = { host: '127.0.0.1', port: ${PORTS.admin} };
  routing = { snapshot_interval_ms: 30000, long_session_min_requests: 10 };
  backends = [
    { name: 'fake-ocg', family: 'ocg', base_url: 'http://127.0.0.1:${PORTS.upstream}/v1', key_env: 'CPR_MASTER_KEY', priority: 1 },
    { name: 'fake-ccg', family: 'ccg', base_url: 'http://127.0.0.1:${PORTS.upstream}/provider', key_env: 'CPR_MASTER_KEY', priority: 2 },
  ];
  models = [
    { id: 'test-model', backends: { ocg: 'test-model', ccg: 'test-model' } },
  ];
  // decide 恒返 null = 交给内置路由（与 fast lane cpr-instance.ts 的语义一致）。
  decide(): null { return null; }
}
`;

const children: ReturnType<typeof spawn>[] = [];
function killChildren(): void {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* 已退出 */ } }
  const end = Date.now() + 3000;
  while (Date.now() < end && children.some((c) => c.exitCode === null && !c.killed)) {
    spawnSync('sleep', ['0.2']);
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  }
}

function finish(report: Record<string, unknown>, ok: boolean): never {
  killChildren();
  const payload = { ...report, ok, steps, startedAt, finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify(payload, null, 2) + '\n');
  log(ok ? 'ALL GREEN — powering off (container exit 0)' : 'RED — report.json ok=false 后 poweroff（宿主以 report 判红）');
  sh('systemctl --no-wall poweroff');
  process.exit(ok ? 0 : 1); // 容器退出码由 PID1 systemd 决定（poweroff → 0）；成败裁决以 report.json 为准
}

async function main(): Promise<void> {
  log(`boot: node ${process.versions.node}, hostname ${process.env.HOSTNAME ?? '?'}, mounts e2e=${fs.existsSync(E2E)} pkg=${fs.existsSync(PKG_DIR)} run=${fs.existsSync(RUN)}`);

  // ---- 选 tgz / 版本 ----
  const tgzFiles = fs.readdirSync(PKG_DIR).filter((f) => /^ffrfree-llm-cpr-\d+\.\d+\.\d+\.tgz$/.test(f)).sort();
  if (!record('artifact', tgzFiles.length === 1, `mounted tgz: ${JSON.stringify(tgzFiles)}`)) return finish({ reason: 'artifact' }, false);
  const tgz = tgzFiles[0];
  const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(tgz)?.[1];
  if (!record('version-parse', Boolean(version), `parsed version=${version}`)) return finish({ version }, false);

  // ---- 1. systemd 就绪 ----
  // 注意：驱动自身是 boot 的一部分（multi-user.target.wants），is-system-running 会一直停在
  // "starting"——真实 boot 在 ~400ms 就到 multi-user.target（实测 systemd-analyze）。
  // 就绪口径 = multi-user.target active + user@0 可用。
  let sysdState = '';
  for (let i = 0; i < 30; i += 1) {
    sysdState = sh('systemctl is-active multi-user.target').out;
    if (sysdState === 'active') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!record('systemd-up', sysdState === 'active', `multi-user.target=${sysdState}`)) return finish({}, false);

  // ---- 2. root 用户管理器（真 systemctl --user 通道） ----
  sh('mkdir -p /run/user/0 && chmod 700 /run/user/0');
  let umOk = false;
  for (let i = 0; i < 10 && !umOk; i += 1) {
    sh('systemctl start user@0.service');
    umOk = userctl('is-system-running').out === 'running' || userctl('is-system-running').out === 'degraded'
      || sh('systemctl is-active user@0.service').out === 'active';
    if (!umOk) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!record('user-manager', umOk, 'user@0.service active, systemctl --user reachable')) return finish({}, false);

  // ---- 3. 假 npm registry（不碰外网） ----
  const registry = spawn('node', [path.join(E2E, 'slow-lane', 'fake-registry.ts'),
    '--port', String(PORTS.registry), '--tgz', path.join(PKG_DIR, tgz), '--name', '@ffrfree/llm-cpr'],
  { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(registry);
  const regReady = await fetchUntil(`http://127.0.0.1:${PORTS.registry}/@ffrfree/llm-cpr/latest`, undefined, (r) => r.ok, 40, 250);
  if (!record('fake-registry', Boolean(regReady), `127.0.0.1:${PORTS.registry} serving ${tgz}`)) return finish({}, false);

  // ---- 4. bootstrap 副本：解包 tgz ----
  const ex = sh('rm -rf /tmp/cpr-bootstrap && mkdir -p /tmp/cpr-bootstrap && tar -xzf /mnt/pkg/' + tgz + ' -C /tmp/cpr-bootstrap');
  const bootPkg = '/tmp/cpr-bootstrap/package';
  const bootOk = ex.code === 0 && fs.existsSync(path.join(bootPkg, 'package.json'))
    && fs.existsSync(path.join(bootPkg, 'scripts', 'cpr.ts'))
    && fs.existsSync(path.join(bootPkg, 'core', 'main.ts'));
  const bootVersion = bootOk ? (JSON.parse(fs.readFileSync(path.join(bootPkg, 'package.json'), 'utf8')) as { version: string }).version : null;
  if (!record('bootstrap-extract', bootOk && bootVersion === version, `extracted to ${bootPkg}, version=${bootVersion}`)) return finish({ install: { stderr: ex.err } }, false);

  // ---- 5. cpr install（npm → 假 registry；systemctl --user → 容器内用户管理器） ----
  const install = spawnSync('node', [path.join(bootPkg, 'scripts', 'cpr.ts'), 'install', '--yes'], {
    cwd: '/tmp', encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/0',
      npm_config_registry: `http://127.0.0.1:${PORTS.registry}/`,
      npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } as NodeJS.ProcessEnv,
  });
  const installOut = (install.stdout ?? '') + (install.stderr ?? '');
  fs.writeFileSync(path.join(RUN, 'cpr-install-output.txt'), installOut);
  const installOk = install.status === 0
    && installOut.includes(`current → ${version}`)
    && installOut.includes('已启动');
  if (!record('cpr-install', installOk, `exit=${install.status}; tail: ${installOut.slice(-400).replace(/\n+/g, ' | ')}`)) return finish({ version }, false);

  // ---- 6. 安装产物断言 ----
  const current = (() => { try { return fs.readlinkSync('/root/.local/lib/llm-cpr/current'); } catch { return null; } })();
  const currentOk = Boolean(current && current.endsWith(`versions/${version}`));
  const binLink = (() => { try { return fs.readlinkSync('/root/.local/bin/cpr'); } catch { return null; } })();
  const unitExists = fs.existsSync(`/root/.config/systemd/user/${UNIT}`);
  const active = userctl(`is-active ${UNIT}`).out === 'active';
  const layoutOk = currentOk && Boolean(binLink) && unitExists && active;
  if (!record('install-layout', layoutOk, `current→${current} bin=${binLink ? 'ok' : 'missing'} unit=${unitExists} active=${active}`)) return finish({ current }, false);

  const statusRes = await fetchUntil(`http://127.0.0.1:${PORTS.admin}/api/route/status`, undefined, (r) => r.ok, 30, 500);
  if (!record('admin-after-install', Boolean(statusRes), `GET /api/route/status 200 (template policy, template backends degraded tolerated)`)) return finish({}, false);

  // ---- 7. 改 policy.ts（真实用户流程）→ restart → 健康 ----
  fs.writeFileSync('/root/.llm-cpr/policy.ts', E2E_POLICY);
  const restart = userctl(`restart ${UNIT}`);
  const restarted = restart.code === 0;
  const healthy = restarted && Boolean(await fetchUntil(`http://127.0.0.1:${PORTS.admin}/api/route/status`, undefined, (r) => r.ok, 40, 500));
  if (!record('policy-restart', healthy, `rewrote policy.ts (fake-ocg/fake-ccg → 127.0.0.1:${PORTS.upstream}), systemctl --user restart rc=${restart.code}`)) return finish({}, false);

  // ---- 8. master key（容器内 install 随机生成；报告只留掩码） ----
  const envText = fs.readFileSync('/root/.llm-cpr/.env', 'utf8');
  const masterKey = /^CPR_MASTER_KEY=(.+)$/m.exec(envText)?.[1] ?? '';
  if (!record('master-key', masterKey.length >= 32, `present, len=${masterKey.length} (masked ${masterKey.slice(0, 4)}***)`)) return finish({}, false);

  // ---- 9. 假上游（复用 fast lane 组件） ----
  const upstream = spawn('node', [path.join(E2E, 'fake-upstream.ts'),
    '--port', String(PORTS.upstream), '--scenario', 'ok', '--record', path.join(RUN, 'fake-upstream-record.jsonl')],
  { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(upstream);
  const upReady = await fetchUntil(`http://127.0.0.1:${PORTS.upstream}/usage`, undefined, (r) => r.ok, 40, 250);
  if (!record('fake-upstream', Boolean(upReady), `127.0.0.1:${PORTS.upstream} scenario=ok`)) return finish({}, false);

  // ---- 10. 健康验证：管理口 status/version ----
  const versionRes = await fetch(`http://127.0.0.1:${PORTS.admin}/api/version`);
  const versionBody = await versionRes.json() as { version?: string; latest?: string | null };
  if (!record('admin-version', versionRes.ok && versionBody.version === version, `GET /api/version → ${JSON.stringify(versionBody)} (latest 离线降级 null 属预期)`)) return finish({}, false);

  // ---- 11. 一轮真转发冒烟 ----
  const smokeRes = await fetch(`http://127.0.0.1:${PORTS.infer}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${masterKey}`, 'x-session-id': 'slow-lane-e2e' },
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'slow-lane e2e' }] }),
  });
  const smokeText = await smokeRes.text();
  fs.writeFileSync(path.join(RUN, 'smoke-response.txt'), smokeText);
  const smokeOk = smokeRes.status === 200 && smokeText.includes('e2e ok') && smokeText.includes('data: [DONE]');
  if (!record('forward-smoke', smokeOk, `POST /v1/chat/completions → ${smokeRes.status}; SSE tail: ${smokeText.slice(-160).replace(/\n+/g, ' | ')}`)) return finish({}, false);

  // ---- 12. 账本断言 ----
  const recordLines = fs.readFileSync(path.join(RUN, 'fake-upstream-record.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const chatLines = recordLines.filter((l) => l.method === 'POST' && String(l.url).includes('/chat/completions'));
  const chatBody = chatLines[0]?.body as { model?: string } | undefined;
  const upstreamLedgerOk = chatLines.length >= 1 && chatBody?.model === 'test-model';
  if (!record('upstream-ledger', upstreamLedgerOk, `fake-upstream record ${recordLines.length} 行，chat POST ${chatLines.length} 行，model=${chatBody?.model}`)) return finish({}, false);

  const auditRes = await fetch(`http://127.0.0.1:${PORTS.admin}/api/audit/requests?limit=20`);
  const audit = await auditRes.json() as unknown;
  const auditText = JSON.stringify(audit);
  const auditOk = auditRes.ok && auditText.includes('test-model') && auditText.includes('fake-ocg');
  fs.writeFileSync(path.join(RUN, 'audit-requests.json'), JSON.stringify(audit, null, 2));
  if (!record('audit-ledger', auditOk, `GET /api/audit/requests → ${auditRes.ok}, 含 test-model/fake-ocg`)) return finish({}, false);

  // ---- 13. 收尾：停服务、停子进程（容器随后销毁） ----
  const stop = userctl(`stop ${UNIT}`);
  record('teardown', stop.code === 0, `systemctl --user stop ${UNIT} rc=${stop.code}`);

  finish({
    version,
    node: process.versions.node,
    evidence: {
      installLog: 'cpr-install-output.txt', smoke: 'smoke-response.txt', audit: 'audit-requests.json',
      upstreamRecord: 'fake-upstream-record.jsonl',
    },
  }, true);
}

main().catch((err: unknown) => {
  log(`CRASH: ${(err as Error)?.stack ?? String(err)}`);
  finish({ crash: String((err as Error)?.stack ?? err) }, false);
});
