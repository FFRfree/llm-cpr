#!/usr/bin/env node
// scripts/cpr.ts — llm-cpr 用户侧 doctor / install / upgrade / uninstall（v0.2.0 npm 形态，ADR-0008/0009）。
// 运行形态三种，包根一律按本文件位置推算，与 cwd 无关：
//   clone（引擎开发者，node scripts/cpr.ts）/ bootstrap（npx 或 npm 全局副本跑首装）/ 安装区（~/.local/lib/llm-cpr）。
// 安装纪律（工单 10）：npm 只当下载器——npm install -g --prefix 装进自家固定位置，版本目录 + current 软链
//   （Homebrew Cellar/opt、SDKMAN current 同款）：切换原子、回滚零网络、单实例有构造保证。用户级服务免 sudo。
// 安全边界：升级失败把 current 软链拨回去（原子回滚，加法迁移保「旧代码跑新库」）；重启只在用户确认（y / --yes）后执行；
//   uninstall 永不静默删 ~/.llm-cpr（数据/密钥红线）。
// macOS：LaunchAgent 路线随版提供但标 experimental（无真机验证过 launchd 行为，doctor/文档口径一致）。
// 测试接缝（未设置 = 生产行为，测试经临时目录 + stub 全隔离）：
//   CPR_SYSTEMCTL        systemctl 路径（stub 把 argv 记到 CPR_SYSTEMCTL_LOG；Linux 下每条都带 --user）
//   CPR_LOGINCTL         loginctl 路径（stub 记 argv 到 CPR_LOGINCTL_LOG；install 顺手 enable-linger）
//   CPR_NPM              npm 路径（stub 记 argv 到 CPR_NPM_LOG；fixture 另用 CPR_NPM_SOURCE 模拟落盘）
//   CPR_PATCH_DIR        用户补丁目录，默认 ~/.llm-cpr/patches（fixture 钉 tmp）
//   CPR_PATCH_BIN        patch 二进制路径（默认系统 patch；fixture 用真二进制）
//   CPR_APP_ROOT         代码安装区，默认 ~/.local/lib/llm-cpr（versions/ + current 软链；fixture 钉 tmp）
//   CPR_BIN_DIR          命令软链目录，默认 ~/.local/bin（PATH 惯例位置；fixture 钉 tmp）
//   CPR_UNIT_DIR         unit 写入目录，默认 Linux ~/.config/systemd/user / macOS ~/Library/LaunchAgents
//   CPR_CONFIG_DIR       .env/policy 目录，默认 ~/.llm-cpr（与 core/paths.ts 同源；CLI 保持自包含零依赖，两处并列改）
//   CPR_DATA_DIR         数据目录，默认 ~/.llm-cpr
//   CPR_SMOKE_CMD        install 冒烟命令（sh -c，在引擎根执行）；缺省 = 引擎自举冒烟（临时 DB + 0 端口）
//   CPR_HEALTH_DELAY_MS  upgrade 健康检查轮询间隔（默认 1000ms），测试钉小值加速
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
// 第三方运行时依赖经 vendor 接缝进包（ADR-0010）：#pc → package.json "imports" → vendor/picocolors 源码副本，
// 版本正本在 devDependencies（npm run vendor 重建 vendor/）。非 TTY（管道/测试）下 picocolors 自动退纯文本。
import pc from '#pc';

const BRAND = 'llm-cpr'; // 身份面：unit 名（llm-cpr.service）与 launcher label 沿用短名
// npm 包名（registry 面，工单 11）：scoped 名 = ffrfree 用户名空间——npm 允许用户直接以自己
// 的用户名作 scope 发包，无需建 org（npm 也不允许 org 与现有用户名重名）。裸名 llm-cpr 留在
// npmjs 不占，将来要发"去前缀"发行版随时可发（scoped 与裸名是两个独立包，可并存）。
const PKG = '@ffrfree/llm-cpr';
const DARWIN = os.platform() === 'darwin';
// unit 名可注入：端到端测试用独立名字（如 llm-cpr-e2e）装在真 systemd 上，与生产 unit 错开。
// 后缀归一化：用户传裸名（不带 .service）时自动补上，否则 systemd 按 <名>.service 找不到 unit 文件。
const unitNameRaw = process.env.CPR_UNIT_NAME || 'llm-cpr.service';
const UNIT_NAME = unitNameRaw.endsWith('.service') ? unitNameRaw : `${unitNameRaw}.service`;
// macOS LaunchAgent 的 label/plist（experimental）：与 Linux unit 名分开，launchctl 按 label 找。
const DARWIN_LABEL = 'dev.llm-cpr';
const DARWIN_PLIST = `${DARWIN_LABEL}.plist`;

interface RunResult { ok: boolean; out: string; err: string }

function sh(command: string, cwd: string): RunResult {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function die(message: string): never {
  console.error(pc.red(`cpr: ${message}`));
  process.exit(1);
}

// 包根 = 本文件所在 scripts/ 的上一级（clone 根或 npm 全局包目录），与 cwd 无关。
// fixture（最小仓拷贝）同构成立：scripts/ + package.json + core/main.ts 在同一根下。
function pkgRoot(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'core', 'main.ts'))) {
    die(`包根不完整（${root} 缺 package.json / core/main.ts）——安装损坏，重跑 npx -y ${PKG} install；clone 请在完整仓库里运行`);
  }
  return root;
}

