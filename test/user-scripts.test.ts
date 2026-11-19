// scripts/cpr.ts（doctor/install/upgrade/uninstall）+ main.ts policy 加载的用户侧验收。
// 全部经临时 fixture git 仓 + 注入式 systemctl/测试命令运行，绝不触碰本机生产服务与真实 unit。
// 隔离口径见 .scratch/user-scripts/issues/06-test-harness.md。
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
const SCRIPT = path.join(REPO, 'scripts', 'cpr.ts');
const UNIT = 'llm-cpr.service';

type Env = Record<string, string>;

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message]);
}

interface Fixture { base: string; work: string; origin: string; env: Env }

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-user-scripts-'));
  const work = path.join(base, 'work');
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(work);
  fs.cpSync(path.join(REPO, 'scripts'), path.join(work, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'package.json'), path.join(work, 'package.json'));
  fs.cpSync(path.join(REPO, '.env.example'), path.join(work, '.env.example'));
  fs.mkdirSync(path.join(work, 'core', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(work, 'core', 'main.ts'), '// fixture stub\n');
  fs.writeFileSync(path.join(work, 'policy.example.ts'), '// fixture 模板\n');
  git(work, ['init', '-b', 'master']);
  commitAll(work, 'init');
  const bare = spawnSync('git', ['clone', '--bare', work, origin], { encoding: 'utf8' });
  assert.equal(bare.status, 0, bare.stderr);
  git(work, ['remote', 'add', 'origin', origin]);

  const stub = path.join(base, 'systemctl-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CPR_SYSTEMCTL_LOG"\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  const env: Env = {
    // 接缝全集显式钉死：父进程若带着 CPR_*（如 e2e 的 CPR_UNIT_NAME）进来会污染 fixture 断言。
    CPR_UNIT_NAME: UNIT,
    CPR_SYSTEMCTL: stub,
    CPR_SYSTEMCTL_LOG: path.join(base, 'systemctl.log'),
    CPR_UNIT_DIR: path.join(base, 'unit'),
    CPR_CONFIG_DIR: path.join(base, 'config'),
    CPR_DATA_DIR: path.join(base, 'data'),
    CPR_TEST_CMD: 'node -e ""',
    CPR_SMOKE_CMD: 'true',
  };
  return { base, work, origin, env };
}

function cpr(work: string, args: string[], env: Env): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function systemctlLog(fixture: Fixture): string[] {
  const file = fixture.env.CPR_SYSTEMCTL_LOG;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// 上游推进：从 origin 克隆一个工作副本，按需改文件，提交并推回。
function upstreamCommit(fixture: Fixture, edit: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-us-upstream-'));
  const clone = spawnSync('git', ['clone', fixture.origin, dir], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'user.email', 't@t']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'user.name', 't']);
  edit(dir);
  commitAll(dir, 'upstream change');
  const push = spawnSync('git', ['-C', dir, 'push', 'origin', 'master'], { encoding: 'utf8' });
  assert.equal(push.status, 0, push.stderr);
}

const upstreamAddFile = (fixture: Fixture): void =>
  upstreamCommit(fixture, (dir) => { fs.writeFileSync(path.join(dir, 'core', 'extra.ts'), '// upstream new\n'); });

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

