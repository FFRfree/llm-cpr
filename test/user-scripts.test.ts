// scripts/cpr.ts（doctor/install/upgrade/uninstall，v0.2.0 npm 形态）+ main.ts policy 加载的用户侧验收。
// 全部经临时 fixture（最小包根拷贝）+ 注入式 systemctl/loginctl/npm stub 运行，绝不触碰本机生产服务与真实 unit。
// 隔离口径见 .scratch/user-scripts/issues/06-test-harness.md；真 systemd 一次性 e2e 按惯例现场构造、不进常驻套件。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UNIT = 'llm-cpr.service';

type Env = Record<string, string>;

interface Fixture { base: string; work: string; env: Env }

// v0.2.0 npm 形态 fixture：最小包根拷贝（scripts/ + package.json + core stub），无 git。
// npm stub 的 install 会把版本写进状态文件；systemctl stub 的 is-active 按状态文件判活——
// 靠这对联动可以端到端复现「新版起不来 → 自动装回旧版 → 服务恢复」的回滚主线。
function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-user-scripts-'));
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.cpSync(path.join(REPO, 'scripts'), path.join(work, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'package.json'), path.join(work, 'package.json'));
  fs.cpSync(path.join(REPO, '.env.example'), path.join(work, '.env.example'));
  fs.mkdirSync(path.join(work, 'core', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(work, 'core', 'main.ts'), '// fixture stub\n');
  fs.writeFileSync(path.join(work, 'policy.example.ts'), '// fixture 模板\n');
  // fixture 版本号：真实包是 0.0.0（发布前），fixture 统一起始 0.1.0 让升级用例有明确的「当前值」
  const pkgPath = path.join(work, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  pkg.version = '0.1.0';
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const versionState = path.join(base, 'version-state');
  fs.writeFileSync(versionState, '0.1.0\n');
  const systemctlStub = path.join(base, 'systemctl-stub.sh');
  fs.writeFileSync(systemctlStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$CPR_SYSTEMCTL_LOG"',
    'case " $* " in',
    '  *" is-active "*)',
    '    v=$(cat "$CPR_VERSION_STATE" 2>/dev/null || echo none)',
    '    [ "$v" = "$CPR_BAD_VERSION" ] && exit 3',
    '    exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(systemctlStub, 0o755);
  const npmStub = path.join(base, 'npm-stub.sh');
  fs.writeFileSync(npmStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$CPR_NPM_LOG"',
    'case " $* " in',
    '  *" view "*) printf \'%s\\n\' "$CPR_NPM_LATEST"; exit 0 ;;',
    '  *" install "*)',
    '    for a in "$@"; do case "$a" in llm-cpr@*) printf \'%s\' "${a#llm-cpr@}" > "$CPR_VERSION_STATE";; esac; done',
    '    exit 0 ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(npmStub, 0o755);
  const loginctlStub = path.join(base, 'loginctl-stub.sh');
  fs.writeFileSync(loginctlStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CPR_LOGINCTL_LOG"\nexit 0\n');
  fs.chmodSync(loginctlStub, 0o755);
  const env: Env = {
    // 接缝全集显式钉死：父进程若带着 CPR_*（如 e2e 的 CPR_UNIT_NAME）进来会污染 fixture 断言。
    CPR_UNIT_NAME: UNIT,
    CPR_SYSTEMCTL: systemctlStub,
    CPR_SYSTEMCTL_LOG: path.join(base, 'systemctl.log'),
    CPR_UNIT_DIR: path.join(base, 'unit'),
    CPR_CONFIG_DIR: path.join(base, 'config'),
    CPR_DATA_DIR: path.join(base, 'data'),
    CPR_SMOKE_CMD: 'true',
    CPR_NPM: npmStub,
    CPR_NPM_LOG: path.join(base, 'npm.log'),
    CPR_NPM_LATEST: '0.2.0',
    CPR_VERSION_STATE: versionState,
    CPR_BAD_VERSION: 'never-matches',
    CPR_LOGINCTL: loginctlStub,
    CPR_LOGINCTL_LOG: path.join(base, 'loginctl.log'),
    CPR_HEALTH_DELAY_MS: '10',
    // 用户补丁（工单 09）：目录钉 tmp；patch 用系统真二进制（Linux 标配）
    CPR_PATCH_DIR: path.join(base, 'patches'),
  };
  return { base, work, env };
}

function cpr(work: string, args: string[], env: Env): { status: number; stdout: string; stderr: string } {
  // 跑 fixture 拷贝里的 cpr.ts：v0.2.0 的包根按脚本自身位置推算（与 cwd 无关），拷贝即最小包根。
  const r = spawnSync(process.execPath, [path.join(work, 'scripts', 'cpr.ts'), ...args], { cwd: work, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function systemctlLog(fixture: Fixture): string[] {
  const file = fixture.env.CPR_SYSTEMCTL_LOG;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function npmLog(fixture: Fixture): string[] {
  const file = fixture.env.CPR_NPM_LOG;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// 用真 diff 生成一个可打的补丁（对 fixture 包内 rel 文件从 before 改到 after），避免手写 hunk 出错。
function writeUserPatch(fixture: Fixture, name: string, rel: string, before: string, after: string): void {
  const aDir = path.join(fixture.base, 'diff-a');
  const bDir = path.join(fixture.base, 'diff-b');
  fs.mkdirSync(path.join(aDir, path.dirname(rel)), { recursive: true });
  fs.mkdirSync(path.join(bDir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(aDir, rel), before);
  fs.writeFileSync(path.join(bDir, rel), after);
  const d = spawnSync('diff', ['-u', path.join(aDir, rel), path.join(bDir, rel)], { encoding: 'utf8' });
  assert.equal(d.status, 1, 'diff 应报差异（status 1）');
  const text = (d.stdout ?? '')
    .replace(/^--- .*$/m, `--- a/${rel}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${rel}`);
  fs.mkdirSync(fixture.env.CPR_PATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(fixture.env.CPR_PATCH_DIR, name), `${text}\n`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

// ---- doctor ----

test('doctor（npm 形态）：报告 PKGROOT/VERSION/LATEST/NEXT 结论行', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['doctor'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`PKGROOT=${f.work}`));
  assert.match(r.stdout, /MODE=npm/);
  assert.match(r.stdout, /VERSION=0\.1\.0/);
  assert.match(r.stdout, /LATEST=0\.2\.0/);
  assert.match(r.stdout, /DB=.*（不存在/);
  assert.match(r.stdout, /NEXT=有新版：cpr upgrade（当前 0\.1\.0 → 0\.2\.0）/);
});

test('doctor（clone 形态）：MODE=clone，NEXT 指向 git pull', () => {
  const f = makeFixture();
  fs.mkdirSync(path.join(f.work, '.git'));
  const r = cpr(f.work, ['doctor'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MODE=clone/);
  assert.match(r.stdout, /NEXT=clone 路线：git pull 自行升级/);
});

// ---- install ----

test('install --yes：写出 unit / .env(随机 master key) / ~/.cpr policy 三件套，并 enable --now', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const unitPath = path.join(f.env.CPR_UNIT_DIR, UNIT);
  assert.ok(fs.existsSync(unitPath));
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.ok(unit.includes(`WorkingDirectory=${f.work}`));
  assert.ok(unit.includes(`EnvironmentFile=${f.env.CPR_CONFIG_DIR}/.env`));
  assert.ok(unit.includes(`CPR_DB_FILE=${f.env.CPR_DATA_DIR}/data.db`));
  // unit 必须显式传接缝（review P2 修正）：systemd 不继承安装命令的环境，缺了会静默加载另一份 policy
  assert.ok(unit.includes(`Environment=CPR_CONFIG_DIR=${f.env.CPR_CONFIG_DIR}`));
  assert.ok(unit.includes(`Environment=CPR_DATA_DIR=${f.env.CPR_DATA_DIR}`));
  assert.ok(unit.includes('ExecStart=') && unit.includes('core/main.ts'));

  const envFile = path.join(f.env.CPR_CONFIG_DIR, '.env');
  assert.ok(fs.existsSync(envFile));
  const envText = fs.readFileSync(envFile, 'utf8');
  assert.match(envText, /^CPR_MASTER_KEY=[0-9a-f]{48}$/m);

  assert.ok(fs.existsSync(path.join(f.env.CPR_CONFIG_DIR, 'policy.example.ts')));
  assert.ok(fs.existsSync(path.join(f.env.CPR_CONFIG_DIR, 'policy.ts')));
  assert.ok(fs.existsSync(path.join(f.env.CPR_CONFIG_DIR, 'tsconfig.json')));
  assert.ok(fs.existsSync(path.join(f.env.CPR_CONFIG_DIR, 'package.json'))); // {"type":"module"}：外置 policy 的 ESM 判定
  assert.ok(fs.existsSync(f.env.CPR_DATA_DIR)); // 数据目录必须先建：SQLite 打不开缺父目录的库

  const calls = systemctlLog(f);
  assert.ok(calls.includes('--user daemon-reload'));
  assert.ok(calls.includes(`--user enable --now ${UNIT}`));
  assert.ok(unit.includes('WantedBy=default.target')); // 用户级 unit 的自启目标是 default.target
  const lingerLog = fs.existsSync(f.env.CPR_LOGINCTL_LOG) ? fs.readFileSync(f.env.CPR_LOGINCTL_LOG, 'utf8') : '';
  assert.match(lingerLog, /enable-linger/); // install 顺手开 linger：登出后服务照跑
});

test('install 重复执行幂等：.env 与 policy.ts 不被重置', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const envBefore = fs.readFileSync(path.join(f.env.CPR_CONFIG_DIR, '.env'), 'utf8');
  const localBefore = fs.readFileSync(path.join(f.env.CPR_CONFIG_DIR, 'policy.ts'), 'utf8');
  const callsBefore = systemctlLog(f).length;

  const r = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(f.env.CPR_CONFIG_DIR, '.env'), 'utf8'), envBefore);
  assert.equal(fs.readFileSync(path.join(f.env.CPR_CONFIG_DIR, 'policy.ts'), 'utf8'), localBefore);
  assert.ok(systemctlLog(f).length > callsBefore); // daemon-reload 仍会执行
});

// ---- upgrade ----

// ---- upgrade（v0.2.0 npm 形态）----

test('upgrade：clone 形态拒绝（引擎开发者走 git）', () => {
  const f = makeFixture();
  fs.mkdirSync(path.join(f.work, '.git'));
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /clone/);
  assert.deepEqual(npmLog(f), []); // 零 npm 动作（拒绝发生在查 registry 之前，日志都可能不存在）
});

test('upgrade：已是最新 → 零动作退出 0', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['upgrade', '--yes'], { ...f.env, CPR_NPM_LATEST: '0.1.0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /已是最新（0\.1\.0）/);
  assert.equal(fs.readFileSync(f.env.CPR_NPM_LOG, 'utf8').trim(), 'view llm-cpr version');
  assert.deepEqual(systemctlLog(f), []); // 零 systemd 动作
});

test('upgrade --yes：npm 装新版 → restart → is-active 门通过', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const npmLog = fs.readFileSync(f.env.CPR_NPM_LOG, 'utf8').split('\n').filter(Boolean);
  assert.ok(npmLog.includes('view llm-cpr version'));
  assert.ok(npmLog.includes('install -g llm-cpr@0.2.0'));
  assert.ok(systemctlLog(f).includes(`--user restart ${UNIT}`));
  assert.match(r.stdout, /完成。0\.1\.0 → 0\.2\.0，服务健康/);
});

test('upgrade --yes：新版起不来 → 自动装回旧版并恢复（回滚主线）', () => {
  const f = makeFixture();
  // CPR_BAD_VERSION=0.2.0：is-active 对「状态文件 = 0.2.0」判为非 active（systemctl stub 联动）
  const r = cpr(f.work, ['upgrade', '--yes'], { ...f.env, CPR_BAD_VERSION: '0.2.0' });
  assert.equal(r.status, 1); // 升级失败（尽管服务已恢复）
  const npmLog = fs.readFileSync(f.env.CPR_NPM_LOG, 'utf8').split('\n').filter(Boolean);
  assert.ok(npmLog.includes('install -g llm-cpr@0.2.0'));
  assert.ok(npmLog.includes('install -g llm-cpr@0.1.0')); // 自动回滚装回旧版
  assert.match(r.stderr, /未通过健康检查/);
  assert.match(r.stderr, /已自动退回 0\.1\.0，服务已恢复/);
  assert.equal(fs.readFileSync(f.env.CPR_VERSION_STATE, 'utf8'), '0.1.0'); // 磁盘上确实回到旧版
});

test('upgrade --to 0.0.5 --yes：跳过 registry 查询直装指定版', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['upgrade', '--to', '0.0.5', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const log = fs.readFileSync(f.env.CPR_NPM_LOG, 'utf8').split('\n').filter(Boolean);
  assert.ok(!log.some((line) => line.includes('view'))); // --to 不查 registry
  assert.ok(log.includes('install -g llm-cpr@0.0.5'));
});

// ---- 用户补丁（工单 09）----

test('install：~/.cpr/patches 自动打到包上，重跑幂等跳过不重复打', () => {
  const f = makeFixture();
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  const r = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /已打用户补丁：user\.patch/);
  assert.match(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8'), /patched by user/);
  // 幂等：再 install，补丁已应用 → 探测跳过，不会打第二遍
  const r2 = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /幂等跳过：user\.patch/);
  assert.equal(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8').match(/patched by user/g)?.length, 1);
});

test('doctor：PATCH 三态探测（无 / 未应用 / 已应用），探测不改文件', () => {
  const f = makeFixture();
  let r = cpr(f.work, ['doctor'], f.env);
  assert.match(r.stdout, /PATCH=无/);
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  r = cpr(f.work, ['doctor'], f.env);
  assert.match(r.stdout, /PATCH=未应用（user\.patch）/);
  assert.equal(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8'), '// fixture stub\n'); // 探测只读
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  r = cpr(f.work, ['doctor'], f.env);
  assert.match(r.stdout, /PATCH=已应用（user\.patch）/);
});

test('upgrade --yes：补丁与新版本冲突 → 升级失败自动回滚，旧版上如实报打不上', () => {
  const f = makeFixture();
  // 冲突补丁：目标文件在包里不存在，正向反向 dry-run 都不过
  fs.mkdirSync(f.env.CPR_PATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_PATCH_DIR, 'conflict.patch'), '--- a/core/nope.ts\n+++ b/core/nope.ts\n@@ -1 +1 @@\n-x\n+y\n');
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /补丁与新版本冲突，未打上：conflict\.patch/);
  assert.match(r.stderr, /升级失败（补丁冲突/);
  assert.match(r.stderr, /已自动退回 0\.1\.0，服务已恢复/);
  assert.match(r.stderr, /旧版上补丁也打不上（conflict\.patch）/);
  const log = fs.readFileSync(f.env.CPR_NPM_LOG, 'utf8').split('\n').filter(Boolean);
  assert.ok(log.includes('install -g llm-cpr@0.2.0'));
  assert.ok(log.includes('install -g llm-cpr@0.1.0')); // 自动回滚
  assert.equal(fs.readFileSync(f.env.CPR_VERSION_STATE, 'utf8'), '0.1.0'); // 磁盘回到旧版
});

test('upgrade --yes：包未变时补丁探测为已应用 → 跳过并照常完成升级', () => {
  const f = makeFixture();
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /幂等跳过：user\.patch/);
  assert.match(r.stdout, /完成。0\.1\.0 → 0\.2\.0，服务健康/);
});

// ---- uninstall ----

test('uninstall：停服务失败 → 拒绝继续，unit 与数据原样保留', () => {
  const f = makeFixture();
  const failStub = path.join(f.base, 'systemctl-fail.sh');
  // 服务在跑（is-active 成功）但 disable 失败——正好卡进新守卫的拒绝分支
  fs.writeFileSync(failStub, '#!/bin/sh\ncase " $* " in *" disable "*) exit 1;; esac\nexit 0\n');
  fs.chmodSync(failStub, 0o755);
  fs.mkdirSync(f.env.CPR_UNIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_UNIT_DIR, UNIT), '# dummy unit\n');
  fs.mkdirSync(f.env.CPR_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'rows');

  // --purge --yes 也不许在服务没停掉时动数据库
  const r = cpr(f.work, ['uninstall', '--purge', '--yes'], { ...f.env, CPR_SYSTEMCTL: failStub });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /拒绝继续卸载/);
  assert.ok(fs.existsSync(path.join(f.env.CPR_UNIT_DIR, UNIT)));
  assert.equal(fs.readFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'utf8'), 'rows');
});