function versionOf(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

// 版本号白名单（review-2 P2）：--to 与一切参与路径拼接的版本号都要过这道门——
// 含路径字符的值可把 npm --prefix 落到 versions/ 之外、把 current 指向安装区之外。
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function versionId(raw: string): string {
  if (!VERSION_RE.test(raw)) die(`版本号不合法：${raw}（期望 x.y.z 形态，不带路径分隔符）`);
  return raw;
}

// ---- 测试接缝 ----

const unitDir = (): string =>
  process.env.CPR_UNIT_DIR || (DARWIN ? path.join(os.homedir(), 'Library', 'LaunchAgents') : path.join(os.homedir(), '.config', 'systemd', 'user'));
const configDir = (): string => process.env.CPR_CONFIG_DIR || path.join(os.homedir(), '.llm-cpr');
const dataDir = (): string => process.env.CPR_DATA_DIR || path.join(os.homedir(), '.llm-cpr');

// ---- 代码安装区（工单 10 / ADR-0009）----
// npm 只当下载器：npm install -g --prefix 装进自家固定位置，与用户的 node 安装方式（nvm/apt/Homebrew）解耦；
// 版本目录 + current 软链（Homebrew Cellar/opt、SDKMAN current 同款）——切换原子、回滚零网络。
const appRoot = (): string => process.env.CPR_APP_ROOT || path.join(os.homedir(), '.local', 'lib', BRAND);
const versionsDir = (): string => path.join(appRoot(), 'versions');
const currentLink = (): string => path.join(appRoot(), 'current');
const binDir = (): string => process.env.CPR_BIN_DIR || path.join(os.homedir(), '.local', 'bin');

// 某版本的包根（工单 12：Node 拒跑 node_modules 路径下的 .ts，npm 落盘后必须搬离到 versions/<v>/app）
function versionRoot(version: string): string {
  return path.join(versionsDir(), version, 'app');
}

// 下载后搬迁：npm 的落盘形状是 <prefix>/lib/node_modules/@ffrfree/llm-cpr（.ts 在那里跑不起来，
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING 本机实测）——rename 原子搬到 <prefix>/app，
// 并把版本内 bin 软链重指 ../app/scripts/cpr.ts（npm 自建的那条指向旧地址，作废清理）。
function relocateFromNodeModules(version: string): void {
  const prefix = path.join(versionsDir(), version);
  const src = path.join(prefix, 'lib', 'node_modules', PKG);
  if (!fs.existsSync(path.join(src, 'package.json'))) die(`搬迁失败：${src} 缺包——中止，current 未动`);
  fs.rmSync(versionRoot(version), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(versionRoot(version)), { recursive: true });
  fs.renameSync(src, versionRoot(version));
  fs.rmSync(path.join(prefix, 'lib'), { recursive: true, force: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.rmSync(path.join(prefix, 'bin', 'cpr'), { force: true });
  fs.symlinkSync('../app/scripts/cpr.js', path.join(prefix, 'bin', 'cpr'), 'file'); // 指向 JS 引导器：不依赖 .ts 带 +x 位（真机升级实测的坑），任何环境都能跑
}

// 当前生效版本 = current 软链 basename；未安装 = null
function installedVersion(): string | null {
  try {
    return path.basename(fs.readlinkSync(currentLink())) || null;
  } catch {
    return null;
  }
}

// current 软链翻转：先建新链再 rename 换名——rename 原子，永不出现「没有 current」的窗口。
// review-2 P2：唯一随机名防并发撞车（毫秒时间戳同名可互踩、rename 到别人的链）；翻转后核对目标再收工。
function flipCurrent(version: string): void {
  if (!VERSION_RE.test(version)) die(`版本号不合法：${version}`);
  fs.mkdirSync(versionsDir(), { recursive: true });
  const tmp = `${currentLink()}.new-${crypto.randomUUID()}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(`versions/${version}`, tmp, 'dir');
  fs.renameSync(tmp, currentLink());
  const flipped = path.basename(fs.readlinkSync(currentLink()));
  if (flipped !== version) die(`current 翻转异常：期望 ${version} 实指 ${flipped}——请检查 ${appRoot()}`);
}

// PATH 里有没有命令软链目录（XDG 规范原话：发行版应保证 ~/.local/bin 进 PATH）
const binDirOnPath = (): boolean => (process.env.PATH ?? '').split(path.delimiter).includes(binDir());

function systemctl(...args: readonly string[]): RunResult {
  const bin = process.env.CPR_SYSTEMCTL || 'systemctl';
  // v0.2.0 用户级服务：永远 --user、永不 sudo（ADR-0008）。
  const r = spawnSync(bin, ['--user', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function loginctl(...args: readonly string[]): RunResult {
  const bin = process.env.CPR_LOGINCTL || 'loginctl';
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function runNpm(...args: readonly string[]): RunResult {
  const bin = process.env.CPR_NPM || 'npm';
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const npmLatest = (): string | null => {
  const r = runNpm('view', PKG, 'version');
  return r.ok && r.out ? r.out.split('\n').at(-1)?.trim() || null : null;
};

// npm 只当下载器：装进自家版本目录（--prefix 实测形状：<prefix>/lib/node_modules/@ffrfree/llm-cpr + <prefix>/bin/cpr）
const npmInstall = (version: string): RunResult =>
  runNpm('install', '-g', '--prefix', path.join(versionsDir(), version), `${PKG}@${version}`);

// ---- 用户补丁（~/.llm-cpr/patches/*.patch，工单 09）----
// 正门仍是 policy 钩子；补丁是契约表达不了的引擎级诉求的受控逃生门：
// 零 npm 依赖（系统 patch 二进制，Linux/macOS 标配）、状态显性化、打不上=失败绝不静默。

const patchDir = (): string => process.env.CPR_PATCH_DIR || path.join(os.homedir(), '.llm-cpr', 'patches');

function runPatch(args: readonly string[]): RunResult {
  const bin = process.env.CPR_PATCH_BIN || 'patch';
  // --batch：永不交互提问，拿不准一律算失败（探测语义成立的前提）。
  const r = spawnSync(bin, ['--batch', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

interface PatchProbe { pending: string[]; applied: string[]; conflicts: string[] }

// 探测（只读不改文件）——必须读输出标记而不是退出码：
//   GNU patch 会自作主张翻转方向（已打文件上正向跑自动 -R、原始文件上反向跑自动忽略 -R，四种组合全 exit 0）。
//   唯一可靠信号：正向 dry-run 输出里出现 "Reversed (or previously applied)" = 已打；干净通过 = 未打；非零 = 冲突。
function probeUserPatches(root: string): PatchProbe {
  const probe: PatchProbe = { pending: [], applied: [], conflicts: [] };
  const dir = patchDir();
  if (!fs.existsSync(dir)) return probe;
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.patch')).sort()) {
    const forward = runPatch(['--dry-run', '-d', root, '-p1', '-i', path.join(dir, name)]);
    const combined = `${forward.out}\n${forward.err}`;
    if (!forward.ok) probe.conflicts.push(name);
    else if (/Reversed \(or previously applied\)|Unreversed patch detected/.test(combined)) probe.applied.push(name);
    else probe.pending.push(name);
  }
  return probe;
}

// 应用：只真打「探测判为 pending」的补丁——dry-run 失败的从不真打，保证不会半截应用。
function applyUserPatches(root: string): { applied: string[]; skipped: string[]; conflicts: string[] } {
  const probe = probeUserPatches(root);
  const applied: string[] = [];
  for (const name of probe.pending) {
    const real = runPatch(['-d', root, '-p1', '-i', path.join(patchDir(), name)]);
    if (real.ok) applied.push(name);
    else probe.conflicts.push(name);
  }
  return { applied, skipped: probe.applied, conflicts: probe.conflicts };
}

const launchctl = (...args: readonly string[]): RunResult => {
  const bin = process.env.CPR_LAUNCHCTL || 'launchctl';
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

// process.getuid 在 @types/node 里是「可能未定义」（Windows），launchd 只在 darwin 用，兜个默认。
const uid = (): number => process.getuid?.() ?? 1000;

function nodeRequirement(root: string): { ok: boolean; have: string; want: string } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  const want = pkg.engines?.node ?? '';
  const have = process.versions.node;
  const m = />=\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(want);
  if (!m) return { ok: true, have, want: want || '(未声明)' };
  const [wantMajor, wantMinor, wantPatch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const [haveMajor, haveMinor, havePatch] = have.split('.').map(Number);
  const ok = haveMajor > wantMajor
    || (haveMajor === wantMajor && haveMinor > wantMinor)
    || (haveMajor === wantMajor && haveMinor === wantMinor && havePatch >= wantPatch);
  return { ok, have, want };
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) { console.log(`[--yes] ${question} → y`); return true; }
  if (!process.stdin.isTTY) { console.log(`[非交互] ${question} → N`); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---- 服务原语（Linux user unit / macOS LaunchAgent） ----

const unitPath = (): string => path.join(unitDir(), DARWIN ? DARWIN_PLIST : UNIT_NAME);

function serviceActive(): boolean {
  if (DARWIN) {
    const r = launchctl('list');
    return r.ok && r.out.split('\n').some((line) => line.includes(DARWIN_LABEL));
  }
  return systemctl('is-active', UNIT_NAME).ok; // exit 0 = active
}

function serviceRestart(): RunResult {
  if (DARWIN) return launchctl('kickstart', '-k', `gui/${uid()}/${DARWIN_LABEL}`);
  return systemctl('restart', UNIT_NAME);
}

function serviceStart(): RunResult {
  if (DARWIN) return launchctl('bootstrap', `gui/${uid()}`, unitPath());
  return systemctl('enable', '--now', UNIT_NAME);
}

// 升级健康门：重启 → 轮询 is-active。engine fail-fast（坏 policy/迁移失败）会让 unit 进 failed 态，这里抓得住。
async function serviceUpAfterRestart(): Promise<boolean> {
  const restart = serviceRestart();
  if (!restart.ok) return false;
  const delayMs = Number(process.env.CPR_HEALTH_DELAY_MS ?? 1000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (serviceActive()) return true;
  }
  return false;
}

// ---- unit / plist 内容 ----

// unit 钉 current 软链（版本无关）：写一次，升级翻转软链后 restart 即用新版，unit 文件永不随版本重写。
// 沙箱四行继承自 v0.1.0 生产 unit（review-2 P2 修复：05 重写时曾丢）——用户级不等于不设防；
// ProtectSystem=full 罩住 /usr、/boot、/etc，引擎唯一可写面 = ReadWritePaths 的用户数据目录。
function enginePath(): string {
  return path.join(appRoot(), 'current', 'app');
}

function unitFileContent(): string {
  const config = configDir();
  const data = dataDir();
  const engine = enginePath();
  return `[Unit]
Description=llm-cpr — LLM 订阅路由网关
[Service]
Type=simple
WorkingDirectory=${engine}
ExecStart=${process.execPath} ${path.join(engine, 'core', 'main.ts')}
EnvironmentFile=${config}/.env
Environment=CPR_DB_FILE=${data}/data.db
Environment=CPR_CONFIG_DIR=${config}
Environment=CPR_DATA_DIR=${data}
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=${data}
[Install]
WantedBy=default.target
`;
}

// macOS experimental：EnvironmentFile 没有等价物，环境键直接进 plist。
function plistFileContent(): string {
  const config = configDir();
  const data = dataDir();
  const engine = enginePath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${DARWIN_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(engine, 'core', 'main.ts')}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>CPR_CONFIG_DIR</key><string>${config}</string>
    <key>CPR_DATA_DIR</key><string>${data}</string>
    <key>CPR_DB_FILE</key><string>${path.join(data, 'data.db')}</string>
  </dict>
</dict></plist>
`;
}

// ---- install 冒烟 ----

async function bootSmoke(root: string): Promise<boolean> {
  if (process.env.CPR_SMOKE_CMD) {
    const smokeRun = sh(process.env.CPR_SMOKE_CMD, root);
    if (!smokeRun.ok) {
      console.error(`cpr: 冒烟未通过：\n${smokeRun.out}\n${smokeRun.err}`);
      return false;
    }
    return true;
  }
  // 默认 = 引擎自举冒烟：policy/.env 全按 ~/.llm-cpr 真身（顺带验证模板与 .env 可用），
  // 库与端口走临时值（CPR_DATA_DIR=tmp + 端口 0），不碰真实 data.db 与声明端口。
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-install-smoke-'));
  const child = spawn(process.execPath, [path.join(root, 'core', 'main.ts')], {
    cwd: root,
    env: { ...process.env, CPR_CONFIG_DIR: configDir(), CPR_DATA_DIR: tmpData, CPR_FORWARD_PORT: '0', CPR_ADMIN_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const ok = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.error(`cpr: 冒烟超时（15s 内管理口未起来）：\n${out}\n${err}`);
      finish(false);
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += String(chunk);
      const match = /admin listening on (\S+)/.exec(out);
      if (match) {
        console.log(pc.green(`cpr: 冒烟通过（${match[1]}）`));
        finish(true);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { err += String(chunk); });
    child.on('exit', () => {
      console.error(`cpr: 冒烟进程提前退出：\n${out}\n${err}`);
      finish(false);
    });
  });
  fs.rmSync(tmpData, { recursive: true, force: true });
  return ok;
}

// ---- doctor ----

async function doctor(): Promise<number> {
  const root = pkgRoot();
  const node = nodeRequirement(root);
  console.log(`NODE=${node.have}${node.ok ? pc.green(' OK') : pc.red(` 不满足（要求 ${node.want}）`)}`);
  console.log(`PKGROOT=${root}`);
  const isClone = fs.existsSync(path.join(root, '.git'));
  const installed = installedVersion();
  console.log(`MODE=${isClone
    ? 'clone（引擎开发者路线，升级走 git pull）'
    : installed ? `npm 固定位置（${appRoot()}，current → ${installed}）` : 'bootstrap（npx/npm 全局副本——固定位置安装尚未建立）'}`);
  const current = installed ?? versionOf(root);
  console.log(`VERSION=${current}`);
  const npmProbe = sh('npm --version', root);
  console.log(`NPM=${npmProbe.ok ? npmProbe.out : '不可用（cpr upgrade 需要）'}`);
  const latest = npmLatest();
  console.log(`LATEST=${latest ?? '查询失败（离线？registry 不可达）'}`);
  // 命令软链三态：没链 / 有链 PATH 缺 / 就位
  const binLink = path.join(binDir(), 'cpr');
  const binStat = fs.lstatSync(binLink, { throwIfNoEntry: false });
  const binLine = !binStat ? `BIN=${binLink}（不存在——cpr install 建立）`
    : !binStat.isSymbolicLink() ? `BIN=${binLink}（存在但非本产品软链）`
      : `BIN=${binLink}（${binDirOnPath() ? 'PATH ✓' : `PATH 未含 ${binDir()}——export PATH="${binDir()}:$PATH" 写进 shell 配置`}）`;
  console.log(binLine);
  const unitFile = unitPath();
  const unitExists = fs.existsSync(unitFile);
  console.log(`UNIT=${serviceActive() ? 'active' : 'inactive/未装'}（${unitFile}${unitExists ? '' : '，文件不存在'}）`);
  const dbFile = path.join(dataDir(), 'data.db');
  let dbLine = `DB=${dbFile}（不存在——未启动过）`;
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);
      db.close();
      dbLine = `DB=${dbFile}（schema v${version}）`;
    } catch (error) {
      dbLine = `DB=${dbFile}（读取失败：${error instanceof Error ? error.message : String(error)}）`;
    }
  }
  console.log(dbLine);
  console.log(`POLICY=${fs.existsSync(path.join(configDir(), 'policy.ts')) ? path.join(configDir(), 'policy.ts') : '无（回落内置 mine）'}`);
  // 补丁打在生效版本目录上（版本目录建成后不可变）；bootstrap 阶段对运行副本只探测不落。
  const probeRoot = installed ? versionRoot(installed) : root;
  const patchProbe = probeUserPatches(probeRoot);
  const patchCount = patchProbe.pending.length + patchProbe.applied.length + patchProbe.conflicts.length;
  const patchState = patchCount === 0 ? '无'
    : patchProbe.conflicts.length > 0 ? `冲突（${patchProbe.conflicts.join('、')}）`
      : patchProbe.pending.length > 0 ? `未应用（${patchProbe.pending.join('、')}）`
        : `已应用（${patchProbe.applied.join('、')}）`;
  console.log(`PATCH=${patchState}`);
  console.log(`DATA=${dataDir()}${fs.existsSync(dataDir()) ? '' : '（不存在）'}`);
  console.log('--- 建议 ---');
  if (!node.ok) console.log(`NEXT=先升级 Node（要求 ${node.want}）`);
  else if (!npmProbe.ok) console.log('NEXT=安装 npm（cpr upgrade 需要）');
  else if (isClone) console.log('NEXT=clone 路线：git pull 自行升级（cpr upgrade 只服务 npm 安装）');
  else if (!installed) console.log('NEXT=固定位置安装未建立：cpr install');
  else if (patchProbe.conflicts.length > 0) console.log('NEXT=补丁与当前版本冲突：对包内目标文件重新做 diff，更新 ~/.llm-cpr/patches/ 后重跑 cpr install');
  else if (patchProbe.pending.length > 0) console.log('NEXT=补丁未应用：重跑 cpr install（幂等，会打补丁并冒烟）');
  else if (!binStat) console.log(`NEXT=命令软链缺失：cpr install 建立（${binLink}）`);
  else if (!binDirOnPath()) console.log(`NEXT=PATH 未含 ${binDir()}：export PATH="${binDir()}:$PATH" 写进 shell 配置后重开终端`);
  else if (latest && latest !== current) console.log(`NEXT=有新版：cpr upgrade（当前 ${current} → ${latest}）`);
  else if (!unitExists) console.log('NEXT=服务未安装：cpr install');
  else if (!serviceActive()) console.log(`NEXT=服务未在跑：systemctl --user enable --now ${UNIT_NAME}（或 cpr install）`);
  else console.log('NEXT=一切正常');
  return 0;
}

// ---- install ----

async function install(yes: boolean): Promise<number> {
  const root = pkgRoot();
  const node = nodeRequirement(root);
  if (!node.ok) die(`Node ${node.have} 不满足要求 ${node.want}——先升级 Node 再安装`);
  console.log(`cpr: Node ${node.have} ✓`);

  // ---- 代码落位（工单 10）：装进自家固定位置，npm 只当下载器 ----
  const selfVersion = versionId(versionOf(root));
  const engine = versionRoot(selfVersion);
  if (fs.existsSync(path.join(engine, 'package.json'))) {
    console.log(`cpr: 版本目录已存在（${engine}），跳过下载`);
  } else {
    const installRun = npmInstall(selfVersion);
    if (!installRun.ok) {
      console.error(`cpr: npm 下载失败：${installRun.err}\ncpr: 未做任何改动。`);
      return 1;
    }
    // Node 拒跑 node_modules 路径下的 .ts（工单 12）——落盘后立刻搬离
    relocateFromNodeModules(selfVersion);
    if (!fs.existsSync(path.join(engine, 'package.json'))) {
      console.error(`cpr: npm 声称装好但 ${engine} 缺包——prefix 落点异常，中止。`);
      return 1;
    }
    console.log(`cpr: 已下载 ${PKG}@${selfVersion} → ${engine}`);
  }

  const example = path.join(root, 'policy.example.ts');
  if (!fs.existsSync(example)) die('包缺 policy.example.ts——安装不完整，重装（npm）或重新 clone');
  // v0.2.0：用户声明住 ~/.llm-cpr（configDir 接缝），不进 clone/release——升级永不冲掉用户文件。
  const policyDir = configDir();
  fs.mkdirSync(policyDir, { recursive: true });
  const exampleDest = path.join(policyDir, 'policy.example.ts');
  if (fs.existsSync(exampleDest)) console.log(`cpr: ${exampleDest} 已存在，保留现状`);
  else {
    fs.copyFileSync(example, exampleDest);
    console.log(`cpr: 已写模板 ${exampleDest}`);
  }
  const local = path.join(policyDir, 'policy.ts');
  if (fs.existsSync(local)) console.log(`cpr: ${local} 已存在，保留现状`);
  else {
    fs.copyFileSync(exampleDest, local);
    console.log(`cpr: 已从模板创建 ${local}——订阅声明在里面改（name 定了绝不改）`);
  }
  // 编辑器类型补全指路：policy 文件 `import type ... from '@ffrfree/llm-cpr'` 靠这份 tsconfig 的 paths 解析；
  // 类型导入运行时被擦除，缺它只影响编辑器提示不影响加载。幂等：已存在不重写。
  // 同目录的 package.json {"type":"module"} 让 NodeNext 把外置 policy 判成 ESM（review P3 修正）。
  const pkgPath = path.join(policyDir, 'package.json');
  if (fs.existsSync(pkgPath)) console.log(`cpr: ${pkgPath} 已存在，保留现状`);
  else {
    fs.writeFileSync(pkgPath, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
    console.log(`cpr: 已写 ${pkgPath}（{"type":"module"}——外置 policy 的 ESM 判定）`);
  }
  const tsconfigPath = path.join(policyDir, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) console.log(`cpr: ${tsconfigPath} 已存在，保留现状`);
  else {
    const contract = path.join(root, 'core', 'policy', 'contract.ts');
    fs.writeFileSync(tsconfigPath, `${JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
        allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true,
        skipLibCheck: true,
        baseUrl: '.',
        paths: { '@ffrfree/llm-cpr': [contract] },
      },
      include: ['policy.ts', 'policy.example.ts'],
    }, null, 2)}\n`);
    console.log(`cpr: 已写 ${tsconfigPath}（类型补全指路）`);
  }

  const envFile = path.join(configDir(), '.env');
  if (fs.existsSync(envFile)) console.log(`cpr: ${envFile} 已存在，保留现状`);
  else {
    const exampleEnv = path.join(root, '.env.example');
    const base = fs.existsSync(exampleEnv) ? fs.readFileSync(exampleEnv, 'utf8') : `${'CPR_MASTER_KEY='}${'***'}${''}\n`;
    const masterKey = crypto.randomBytes(24).toString('hex');
    const text = base.replace(/^CPR_MASTER_KEY=.*$/m, `CPR_MASTER_KEY=${masterKey}`);
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    console.log(`cpr: 已生成 ${envFile}（已随机生成 CPR_MASTER_KEY；订阅 key 按 policy.ts 的 key_env 名补齐）`);
  }

  // 数据目录必须先建：node:sqlite 打开库文件不会自动创建父目录，缺目录首次启动直接失败。
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  console.log(`cpr: 数据目录 ${dataDir()} ✓`);

  // v0.2.0：用户级服务，不要 sudo（ADR-0008）。Linux systemctl --user + linger；macOS LaunchAgent（experimental）。
  const unitFile = unitPath();
  const content = DARWIN ? plistFileContent() : unitFileContent();
  fs.mkdirSync(unitDir(), { recursive: true });
  if (fs.existsSync(unitFile)) {
    if (fs.readFileSync(unitFile, 'utf8') === content) console.log(`cpr: ${unitFile} 内容一致，跳过`);
    else {
      if (!(await confirm(`${unitFile} 已存在且内容不同，覆盖？`, yes))) {
        console.log('cpr: 未写 unit；请人工比对后重跑（旧文件不会被本命令改动）。');
        return 1;
      }
      const backup = `${unitFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(unitFile, backup);
      fs.writeFileSync(unitFile, content, { mode: 0o644 });
      console.log(`cpr: 已覆盖 ${unitFile}（旧文件备份到 ${backup}）`);
    }
  } else {
    fs.writeFileSync(unitFile, content, { mode: 0o644 });
    console.log(`cpr: 已写 ${unitFile}`);
  }
  if (DARWIN) {
    console.log('cpr: macOS 路线为 experimental（launchd 未经真机验证，欢迎反馈 doctor 输出）');
  } else {
    const reload = systemctl('daemon-reload');
    if (!reload.ok) console.error(`cpr: daemon-reload 失败：${reload.err}`);
    // linger：让你登出后服务照跑（user unit 默认随会话停）。给自己开 linger 不需要 sudo。
    const linger = loginctl('enable-linger');
    if (!linger.ok) console.error(`cpr: enable-linger 失败（${linger.err}）——服务在你登录期间可用；要登出/重启后仍自跑，需 systemd 允许本用户 linger`);
  }

  // 用户补丁（工单 09）：打在生效的版本目录上（幂等）；打不上拒绝继续。
  // 打上之后再冒烟——冒烟验证的是补丁后的引擎，不是 npm 原样字节。
  const patched = applyUserPatches(engine);
  if (patched.applied.length > 0) console.log(`cpr: 已打用户补丁：${patched.applied.join('、')}`);
  if (patched.skipped.length > 0) console.log(`cpr: 补丁已应用过，幂等跳过：${patched.skipped.join('、')}`);
  if (patched.conflicts.length > 0) {
    console.error(`cpr: 用户补丁打不上当前包：${patched.conflicts.join('、')}——对当前版本文件重新做 diff 更新补丁后再 install；服务未启动。`);
    return 1;
  }

  if (!(await bootSmoke(engine))) {
    console.error('cpr: install 冒烟未通过——先解决再启动（服务未启动、unit 已就位、current 未切换）。');
    return 1;
  }

  // 全部验证过了才切换（review-2 P2：原实现先切后验，失败会把 current 留在未验证的版本上，
  // 下次重启服务就悄悄跑上没验过的代码）。升级路径同纪律：冒烟过门才拨链。
  flipCurrent(selfVersion);
  console.log(`cpr: current → ${selfVersion}`);
  // 命令软链指 current（版本翻转不动它）；~/.local/bin 是免 sudo 唯一默认进 PATH 的位置（XDG 规范原话背书）。
  const binLink = path.join(binDir(), 'cpr');
  fs.mkdirSync(binDir(), { recursive: true });
  const binStat = fs.lstatSync(binLink, { throwIfNoEntry: false });
  if (!binStat) {
    fs.symlinkSync(path.join(appRoot(), 'current', 'bin', 'cpr'), binLink, 'file');
    console.log(`cpr: 已链 ${binLink} → current/bin/cpr`);
  } else if (!binStat.isSymbolicLink() || fs.readlinkSync(binLink) !== path.join(appRoot(), 'current', 'bin', 'cpr')) {
    console.error(`cpr: ${binLink} 已存在且不是本产品软链——不改，请人工确认后重跑。`);
    return 1;
  } else {
    console.log(`cpr: 命令软链 ${binLink} 已就位`);
  }
  if (!binDirOnPath()) {
    console.log(`cpr: 注意：当前 PATH 未含 ${binDir()}——把 export PATH="${binDir()}:$PATH" 写进 ~/.bashrc（或 ~/.zshrc）后重开终端；多数发行版登录后自动带上。`);
  }
  // bootstrap 副本（npx 缓存/npm 全局）只是搬运工：固定位置建成后它就功成身退。
  if (path.resolve(root) !== path.resolve(engine)) {
    console.log(`cpr: 本次运行副本来自 ${root}（npx 缓存或 npm 全局）——固定位置已建立，那份可删（npm rm -g ${PKG}），npx 缓存会自动过期。`);
  }

  if (await confirm('现在启动服务？（y/N）', yes)) {
    const start = serviceStart();
    if (!start.ok) {
      console.error(`cpr: 启动失败：${start.err}（排查：journalctl --user -u ${UNIT_NAME} -n 50）`);
      return 1;
    }
    console.log(`cpr: 已启动。状态：systemctl --user status ${UNIT_NAME}`);
  } else {
    console.log(`cpr: 未启动。之后手动：systemctl --user enable --now ${UNIT_NAME}`);
  }
  console.log('cpr: 推理口/管理口端口以 policy 声明为准（默认 127.0.0.1:8741 / 8740；管理口只绑回环，看板经反代+SSO 暴露，绝不直接开公网）。');
  return 0;
}

// ---- upgrade ----

async function upgrade(yes: boolean, toVersion: string | undefined): Promise<number> {
  const root = pkgRoot();
  if (fs.existsSync(path.join(root, '.git'))) {
    console.error('cpr: 这是 clone（引擎开发者路线）——cpr upgrade 只服务 npm 安装。clone 升级：git pull 后自行验证（node --test + 冒烟）。');
    return 1;
  }
  const current = installedVersion();
  if (!current) {
    console.error('cpr: 固定位置安装尚未建立（current 软链不存在）——先 cpr install。');
    return 1;
  }
  const target = toVersion ? versionId(toVersion) : npmLatest();
  if (!target) die('查不到 npm registry 最新版（网络？）——重试，或用 cpr upgrade --to <版本> 指定目标');
  versionId(target); // registry 来的也过同一道白名单（review-2 P2：版本号参与路径拼接，不可信任到免检）
  if (target === current) {
    console.log(`cpr: 已是最新（${current}）`);
    return 0;
  }
  console.log(`当前 ${current} → 目标 ${target}`);
  if (!(await confirm(`下载 ${BRAND}@${target} 并切换重启？（重启会中断在途请求）`, yes))) {
    console.log('cpr: 未做任何改动。');
    return 0;
  }
  // 下载到独立版本目录（不动 current、不动服务）；已存在（回滚残留/重试）则复用。
  const targetRoot = versionRoot(target);
  if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
    const installNew = npmInstall(target);
    if (!installNew.ok) {
      console.error(`cpr: npm 下载失败：${installNew.err}\ncpr: 未动当前版本，服务未重启。`);
      return 1;
    }
    // Node 拒跑 node_modules 路径下的 .ts（工单 12）——落盘后立刻搬离
    relocateFromNodeModules(target);
    if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
      console.error(`cpr: npm 声称装好但 ${targetRoot} 缺包——prefix 落点异常，中止（current 未动）。`);
      return 1;
    }
    console.log(`cpr: 已下载 ${PKG}@${target} → ${targetRoot}`);
  } else {
    console.log(`cpr: 版本目录已存在（${targetRoot}），复用`);
  }
  // 用户补丁（工单 09）：打在目标版本目录上——版本目录建成后只在这一步补丁化，之后不可变。
  // 打不上 = 升级失败，但 current 未切换、服务未动（连回滚都不需要，没有切换就没有回滚）。
  const patched = applyUserPatches(targetRoot);
  if (patched.applied.length > 0) console.log(`cpr: 已打用户补丁：${patched.applied.join('、')}`);
  if (patched.skipped.length > 0) console.log(`cpr: 补丁已在目录上（复用），跳过：${patched.skipped.join('、')}`);
  if (patched.conflicts.length > 0) {
    console.error(`cpr: 用户补丁与新版本冲突，未打上：${patched.conflicts.join('、')}`);
    console.error('cpr: 修复口径：对补丁目标在新版文件上重新 diff，更新 ~/.llm-cpr/patches/ 后重试（current 未切换，服务未动）。');
    return 1;
  }
  // 切换前冒烟：临时库 + 0 端口，验的是补丁后的新引擎；失败 = current 未切换，服务未动。
  // DB 不由 CLI 备份：引擎启动路径的迁移三件套开库先备份（migrate.ts），单一来源；CLI 只管换代码+重启+健康门。
  if (!(await bootSmoke(targetRoot))) {
    console.error('cpr: 新版冒烟未通过——current 未切换，服务未动。');
    return 1;
  }
  flipCurrent(target);
  console.log(`cpr: current → ${target}`);
  if (await serviceUpAfterRestart()) {
    console.log(`cpr: 完成。${current} → ${target}，服务健康。`);
    pruneVersions(target, current);
    console.log(`cpr: 验证：journalctl --user -u ${UNIT_NAME} 应有启动日志（版本/租户/schema 行）；管理口 /api/route/status 应返回订阅清单。`);
    return 0;
  }
  return await rollbackAfterFailedUpgrade(current, target, '未通过健康检查（systemd is-active 非 active）');
}

// 版本保留策略：当前 + 上一版垫背（回滚零网络的前提），更老的升级成功后顺手清——代码可再生，npm 随时重下。
function pruneVersions(keep: string, alsoKeep: string): void {
  if (!fs.existsSync(versionsDir())) return;
  for (const entry of fs.readdirSync(versionsDir())) {
    if (entry !== keep && entry !== alsoKeep) {
      fs.rmSync(path.join(versionsDir(), entry), { recursive: true, force: true });
      console.log(`cpr: 清理旧版本目录 ${entry}`);
    }
  }
}

// 升级失败回滚（工单 10 新语义）：current 软链拨回去——原子、零网络、瞬时。
// 旧版本目录是「验证过的完整品」（补丁在建成时就打过），拨回去就能跑；回滚不碰数据（加法迁移纪律）。
async function rollbackAfterFailedUpgrade(current: string, target: string, reason: string): Promise<number> {
  console.error(`cpr: 升级失败（${reason}）——把 current 拨回 ${current}（零网络、瞬时）`);
  flipCurrent(current);
  if (await serviceUpAfterRestart()) {
    console.error(`cpr: 已自动退回 ${current}，服务已恢复。失败原因：journalctl --user -u ${UNIT_NAME} -n 50`);
    console.error(`cpr: 解决根因后重试：cpr upgrade --to ${target}`);
    return 1; // 升级失败（尽管服务已恢复）
  }
  console.error(`cpr: 回滚后服务仍未起来——手工口径：journalctl --user -u ${UNIT_NAME} -n 50；确认 ${versionRoot(current)} 完整后 systemctl --user restart ${UNIT_NAME}`);
  return 1;
}

// ---- uninstall ----

async function uninstall(yes: boolean, purge: boolean): Promise<number> {
  // 守卫口径：只有服务确实在跑（is-active 成功）时，才强制要求 disable 成功——
  // 「unit 文件已不存在」的重复卸载/disable 必然报错，但那是合法状态，不该拦住后续清理。
  const activeNow = serviceActive();
  if (activeNow) {
    const stop = DARWIN ? launchctl('bootout', `gui/${uid()}/${DARWIN_LABEL}`) : systemctl('disable', '--now', UNIT_NAME);
    if (!stop.ok) {
      console.error(`cpr: 停止/禁用服务失败：${stop.err}`);
      console.error('cpr: 服务可能仍在运行或 systemd 不可用——为保护正在使用的数据库，拒绝继续卸载。');
      console.error(`  排查后重试；手工口径：systemctl --user disable --now ${UNIT_NAME}`);
      return 1;
    }
    console.log('cpr: 服务已停并移除自启');
  } else {
    console.log(`cpr: 服务未在运行（${DARWIN ? DARWIN_LABEL : UNIT_NAME} 不存在或已停）——直接进入清理`);
    // review-2 P2：inactive ≠ 未启用——unit 可能仍挂在 default.target.wants 里；删 unit 文件前先 disable 清自启链。
    if (!DARWIN && fs.existsSync(unitPath())) {
      const off = systemctl('disable', UNIT_NAME);
      if (off.ok) console.log('cpr: 已 disable（清掉自启链接）');
      else console.log(`cpr: disable 报错（${off.err}）——unit 可能本就未启用，继续`);
    }
  }
  const unitFile = unitPath();
  if (fs.existsSync(unitFile)) {
    fs.rmSync(unitFile);
    if (!DARWIN) systemctl('daemon-reload');
    console.log(`cpr: 已删 ${unitFile}`);
  } else {
    console.log(`cpr: ${unitFile} 不存在`);
  }
  // 命令软链：只删指向自家安装区的（别人的文件不碰）
  const binLink = path.join(binDir(), 'cpr');
  try {
    if (fs.readlinkSync(binLink) === path.join(appRoot(), 'current', 'bin', 'cpr')) {
      fs.rmSync(binLink);
      console.log(`cpr: 已删 ${binLink}`);
    } else {
      console.log(`cpr: ${binLink} 非本产品软链——不动`);
    }
  } catch {
    console.log(`cpr: ${binLink} 不存在——不动`);
  }
  // 代码安装区整体移除（可再生资产）；正在运行的进程不受影响（Linux/macOS 上 inode 保活到进程退出）。
  if (fs.existsSync(appRoot())) {
    fs.rmSync(appRoot(), { recursive: true, force: true });
    console.log(`cpr: 已删代码安装区 ${appRoot()}`);
  } else {
    console.log(`cpr: 代码安装区 ${appRoot()} 不存在`);
  }
  for (const dir of [configDir(), dataDir()]) {
    console.log(`cpr: 保留 ${dir}${fs.existsSync(dir) ? '（数据/密钥原样未动）' : '（不存在）'}`);
  }
  if (purge) {
    if (!(await confirm(`永久删除 ${configDir()} 与 ${dataDir()}？（不可恢复，等于抹掉账本/会话/密钥）`, yes))) {
      console.log('cpr: 未删除。');
      return 0;
    }
    for (const dir of [configDir(), dataDir()]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        console.log(`cpr: 已删 ${dir}`);
      }
    }
  } else {
    console.log('cpr: 数据与密钥未动；确认不要了再手动删，或加 --purge。');
  }
  return 0;
}

// ---- reload（policy 热更新，工单 .scratch/policy-hot-reload/）----

// 判定单源：CLI 不本地 import/validate——daemon 是唯一验真者（两套判定必然漂移）。
// 连不上如实报错退出，不做本地兜底；热区改动忘跑本命令也不出错（daemon 每请求懒检查兜底，
// 本命令只是把结果转成人话 + 冷区变更时代跑重启）。
async function reloadPolicy(yes: boolean): Promise<number> {
  const port = Number(process.env.CPR_ADMIN_PORT) || 8740;
  interface Outcome { kind: string; reason?: string; error?: string; coldChanged?: string[]; toHash?: string }
  let body: { outcome: Outcome; status: { source?: string; sha256?: string | null } } | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/policy/reload`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      // 非 200 ≠ 不可达（review-1 P3-6）：500/503 时 daemon 在跑，报错该指向 daemon 日志。
      console.error(`cpr: 管理口返回 HTTP ${res.status}（127.0.0.1:${port}/api/policy/reload）——daemon 在跑但处理出错，查服务日志。`);
      return 1;
    }
    body = await res.json() as { outcome: Outcome; status: { source?: string; sha256?: string | null } };
  } catch {
    console.error(`cpr: 管理口 127.0.0.1:${port} 不可达——热更新必须由运行中的进程完成，CLI 不做本地兜底判定。`);
    console.error(`  服务没在跑？先查：systemctl --user status ${UNIT_NAME}`);
    return 1;
  }
  const outcome = body!.outcome;
  const source = body!.status.source ?? '~/.llm-cpr/policy.ts';
  if (outcome.kind === 'reloaded') {
    console.log(`cpr: 策略已热更新（sha256 ${(outcome.toHash ?? body!.status.sha256 ?? '').slice(0, 12)}）——下一条请求即用新策略。`);
    return 0;
  }
  if (outcome.kind === 'unchanged') {
    console.log('cpr: 声明文件未变化（或未启用外置 policy.ts，跑的是内置模板），无需重载。');
    return 0;
  }
  // kept = 保旧（Hermes last-known-good 语义：改坏文件绝不让流量变道）
  if (outcome.reason === 'cold-zone-change') {
    console.log('cpr: 声明改了冷区字段（热更新不覆盖，重启才生效）：');
    for (const field of outcome.coldChanged ?? []) console.log(`  - ${field}`);
    if (!(await confirm('是否现在重启服务让全部变更生效？（重启会中断在途请求）', yes))) {
      console.log(`cpr: 未重启。手工口径：systemctl --user restart ${UNIT_NAME}`);
      return 1;
    }
    const restart = serviceRestart();
    if (!restart.ok) {
      console.error(`cpr: 重启失败：${restart.err}`);
      return 1;
    }
    console.log('cpr: 已重启，全部变更生效。');
    return 0;
  }
  console.error(`cpr: 热更新失败，继续用旧策略（${outcome.reason ?? '未知原因'}）——当前流量不受影响：`);
  console.error(`  ${outcome.error ?? outcome.reason}`);
  console.error(`  修好 ${source} 后重跑 cpr reload。`);
  return 1;
}

// ---- 入口 ----

const USAGE = `用法：cpr <doctor|install|upgrade|uninstall|reload> [--yes] [--purge] [--to <版本>]（clone 里：node scripts/cpr.ts …）`;

const [command, ...flags] = process.argv.slice(2);
const yes = flags.includes('--yes');
const purge = flags.includes('--purge');
const toIndex = flags.indexOf('--to');
if (toIndex >= 0 && !flags[toIndex + 1]) die(`--to 需要版本号。${USAGE}`);
const toVersion = toIndex >= 0 ? flags[toIndex + 1] : undefined;
const knownFlags = new Set(['--yes', '--purge', '--to']);
const unknown = flags.filter((f, i) => !knownFlags.has(f) && !(toIndex >= 0 && i === toIndex + 1));
if (unknown.length > 0) die(`未知参数：${unknown.join(' ')}。${USAGE}`);

let exitCode: number;
switch (command) {
  case 'doctor': exitCode = await doctor(); break;
  case 'install': exitCode = await install(yes); break;
  case 'upgrade': exitCode = await upgrade(yes, toVersion); break;
  case 'uninstall': exitCode = await uninstall(yes, purge); break;
  case 'reload': exitCode = await reloadPolicy(yes); break;
  default: die(USAGE);
}
process.exit(exitCode);
