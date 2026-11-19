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

// v0.2.0 npm 形态 fixture：work = bootstrap 副本（npx/npm 全局角色，无 git）。
// npm stub 模拟真 npm 的 -g --prefix 落盘：把 CPR_NPM_SOURCE 拷进 <prefix>/lib/node_modules/@ffrfree/llm-cpr
// 并建 <prefix>/bin/cpr 软链（实测形状）；systemctl stub 的 is-active 按真实 current 软链判活——
// 靠这对联动端到端复现「新版起不来 → 软链拨回 → 服务恢复」的零网络回滚主线。
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

  const systemctlStub = path.join(base, 'systemctl-stub.sh');
  fs.writeFileSync(systemctlStub, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$CPR_SYSTEMCTL_LOG"',
    'case " $* " in',
    '  *" is-active "*)',
    '    # 判活看真实 current 软链（工单 10）：没链=未装，链指到坏版本=起不来',
    '    [ -L "$CPR_CURRENT_LINK" ] || exit 3',
    '    v=$(basename "$(readlink "$CPR_CURRENT_LINK")")',
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
    '    prefix=""; ver=""; prev=""',
    '    for a in "$@"; do',
    '      [ "$prev" = "--prefix" ] && prefix="$a"',
    '      case "$a" in @ffrfree/llm-cpr@*) ver="${a#@ffrfree/llm-cpr@}";; esac',
    '      prev="$a"',
    '    done',
    '    # 模拟真 npm -g --prefix 的实测落点：包体进 <prefix>/lib/node_modules，bin 软链进 <prefix>/bin',
    '    dest="$prefix/lib/node_modules/@ffrfree/llm-cpr"',
    '    mkdir -p "$dest" "$prefix/bin"',
    '    cp -r "$CPR_NPM_SOURCE/." "$dest/"',
    '    ln -sf ../lib/node_modules/@ffrfree/llm-cpr/scripts/cpr.ts "$prefix/bin/cpr"',
    '    printf \'%s\\n\' "$ver" > "$dest/.npm-stub-version"',
    '    exit 0 ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(npmStub, 0o755);
  const loginctlStub = path.join(base, 'loginctl-stub.sh');
  fs.writeFileSync(loginctlStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CPR_LOGINCTL_LOG"\nexit 0\n');
  fs.chmodSync(loginctlStub, 0o755);
  const binDir = path.join(base, 'bin');
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
    CPR_NPM_SOURCE: work, // npm stub 落盘时拷贝的源（bootstrap 副本）
    CPR_BAD_VERSION: 'never-matches',
    CPR_LOGINCTL: loginctlStub,
    CPR_LOGINCTL_LOG: path.join(base, 'loginctl.log'),
    CPR_HEALTH_DELAY_MS: '10',
    // 工单 10：安装区/命令软链钉 tmp；PATH 带上 bin 目录模拟「发行版默认已含 ~/.local/bin」
    CPR_APP_ROOT: path.join(base, 'app'),
    CPR_CURRENT_LINK: path.join(base, 'app', 'current'),
    CPR_BIN_DIR: binDir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // 用户补丁（工单 09）：目录钉 tmp；patch 用系统真二进制（Linux 标配）
    CPR_PATCH_DIR: path.join(base, 'patches'),
  };
  return { base, work, env };
}

// 安装区里某版本的包根（断言用）
function engineOf(f: Fixture, version: string): string {
  return path.join(f.env.CPR_APP_ROOT, 'versions', version, 'app');
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

test('doctor（bootstrap 副本）：PKGROOT/VERSION/NEXT=先 install', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['doctor'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`PKGROOT=${f.work}`));
  assert.match(r.stdout, /MODE=bootstrap/);
  assert.match(r.stdout, /VERSION=0\.1\.0/); // 未安装 → 版本来自运行副本
  assert.match(r.stdout, /LATEST=0\.2\.0/);
  assert.match(r.stdout, /DB=.*（不存在/);
  assert.match(r.stdout, /NEXT=固定位置安装未建立：cpr install/);
});

