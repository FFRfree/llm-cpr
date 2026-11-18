#!/usr/bin/env node
// scripts/cpr.ts — coding-plan-router 用户侧 doctor / install / upgrade / uninstall。
// 约定：在 clone 根目录里运行；操作对象 = process.cwd()（与脚本文件位置无关）。
// 安全边界：脚本永不 stash / commit / discard 用户的改动；脏跟踪文件一律拒绝升级；
//   systemd 重启只在用户确认（y / --yes）后执行；uninstall 永不删数据库与 clone 目录。
// 测试接缝（未设置 = 生产行为，测试经临时目录 + stub 全隔离）：
//   CPR_SYSTEMCTL   systemctl 可执行文件路径（stub 把 argv 记到 CPR_SYSTEMCTL_LOG）
//   CPR_UNIT_DIR    unit 写入目录，默认 /etc/systemd/system
//   CPR_CONFIG_DIR  .env 目录，默认 ~/.config/coding-plan-router
//   CPR_DATA_DIR    数据目录，默认 ~/.local/share/coding-plan-router
//   CPR_TEST_CMD    检查命令（sh -c，在仓根执行），默认 node --test
//   CPR_SMOKE_CMD   冒烟命令（sh -c，在仓根执行），默认 = git archive 快照 + smoke-release.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

const BRAND = 'coding-plan-router';
const UNIT_NAME = 'coding-plan-router.service';

interface RunResult { ok: boolean; out: string; err: string }

function git(args: readonly string[], cwd: string, { raw = false }: { raw?: boolean } = {}): RunResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  // raw=true 保留行首空白：porcelain 的状态列（如 " M"）以空格开头，trim 会吞掉路径首字符。
  const out = r.stdout ?? '';
  return { ok: r.status === 0, out: raw ? out.replace(/\n$/, '') : out.trim(), err: (r.stderr ?? '').trim() };
}

function sh(command: string, cwd: string): RunResult {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function die(message: string): never {
  console.error(`cpr: ${message}`);
  process.exit(1);
}

function repoRoot(): string {
  const probe = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!probe.ok) die('当前目录不是 git 仓库——请在 coding-plan-router 的 clone 根目录里运行');
  const root = probe.out;
  if (!fs.existsSync(path.join(root, 'lib', 'main.ts')) || !fs.existsSync(path.join(root, 'package.json'))) {
    die('当前仓库不是 coding-plan-router（缺 lib/main.ts / package.json）');
  }
  return root;
}

// ---- 测试接缝 ----

const unitDir = (): string => process.env.CPR_UNIT_DIR || '/etc/systemd/system';
const configDir = (): string => process.env.CPR_CONFIG_DIR || path.join(os.homedir(), '.config', BRAND);
const dataDir = (): string => process.env.CPR_DATA_DIR || path.join(os.homedir(), '.local/share', BRAND);
const testCmd = (): string => process.env.CPR_TEST_CMD || 'node --test';