test('uninstall：删 unit、停服务，数据目录原样保留；--purge 需 --yes', () => {
  const f = makeFixture();
  fs.mkdirSync(f.env.CPR_UNIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_UNIT_DIR, UNIT), '# dummy unit\n');
  fs.mkdirSync(f.env.CPR_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'rows');
  fs.mkdirSync(f.env.CPR_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_CONFIG_DIR, '.env'), 'CPR_MASTER_KEY=x\n');

  let r = cpr(f.work, ['uninstall'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(f.env.CPR_UNIT_DIR, UNIT)));
  assert.ok(systemctlLog(f).includes(`--user disable --now ${UNIT}`));
  assert.equal(fs.readFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'utf8'), 'rows');
  assert.equal(fs.readFileSync(path.join(f.env.CPR_CONFIG_DIR, '.env'), 'utf8'), 'CPR_MASTER_KEY=x\n');

  r = cpr(f.work, ['uninstall', '--purge'], f.env); // 非交互 → 确认为 N
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.env.CPR_DATA_DIR, 'usage.db')));

  r = cpr(f.work, ['uninstall', '--purge', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(f.env.CPR_DATA_DIR));
  assert.ok(!fs.existsSync(f.env.CPR_CONFIG_DIR));
  assert.ok(fs.existsSync(f.work)); // clone 目录永不删
});