test('doctor（已安装）：MODE 钉安装区、current → 版本、BIN=PATH ✓、NEXT=有新版', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['doctor'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MODE=npm 固定位置（.*，current → 0\.1\.0）/);
  assert.match(r.stdout, /VERSION=0\.1\.0/);
  assert.match(r.stdout, /BIN=.*（PATH ✓）/);
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

test('install --yes：写出 unit / .env(随机 master key) / ~/.llm-cpr policy 三件套，并 enable --now', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const appRoot = f.env.CPR_APP_ROOT;
  const engineLink = path.join(appRoot, 'current', 'app');
  // 安装区三件套（工单 10）：版本目录 / current 软链 / 命令软链
  assert.ok(fs.existsSync(path.join(engineOf(f, '0.1.0'), 'package.json')));
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.1.0');
  const binLink = path.join(f.env.CPR_BIN_DIR, 'cpr');
  assert.ok(fs.lstatSync(binLink).isSymbolicLink());
  assert.equal(fs.readlinkSync(binLink), path.join(appRoot, 'current', 'bin', 'cpr'));
  assert.ok(npmLog(f).includes(`install -g --prefix ${path.join(appRoot, 'versions', '0.1.0')} @ffrfree/llm-cpr@0.1.0`));
  // 工单 12：下载后必须搬离 node_modules（.ts 在那条路径下被 Node 拒跑），空壳一并清掉
  assert.ok(!fs.existsSync(path.join(appRoot, 'versions', '0.1.0', 'lib')));

  const unitPath = path.join(f.env.CPR_UNIT_DIR, UNIT);
  assert.ok(fs.existsSync(unitPath));
  const unit = fs.readFileSync(unitPath, 'utf8');
  // unit 钉 current（版本无关）：升级翻转软链后 restart 即用新版，unit 永不随版本重写
  assert.ok(unit.includes(`WorkingDirectory=${engineLink}`));
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${engineLink}/core/main.ts`));
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
  // review-2 P2：v0.1.0 生产 unit 的沙箱四行不得丢（05 重写曾漏）
  assert.ok(unit.includes('NoNewPrivileges=yes'));
  assert.ok(unit.includes('PrivateTmp=yes'));
  assert.ok(unit.includes('ProtectSystem=full'));
  assert.ok(unit.includes(`ReadWritePaths=${f.env.CPR_DATA_DIR}`)); // 引擎唯一可写面 = 用户数据目录
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

test('upgrade：未建立固定位置安装 → 拒绝并指路 install', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /固定位置安装尚未建立/);
  assert.deepEqual(npmLog(f), []); // 零 npm 动作
});

test('upgrade：已是最新 → 零动作退出 0', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const sysBefore = systemctlLog(f).length;
  const r = cpr(f.work, ['upgrade', '--yes'], { ...f.env, CPR_NPM_LATEST: '0.1.0' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /已是最新（0\.1\.0）/);
  const log = npmLog(f);
  assert.equal(log.at(-1), 'view @ffrfree/llm-cpr version');
  assert.equal(log.filter((line) => line.includes('install')).length, 1); // 只有首装那一次
  assert.equal(systemctlLog(f).length, sysBefore); // 零 systemd 动作
});

test('upgrade --yes：下载新版目录 → 软链切换 → is-active 门通过', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(npmLog(f).includes(`install -g --prefix ${path.join(f.env.CPR_APP_ROOT, 'versions', '0.2.0')} @ffrfree/llm-cpr@0.2.0`));
  assert.ok(systemctlLog(f).includes(`--user restart ${UNIT}`));
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.2.0');
  assert.ok(fs.existsSync(path.join(engineOf(f, '0.2.0'), 'package.json')));
  assert.match(r.stdout, /完成。0\.1\.0 → 0\.2\.0，服务健康/);
  // 版本保留策略：当前 + 上一版垫背
  assert.deepEqual(fs.readdirSync(path.join(f.env.CPR_APP_ROOT, 'versions')).sort(), ['0.1.0', '0.2.0']);
});

test('upgrade --yes：新版起不来 → 软链拨回（零网络回滚），服务恢复', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const logBefore = npmLog(f).length;
  // systemctl stub：current 指 0.2.0 时 is-active 判为起不来
  const r = cpr(f.work, ['upgrade', '--yes'], { ...f.env, CPR_BAD_VERSION: '0.2.0' });
  assert.equal(r.status, 1); // 升级失败（尽管服务已恢复）
  const log = npmLog(f).slice(logBefore); // 只看升级这一段（首装日志不算）
  assert.ok(log.some((line) => line.includes('@ffrfree/llm-cpr@0.2.0')));
  assert.ok(!log.some((line) => line.includes('@ffrfree/llm-cpr@0.1.0'))); // 回滚零 npm：软链拨回，不重新下载
  assert.match(r.stderr, /未通过健康检查/);
  assert.match(r.stderr, /已自动退回 0\.1\.0，服务已恢复/);
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.1.0'); // 磁盘上确实回到旧版
});

test('upgrade --to 0.0.5 --yes：跳过 registry 查询直装指定版', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['upgrade', '--to', '0.0.5', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const log = npmLog(f).slice(1); // 首装之外
  assert.ok(!log.some((line) => line.includes('view'))); // --to 不查 registry
  assert.ok(log.some((line) => line.includes('@ffrfree/llm-cpr@0.0.5')));
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.0.5');
});

test('upgrade --to 含路径字符的版本 → 白名单拒绝，零动作（review-2 P2）', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['upgrade', '--to', '../evil', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /版本号不合法/);
  assert.equal(npmLog(f).filter((line) => line.includes('install')).length, 1); // 零新 npm 动作
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.1.0'); // current 未动
});

test('install：补丁冲突 → current 未切换，不指向未验证版本（review-2 P2）', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0); // 先装 0.1.0
  fs.mkdirSync(f.env.CPR_PATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_PATCH_DIR, 'conflict.patch'), '--- a/core/nope.ts\n+++ b/core/nope.ts\n@@ -1 +1 @@\n-x\n+y\n');
  // 伪造「另一版本的 bootstrap 副本」（0.3.0）跑 install：补丁打不上必须拒切 current
  const work2 = path.join(f.base, 'work2');
  fs.cpSync(f.work, work2, { recursive: true });
  const pkgPath = path.join(work2, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  pkg.version = '0.3.0';
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const r = cpr(work2, ['install', '--yes'], { ...f.env, CPR_NPM_SOURCE: work2 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /打不上当前包：conflict\.patch/);
  // current 仍指 0.1.0（原验证过的完整品），绝不悄悄指向没验过的 0.3.0
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.1.0');
});

// ---- 用户补丁（工单 09）----

test('install：补丁打到版本目录（bootstrap 副本不动），重跑幂等跳过', () => {
  const f = makeFixture();
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  const r = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /已打用户补丁：user\.patch/);
  // 补丁落在生效的版本目录上；bootstrap 副本（work）原样未动
  const engineMain = path.join(engineOf(f, '0.1.0'), 'core', 'main.ts');
  assert.match(fs.readFileSync(engineMain, 'utf8'), /patched by user/);
  assert.equal(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8'), '// fixture stub\n');
  // 幂等：再 install，版本目录上已应用 → 探测跳过，不会打第二遍
  const r2 = cpr(f.work, ['install', '--yes'], f.env);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /幂等跳过：user\.patch/);
  assert.equal(fs.readFileSync(engineMain, 'utf8').match(/patched by user/g)?.length, 1);
});

test('doctor：PATCH 三态探测（无 / 未应用 / 已应用），探测不改文件', () => {
  const f = makeFixture();
  let r = cpr(f.work, ['doctor'], f.env);
  assert.match(r.stdout, /PATCH=无/);
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  r = cpr(f.work, ['doctor'], f.env); // bootstrap 副本上探测
  assert.match(r.stdout, /PATCH=未应用（user\.patch）/);
  assert.equal(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8'), '// fixture stub\n'); // 探测只读
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  r = cpr(f.work, ['doctor'], f.env); // 安装后对版本目录探测
  assert.match(r.stdout, /PATCH=已应用（user\.patch）/);
});

test('upgrade --yes：补丁与新版本冲突 → 拒绝，current 未切换、服务未动', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  // 冲突补丁：目标文件在包里不存在，正向反向 dry-run 都不过
  fs.mkdirSync(f.env.CPR_PATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.CPR_PATCH_DIR, 'conflict.patch'), '--- a/core/nope.ts\n+++ b/core/nope.ts\n@@ -1 +1 @@\n-x\n+y\n');
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /补丁与新版本冲突，未打上：conflict\.patch/);
  assert.match(r.stderr, /current 未切换，服务未动/);
  assert.equal(path.basename(fs.readlinkSync(f.env.CPR_CURRENT_LINK)), '0.1.0'); // 软链未动
  assert.ok(npmLog(f).some((line) => line.includes('@ffrfree/llm-cpr@0.2.0'))); // 新版目录已下载（修好补丁重试可复用）
});

test('upgrade --yes：新版目录全新 → 补丁重打在新版上', () => {
  const f = makeFixture();
  writeUserPatch(f, 'user.patch', 'core/main.ts', '// fixture stub\n', '// fixture stub\n// patched by user\n');
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // 新版目录是全新拷贝 → 补丁重打（而不是幂等跳过）
  assert.match(r.stdout, /已打用户补丁：user\.patch/);
  assert.match(fs.readFileSync(path.join(engineOf(f, '0.2.0'), 'core', 'main.ts'), 'utf8'), /patched by user/);
  assert.match(r.stdout, /完成。0\.1\.0 → 0\.2\.0，服务健康/);
});

test('bootstrap：从 node_modules 路径跑 .ts 被 Node 拒 → cpr.js 引导搬离后拉起（工单 12 真机火情回归）', () => {
  const f = makeFixture();
  // 模拟 npx/npm 全局的落盘形态：包整个住在 node_modules 树里
  const pkgDir = path.join(f.base, 'npx-cache', 'node_modules', '@ffrfree', 'llm-cpr');
  fs.mkdirSync(path.join(pkgDir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'scripts', 'cpr.js'), path.join(pkgDir, 'scripts', 'cpr.js'));
  fs.cpSync(path.join(f.work, 'scripts', 'cpr.ts'), path.join(pkgDir, 'scripts', 'cpr.ts'));
  fs.cpSync(path.join(f.work, 'package.json'), path.join(pkgDir, 'package.json'));
  // 对照组：node_modules 路径下直接跑 .ts —— Node 拒绝类型擦除（2026-11-19 本机 v22.22.3 实测的火）
  const direct = spawnSync(process.execPath, [path.join(pkgDir, 'scripts', 'cpr.ts'), 'doctor'], { encoding: 'utf8' });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr ?? '', /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|node_modules/);
  // 实验组：cpr.js 引导 → npm 下载（stub 落盘 node_modules，同真 npm）→ 搬离 → 从 app/ 拉起 .ts
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'scripts', 'cpr.js'), 'doctor'], { env: { ...process.env, ...f.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stderr ?? '') + (r.stdout ?? ''));
  assert.ok(r.stdout?.includes(`PKGROOT=${engineOf(f, '0.1.0')}`)); // CLI 已从 app/ 里跑起来
  assert.match(r.stdout, /MODE=bootstrap/); // current 未翻转（翻转归 install 过门后，bootstrap 只铺路）
  assert.ok(!fs.existsSync(path.join(f.env.CPR_APP_ROOT, 'versions', '0.1.0', 'lib'))); // node_modules 空壳已清
  assert.ok(fs.existsSync(path.join(engineOf(f, '0.1.0'), 'scripts', 'cpr.ts')));
});

// ---- uninstall ----

test('uninstall：停服务失败 → 拒绝继续，unit 与数据原样保留', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0); // 先建立安装区（is-active 按真实软链判活）
  fs.writeFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'rows');
  // 服务在跑（is-active 成功）但 disable 失败——正好卡进新守卫的拒绝分支
  const failStub = path.join(f.base, 'systemctl-fail.sh');
  fs.writeFileSync(failStub, '#!/bin/sh\ncase " $* " in *" disable "*) exit 1;; esac\nexec "$CPR_SYSTEMCTL_ORIG" "$@"\n');
  fs.chmodSync(failStub, 0o755);

  // --purge --yes 也不许在服务没停掉时动数据库
  const r = cpr(f.work, ['uninstall', '--purge', '--yes'], { ...f.env, CPR_SYSTEMCTL: failStub, CPR_SYSTEMCTL_ORIG: f.env.CPR_SYSTEMCTL });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /拒绝继续卸载/);
  assert.ok(fs.existsSync(path.join(f.env.CPR_UNIT_DIR, UNIT)));
  assert.equal(fs.readFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'utf8'), 'rows');
});

test('uninstall：删 unit/命令软链/代码安装区，数据原样保留；--purge 需 --yes', () => {
  const f = makeFixture();
  assert.equal(cpr(f.work, ['install', '--yes'], f.env).status, 0);
  fs.writeFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'rows');

  let r = cpr(f.work, ['uninstall'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.existsSync(path.join(f.env.CPR_UNIT_DIR, UNIT)));
  assert.ok(systemctlLog(f).includes(`--user disable --now ${UNIT}`));
  // 代码安装区整体移除（可再生），bootstrap 副本（work）永不删
  assert.ok(!fs.existsSync(f.env.CPR_APP_ROOT));
  assert.ok(!fs.existsSync(path.join(f.env.CPR_BIN_DIR, 'cpr')));
  assert.equal(fs.readFileSync(path.join(f.env.CPR_DATA_DIR, 'usage.db'), 'utf8'), 'rows'); // 数据原样
  assert.ok(fs.existsSync(path.join(f.env.CPR_CONFIG_DIR, '.env'))); // 密钥原样

  r = cpr(f.work, ['uninstall', '--purge'], f.env); // 非交互 → 确认为 N
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(f.env.CPR_DATA_DIR, 'usage.db')));

  r = cpr(f.work, ['uninstall', '--purge', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.existsSync(f.env.CPR_DATA_DIR));
  assert.ok(!fs.existsSync(f.env.CPR_CONFIG_DIR));
  assert.ok(fs.existsSync(f.work)); // clone/bootstrap 副本永不删
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
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', name: '@ffrfree/llm-cpr', version: '0.1.0' }) + "\n");
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
      // .env / policy 加载（v0.2.0）默认读 ~/.llm-cpr——钉到 tmp，保证测试 hermetic 不摸真家目录；
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

test('main.ts：无 ~/.llm-cpr/policy.ts 回落 core/policy/mine.ts', async () => {
  const root = makeMainCopy('twin-stub');
  const { subscriptions, stdout, child } = await bootMain(root, {});
  try {
    assert.deepEqual(subscriptions.map((s) => s.name), ['twin-stub']);
    assert.match(stdout, /^llm-cpr 0\.1\.0 — policy: core\/policy\/mine\.ts/); // 版本行 = 包内 package.json（npm 形态正源，v0.1.0 的 RELEASE.txt/git 机制已退役）
  } finally {
    child.kill('SIGTERM');
  }
});

test('main.ts：有 ~/.llm-cpr/policy.ts 则优先生效', async () => {
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

test('main.ts：坏 ~/.llm-cpr/policy.ts 拒绝启动且报错指向该文件', () => {
  const root = makeMainCopy('twin-stub');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-bad-policy-'));
  fs.writeFileSync(path.join(cfg, 'policy.ts'), 'export default class Bad { backends = []; models = [] }\n');
  const r = spawnSync(process.execPath, ['core/main.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, CPR_CONFIG_DIR: cfg } });
  assert.equal(r.status, 1);
  assert.match(r.stderr ?? '', /policy\.ts/);
});