function systemctl(...args: readonly string[]): RunResult {
  const bin = process.env.CPR_SYSTEMCTL || 'systemctl';
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// ---- 仓库状态盘点（只读） ----

interface RepoState {
  root: string;
  head: string;
  branch: string | null; // null = detached HEAD
  upstream: string | null; // 如 origin/master
  latestTag: string | null;
  fetched: boolean;
  behind: number;
  ahead: number;
  aheadCommits: string[];
  dirty: string[]; // 被跟踪文件的未提交改动
  untracked: string[];
}

function upstreamOf(state: { branch: string | null }, root: string): string | null {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (head.ok && head.out) return head.out;
  for (const candidate of ['origin/' + (state.branch ?? ''), 'origin/master', 'origin/main']) {
    if (candidate === 'origin/' || candidate === 'origin/null') continue;
    if (git(['rev-parse', '--verify', '--quiet', candidate], root).ok) return candidate;
  }
  return null;
}

function collectState(root: string, fetch: boolean): RepoState {
  let fetched = false;
  if (fetch && git(['remote'], root).out.split('\n').includes('origin')) {
    fetched = git(['fetch', '--tags', 'origin'], root).ok;
  }
  const head = git(['rev-parse', '--short', 'HEAD'], root).out || 'unknown';
  const branchLine = git(['symbolic-ref', '--short', 'HEAD'], root);
  const branch = branchLine.ok ? branchLine.out : null;
  const tagList = git(['for-each-ref', 'refs/tags', '--sort=-creatordate', '--format=%(refname:short)'], root).out;
  const latestTag = tagList ? tagList.split('\n')[0] : null;
  const state: RepoState = {
    root, head, branch, latestTag, fetched,
    upstream: null, behind: 0, ahead: 0, aheadCommits: [], dirty: [], untracked: [],
  };
  if (fetched) {
    state.upstream = upstreamOf(state, root);
    if (state.upstream) {
      const behind = git(['rev-list', '--count', `HEAD..${state.upstream}`], root);
      const ahead = git(['rev-list', '--count', `${state.upstream}..HEAD`], root);
      state.behind = behind.ok ? Number(behind.out) || 0 : 0;
      state.ahead = ahead.ok ? Number(ahead.out) || 0 : 0;
      if (state.ahead > 0) state.aheadCommits = git(['log', '--oneline', `${state.upstream}..HEAD`], root).out.split('\n');
    }
  }
  const porcelain = git(['status', '--porcelain'], root, { raw: true }).out.split('\n').filter(Boolean);
  for (const line of porcelain) {
    if (line.startsWith('??')) state.untracked.push(line.slice(3));
    else state.dirty.push(line.slice(3));
  }
  return state;
}

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

// ---- 检查：测试 + 冒烟（假上游，不碰真实订阅额度） ----

function runChecks(root: string, { smoke = true }: { smoke?: boolean } = {}): boolean {
  console.log(`cpr: 跑测试（${testCmd()}）...`);
  const tests = sh(testCmd(), root);
  if (!tests.ok) {
    console.error(`cpr: 测试未通过：\n${tests.out}\n${tests.err}`);
    return false;
  }
  if (!smoke) return true;
  if (process.env.CPR_SMOKE_CMD) {
    const smokeRun = sh(process.env.CPR_SMOKE_CMD, root);
    if (!smokeRun.ok) {
      console.error(`cpr: 冒烟未通过：\n${smokeRun.out}\n${smokeRun.err}`);
      return false;
    }
    return true;
  }
  // 默认冒烟 = 当前 HEAD 的运行快照（git archive）+ 假上游冒烟，与发布纪律同一条验收线。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-upgrade-smoke-'));
  const tarball = path.join(dir, 'snapshot.tar');
  const archive = git(['archive', '--format=tar', '--output', tarball, 'HEAD', 'lib', 'static', 'package.json'], root);
  if (!archive.ok) {
    console.error(`cpr: 冒烟快照打包失败：${archive.err}`);
    return false;
  }
  const extract = spawnSync('tar', ['-xf', tarball, '-C', dir], { encoding: 'utf8' });
  if (extract.status !== 0) {
    console.error(`cpr: 冒烟快照解包失败：${extract.stderr ?? ''}`);
    return false;
  }
  const smokeRun = spawnSync(process.execPath, [path.join(root, 'scripts', 'xdg-deploy', 'smoke-release.ts'), dir], { cwd: root, encoding: 'utf8' });
  if (smokeRun.status !== 0) {
    console.error(`cpr: 冒烟未通过：\n${smokeRun.stdout ?? ''}\n${smokeRun.stderr ?? ''}`);
    return false;
  }
  return true;
}

// ---- doctor ----

async function doctor(): Promise<number> {
  const root = repoRoot();
  const node = nodeRequirement(root);
  const state = collectState(root, true);
  console.log(`NODE=${node.have}${node.ok ? ' OK' : ` 不满足（要求 ${node.want}）`}`);
  console.log(`REPO=${root}`);
  console.log(`BRANCH=${state.branch ?? `detached@${state.head}`}`);
  console.log(`HEAD=${state.head}`);
  console.log(`TAG=${state.latestTag ?? 'none'}`);
  console.log(`FETCHED=${state.fetched ? 1 : 0}${state.fetched ? '' : '（无法与 origin 同步，以下落后数字不可信）'}`);
  console.log('NOTE=会执行 git fetch --tags（更新本地远端引用与 tag，不改工作树）');
  console.log(`UPSTREAM=${state.upstream ?? 'none'}`);
  console.log(`BEHIND=${state.behind}`);
  console.log(`AHEAD=${state.ahead}`);
  for (const c of state.aheadCommits) console.log(`AHEAD_COMMIT=${c}`);
  console.log(`DIRTY=${state.dirty.length ? state.dirty.join(' ') : 'none'}`);
  console.log(`UNTRACKED=${state.untracked.length ? state.untracked.join(' ') : 'none'}`);
  console.log('--- 建议 ---');
  if (state.dirty.length > 0) {
    console.log('NEXT=拒绝升级：先处理脏跟踪文件（git commit / git stash / git checkout -- <file>，自己动手）');
  } else if (state.behind === 0) {
    console.log('NEXT=已是最新');
  } else if (state.ahead > 0) {
    console.log(`NEXT=fork 路线：git rebase ${state.upstream}；升级后必须 node --test 全量`);
  } else {
    console.log(`NEXT=git merge --ff-only ${state.upstream}（或直接跑 node scripts/cpr.ts upgrade）`);
  }
  return 0;
}

// ---- install ----

function unitFileContent(root: string): string {
  const config = configDir();
  const data = dataDir();
  return `[Unit]
Description=Coding Plan Router — LLM 订阅路由网关
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} lib/main.ts
EnvironmentFile=${config}/.env
Environment=CPR_SESSIONS_DB=${data}/sessions.db
Environment=CPR_USAGE_DB=${data}/usage.db
Restart=on_failure_placeholder
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=${data}

[Install]
WantedBy=multi-user.target
`.replace('Restart=on_failure_placeholder', 'Restart=on-failure');
}

async function install(yes: boolean): Promise<number> {
  const root = repoRoot();
  const node = nodeRequirement(root);
  if (!node.ok) die(`Node ${node.have} 不满足本仓要求 ${node.want}——先升级 Node 再安装`);
  console.log(`cpr: Node ${node.have} ✓`);

  const example = path.join(root, 'policy.example.ts');
  const local = path.join(root, 'policy.local.ts');
  if (!fs.existsSync(example)) die('仓库缺 policy.example.ts——clone 不完整，重新克隆');
  if (fs.existsSync(local)) console.log('cpr: policy.local.ts 已存在，保留现状');
  else {
    fs.copyFileSync(example, local);
    console.log('cpr: 已从模板创建 policy.local.ts——订阅声明在里面改（name 定了绝不改）');
  }

  const envFile = path.join(configDir(), '.env');
  fs.mkdirSync(configDir(), { recursive: true });
  if (fs.existsSync(envFile)) console.log(`cpr: ${envFile} 已存在，保留现状`);
  else {
    const exampleEnv = path.join(root, '.env.example');
    const base = fs.existsSync(exampleEnv) ? fs.readFileSync(exampleEnv, 'utf8') : `${'CPR_MASTER_KEY='}${'***'}${''}\n`;
    const masterKey = crypto.randomBytes(24).toString('hex');
    const text = base.replace(/^CPR_MASTER_KEY=.*$/m, `CPR_MASTER_KEY=${masterKey}`);
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    console.log(`cpr: 已生成 ${envFile}（已随机生成 CPR_MASTER_KEY；订阅 key 按 policy.local.ts 的 key_env 名补齐）`);
  }

  // 数据目录必须先建：node:sqlite 打开库文件不会自动创建父目录，缺目录首次启动直接失败。
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  console.log(`cpr: 数据目录 ${dataDir()} ✓`);

  const unitPath = path.join(unitDir(), UNIT_NAME);
  const content = unitFileContent(root);
  fs.mkdirSync(unitDir(), { recursive: true });
  if (fs.existsSync(unitPath)) {
    if (fs.readFileSync(unitPath, 'utf8') === content) console.log(`cpr: ${unitPath} 内容一致，跳过`);
    else {
      if (!(await confirm(`${unitPath} 已存在且内容不同，覆盖？`, yes))) {
        console.log('cpr: 未写 unit；请人工比对后重跑（旧文件不会被本命令改动）。');
        return 1;
      }
      const backup = `${unitPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(unitPath, backup);
      fs.writeFileSync(unitPath, content, { mode: 0o644 });
      console.log(`cpr: 已覆盖 ${unitPath}（旧文件备份到 ${backup}）`);
    }
  } else {
    fs.writeFileSync(unitPath, content, { mode: 0o644 });
    console.log(`cpr: 已写 ${unitPath}`);
  }
  const reload = systemctl('daemon-reload');
  if (!reload.ok) console.error(`cpr: daemon-reload 失败：${reload.err}`);

  console.log('cpr: 跑测试...');
  if (!runChecks(root, { smoke: false })) {
    console.error('cpr: 测试未通过——先解决再安装。');
    return 1;
  }

  if (await confirm('现在启动服务？（y/N）', yes)) {
    const start = systemctl('enable', '--now', UNIT_NAME);
    if (!start.ok) {
      console.error(`cpr: 启动失败：${start.err}（排查：journalctl -u ${UNIT_NAME} -n 50）`);
      return 1;
    }
    console.log(`cpr: 已启动。状态：systemctl status ${UNIT_NAME}`);
  } else {
    console.log(`cpr: 未启动。之后手动：systemctl enable --now ${UNIT_NAME}`);
  }
  console.log('cpr: 推理口 127.0.0.1:8741（鉴权 key = .env 的 CPR_MASTER_KEY）；管理口 127.0.0.1:8740（只绑回环，看板经反代+SSO 暴露，绝不直接开公网）。');
  return 0;
}

// ---- upgrade ----

async function upgrade(yes: boolean): Promise<number> {
  const root = repoRoot();
  const state = collectState(root, true);
  if (!state.fetched) die('无法与 origin 同步（fetch 失败）——检查网络/远端后重试，升级拒绝在未知版本状态上进行');
  if (!state.upstream) die('找不到 origin 上的基线分支（origin/HEAD 或 origin/master|main）——先推送或核对远端');
  if (state.dirty.length > 0) {
    console.error('cpr: 升级拒绝——存在未提交的被跟踪文件改动：');
    for (const f of state.dirty) console.error(`  ${f}`);
    console.error('  三条出路（自己动手，脚本不代做）：git commit ｜ git stash ｜ git checkout -- <file>');
    return 1;
  }
  if (state.behind === 0) {
    console.log(`cpr: 已是最新（${state.head}${state.ahead > 0 ? `，领先 origin ${state.ahead} 个 commit` : ''}）`);
    return 0;
  }

  const oldHead = state.head;
  let rebased = false;
  if (state.ahead > 0) {
    console.log(`cpr: 你领先 ${state.upstream} ${state.ahead} 个 commit：`);
    for (const c of state.aheadCommits) console.log(`  ${c}`);
    if (!(await confirm('尝试 rebase 到新版本？', yes))) {
      console.log('cpr: 未做任何改动。手工路线：git rebase ' + state.upstream + '，解决后跑 node scripts/cpr.ts upgrade。');
      return 0;
    }
    const rebase = git(['rebase', state.upstream], root);
    if (!rebase.ok) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'], root).out;
      git(['rebase', '--abort'], root);
      console.error('cpr: rebase 撞冲突，已 abort 原地恢复（工作树回到升级前）。冲突文件：');
      for (const f of conflicts.split('\n').filter(Boolean)) console.error(`  ${f}`);
      console.error('  手工路线：git rebase ' + state.upstream + '，解冲突（注意丢弃 stash 来的旧副本）后跑 node --test 全量。');
      return 1;
    }
    rebased = true;
  } else if (state.branch === null) {
    const target = state.latestTag ?? state.upstream;
    const checkout = git(['checkout', target], root);
    if (!checkout.ok) die(`checkout ${target} 失败：${checkout.err}`);
  } else {
    const merge = git(['merge', '--ff-only', state.upstream], root);
    if (!merge.ok) die(`fast-forward 失败（分支 ${state.branch} 不可快进）：${merge.err}`);
  }

  const newHead = git(['rev-parse', '--short', 'HEAD'], root).out || 'unknown';
  console.log(`cpr: 代码已到 ${newHead}${rebased ? '（本地 commit 已重放到新基线上）' : ''}`);
  if (!runChecks(root)) {
    console.error('cpr: 升级后检查未通过。回滚命令：');
    console.error(state.branch === null ? `  git checkout ${oldHead}` : `  git reset --hard ${oldHead}`);
    return 1;
  }
  if (await confirm('重启 coding-plan-router 服务？（y/N）', yes)) {
    const restart = systemctl('restart', UNIT_NAME);
    if (!restart.ok) {
      console.error(`cpr: 重启失败：${restart.err}（排查：journalctl -u ${UNIT_NAME} -n 50）`);
      return 1;
    }
    console.log('cpr: 已重启。验证：启动日志应有当前 commit；curl -s http://127.0.0.1:8740/api/route/status 应返回订阅列表。');
  } else {
    console.log('cpr: 未重启。改动在下次重启生效：systemctl restart ' + UNIT_NAME);
  }
  return 0;
}

// ---- uninstall ----

async function uninstall(yes: boolean, purge: boolean): Promise<number> {
  const stop = systemctl('disable', '--now', UNIT_NAME);
  if (!stop.ok) {
    console.error(`cpr: 停止/禁用服务失败：${stop.err}`);
    console.error('cpr: 服务可能仍在运行或 systemd 不可用——为保护正在使用的数据库，拒绝继续卸载。');
    console.error(`  排查后重试；手工口径：systemctl disable --now ${UNIT_NAME}`);
    return 1;
  }
  console.log('cpr: 服务已停并移除自启');
  const unitPath = path.join(unitDir(), UNIT_NAME);
  if (fs.existsSync(unitPath)) {
    fs.rmSync(unitPath);
    systemctl('daemon-reload');
    console.log(`cpr: 已删 ${unitPath}`);
  } else {
    console.log(`cpr: ${unitPath} 不存在`);
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
  console.log('cpr: 源码是 git clone，目录脚本不删——不要了就自己删。');
  return 0;
}

// ---- 入口 ----

const USAGE = '用法：node scripts/cpr.ts <doctor|install|upgrade|uninstall> [--yes] [--purge]';

const [command, ...flags] = process.argv.slice(2);
const yes = flags.includes('--yes');
const purge = flags.includes('--purge');
const unknown = flags.filter((f) => f !== '--yes' && f !== '--purge');
if (unknown.length > 0) die(`未知参数：${unknown.join(' ')}。${USAGE}`);

let exitCode: number;
switch (command) {
  case 'doctor': exitCode = await doctor(); break;
  case 'install': exitCode = await install(yes); break;
  case 'upgrade': exitCode = await upgrade(yes); break;
  case 'uninstall': exitCode = await uninstall(yes, purge); break;
  default: die(USAGE);
}
process.exit(exitCode);