test('doctor：干净仓报告 BEHIND/AHEAD/DIRTY 结论行', () => {
  const f = makeFixture();
  const r = cpr(f.work, ['doctor'], f.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FETCHED=1/);
  assert.match(r.stdout, /BEHIND=0/);
  assert.match(r.stdout, /AHEAD=0/);
  assert.match(r.stdout, /DIRTY=none/);
  assert.match(r.stdout, /NEXT=已是最新/);
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
  assert.ok(calls.includes('daemon-reload'));
  assert.ok(calls.includes(`enable --now ${UNIT}`));
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

test('upgrade：干净落后 → ff-only 前进，默认不重启', () => {
  const f = makeFixture();
  upstreamAddFile(f);
  const r = cpr(f.work, ['upgrade'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(f.work, ['rev-parse', '--short', 'HEAD']), git(f.work, ['rev-parse', '--short', 'origin/master']));
  assert.match(r.stdout, /代码已到/);
  assert.ok(!systemctlLog(f).some((line) => line.startsWith('restart')));
});

test('upgrade --yes：ff-only 后重启一次', () => {
  const f = makeFixture();
  upstreamAddFile(f);
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(systemctlLog(f).filter((line) => line.startsWith('restart')), [`restart ${UNIT}`]);
});

test('upgrade --yes：分叉（落后+领先）→ rebase 重放本地 commit', () => {
  const f = makeFixture();
  upstreamAddFile(f);
  fs.writeFileSync(path.join(f.work, 'core', 'mine-extra.ts'), '// mine\n');
  commitAll(f.work, 'mine change');
  git(f.work, ['fetch', 'origin']);
  assert.equal(Number(git(f.work, ['rev-list', '--count', 'HEAD..origin/master'])), 1);
  assert.equal(Number(git(f.work, ['rev-list', '--count', 'origin/master..HEAD'])), 1);

  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // rebase 后 HEAD 是重放出的新 commit（SHA ≠ origin/master）；断言祖先关系 + 双方内容都在。
  assert.equal(git(f.work, ['rev-list', '--count', 'HEAD..origin/master']), '0');
  assert.equal(git(f.work, ['rev-list', '--count', 'origin/master..HEAD']), '1');
  assert.ok(fs.existsSync(path.join(f.work, 'core', 'mine-extra.ts'))); // 本地 commit 重放成功
  assert.ok(fs.existsSync(path.join(f.work, 'core', 'extra.ts'))); // 上游 commit 也在
});

test('upgrade：rebase 撞冲突 → abort 原地还原、退出非零', () => {
  const f = makeFixture();
  const mainFile = path.join(f.work, 'core', 'main.ts');
  // 上游把同一行改成 UPSTREAM，本地改成 LOCAL——rebase 必撞
  upstreamCommit(f, (dir) => { fs.writeFileSync(path.join(dir, 'core', 'main.ts'), '// UPSTREAM\n'); });
  fs.writeFileSync(mainFile, '// LOCAL\n');
  commitAll(f.work, 'local change');
  const headBefore = git(f.work, ['rev-parse', 'HEAD']);
  const contentBefore = fs.readFileSync(mainFile, 'utf8');

  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /abort 原地恢复/);
  assert.match(r.stderr, /core\/main\.ts/);
  assert.equal(git(f.work, ['rev-parse', 'HEAD']), headBefore); // HEAD 未动
  assert.equal(fs.readFileSync(mainFile, 'utf8'), contentBefore); // 工作树逐字节还原
  assert.equal(git(f.work, ['status', '--porcelain']).trim(), ''); // 干净如初
  assert.ok(!fs.existsSync(path.join(f.work, '.git', 'rebase-merge')));
  assert.ok(!fs.existsSync(path.join(f.work, '.git', 'rebase-apply')));
});

test('upgrade：脏跟踪文件无条件拒绝且零副作用', () => {
  const f = makeFixture();
  upstreamAddFile(f);
  fs.writeFileSync(path.join(f.work, 'core', 'main.ts'), '// 半成品改动\n');
  const r = cpr(f.work, ['upgrade', '--yes'], f.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /core\/main\.ts/);
  assert.match(r.stderr, /git commit/); // 三条出路提示
  assert.deepEqual(systemctlLog(f), []); // 没有任何 systemd 动作
  assert.match(fs.readFileSync(path.join(f.work, 'core', 'main.ts'), 'utf8'), /半成品/); // 改动原样保留
});

// ---- uninstall ----

test('uninstall：停服务失败 → 拒绝继续，unit 与数据原样保留', () => {
  const f = makeFixture();
  const failStub = path.join(f.base, 'systemctl-fail.sh');
  // 服务在跑（is-active 成功）但 disable 失败——正好卡进新守卫的拒绝分支
  fs.writeFileSync(failStub, '#!/bin/sh\ncase "$1" in disable) exit 1;; esac\nexit 0\n');
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
  assert.ok(systemctlLog(f).includes(`disable --now ${UNIT}`));
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