// ---- main.ts 的 policy 加载（local 优先 / 回落 mine / 坏 local 拒启） ----

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

const LOCAL_POLICY = (name: string): string => `// 测试本地 policy
export default class LocalPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  backends = [{ name: '${name}', family: 'ocg', base_url: 'http://127.0.0.1:1/', key_env: 'LOCAL_NOPE' }];
  models = [{ id: 'm', backends: { ocg: 'm' } }];
  decide() { return null; }
}
`;

function makeMainCopy(twinName: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-main-'));
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'core', 'policy', 'mine.ts'), TWIN_MINE.replace('twin-stub', twinName));
  return root;
}

async function bootMain(root: string, extra: Env): Promise<{ subscriptions: { name: string }[]; stdout: string; child: ReturnType<typeof spawn> }> {
  const [forwardPort, adminPort] = await Promise.all([freePort(), freePort()]);
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-main-db-'));
  const child = spawn(process.execPath, ['core/main.ts'], {
    cwd: root,
    env: {
      ...process.env, ...extra,
      CPR_FORWARD_PORT: String(forwardPort),
      CPR_ADMIN_PORT: String(adminPort),
      CPR_SESSIONS_DB: path.join(dbs, 'sessions.db'),
      CPR_USAGE_DB: path.join(dbs, 'usage.db'),
      // .env / policy 加载（v0.2.0）默认读 ~/.cpr——钉到 tmp，保证测试 hermetic 不摸真家目录；
      // ...extra 收尾，个别测试可用自己的 CPR_CONFIG_DIR 覆盖（local policy 优先生效用例）。
      CPR_CONFIG_DIR: dbs,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/api/route/status`);
      if (res.ok) {
        const body = (await res.json()) as { subscriptions: { name: string }[] };
        return { ...body, stdout, child };
      }
    } catch { /* 未起，重试 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`main.ts 未在时限内起来：${stdout}`);
}

test('main.ts：无 ~/.cpr/policy.ts 回落 core/policy/mine.ts', async () => {
  const root = makeMainCopy('twin-stub');
  const { subscriptions, stdout, child } = await bootMain(root, {});
  try {
    assert.deepEqual(subscriptions.map((s) => s.name), ['twin-stub']);
    assert.match(stdout, /^llm-cpr \S+ — policy: core\/policy\/mine\.ts/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('main.ts：有 ~/.cpr/policy.ts 则优先生效', async () => {
  const root = makeMainCopy('twin-stub');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-local-policy-'));
  fs.writeFileSync(path.join(cfg, 'policy.ts'), LOCAL_POLICY('local-stub'));
  const { subscriptions, stdout, child } = await bootMain(root, { CPR_CONFIG_DIR: cfg });
  try {
    assert.deepEqual(subscriptions.map((s) => s.name), ['local-stub']);
    assert.match(stdout, /policy: .*policy\.ts/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('main.ts：坏 ~/.cpr/policy.ts 拒绝启动且报错指向该文件', () => {
  const root = makeMainCopy('twin-stub');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-bad-policy-'));
  fs.writeFileSync(path.join(cfg, 'policy.ts'), 'export default class Bad { backends = []; models = [] }\n');
  const r = spawnSync(process.execPath, ['core/main.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, CPR_CONFIG_DIR: cfg } });
  assert.equal(r.status, 1);
  assert.match(r.stderr ?? '', /policy\.ts/);
});
