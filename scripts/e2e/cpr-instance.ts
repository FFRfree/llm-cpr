// cpr-instance.ts — e2e 驱动：从 npm pack 产物（仓根自身或其 worktree）启动一个独立 llm-cpr 实例。
// 约束：不 import 仓内代码；不读/写 ~/.llm-cpr；绝不调用 systemctl；
// 所用端口不在 {8740, 8741}（启动前断言）；临时目录落系统 TMPDIR，配置/数据目录由调用方提供。
//
// 配置加载路径已对照 core/paths.ts、core/main.ts、core/policy/contract.ts、policy.example.ts 核实：
//   main.ts 顺序 = 加载 .env（CPR_ENV_FILE 或 CPR_CONFIG_DIR/.env，存在才加载）→
//   import <CPR_CONFIG_DIR>/policy.ts（不存在则退回包内 core/policy/mine.ts）→ validateConfig → startGateway。
//   validateConfig 硬要求：backends[].{name, family:'ocg'|'ccg', base_url, key_env}；models[].{id, backends}。
//   监听端口 = policy.listen / policy.admin（env CPR_FORWARD_PORT / CPR_ADMIN_PORT 可覆盖，本驱动显式剔除）。
//   入口 = 包内 core/main.ts（package.json files 含 core，scripts.start 即 node core/main.ts）。
//   policy.ts 里的 backends[].key_env 指向进程 env 的变量名；本驱动统一给 CPR_MASTER_KEY（自带 .env 免了，
//   直接进程环境注入——main.ts 只在 .env 存在时读它，且只填缺失键）。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** llm-cpr 生产环境占用端口：e2e 绝不允许碰。 */
export const FORBIDDEN_PORTS: readonly number[] = [8740, 8741];

/** 默认模型 id / 会话头 / master key env 名（与 policy.ts、pi-driver 约定一致）。 */
export const E2E_MODEL_ID = 'test-model';
export const E2E_IDENTITY_HEADER = 'x-session-id';
export const E2E_MASTER_KEY = 'e2e-test-key';
export const E2E_MASTER_KEY_ENV = 'CPR_MASTER_KEY';

export interface CprPorts {
  /** 推理口（客户端 chat/completions 进来的口，对应 policy.listen）。 */
  infer: number;
  /** 管理口（仅回环，对应 policy.admin）。 */
  admin: number;
  /** 假上游 A（backend be-a 的 base_url 指向它）。 */
  upstreamA: number;
  /** 假上游 B（backend be-b 的 base_url 指向它）。 */
  upstreamB: number;
}

export interface CprInstanceOptions {
  /** npm pack 源目录（缺省=仓根自身；run-scenarios 的 --worktree 可覆盖）。 */
  repoDir: string;
  ports: CprPorts;
  /** policy.ts 落地处（调用方持有，e2e 归属目录；本函数只写这一个文件）。 */
  configDir: string;
  /** data.db 等数据目录（调用方持有；本函数预建）。 */
  dataDir: string;
  /** 健康轮询上限毫秒（默认 20_000）。 */
  readyTimeoutMs?: number;
  /** stop() 的 SIGTERM 宽限毫秒（默认 8_000）。 */
  stopGraceMs?: number;
}

export interface SupervisorInstanceOptions extends Omit<CprInstanceOptions, 'dataDir'> {
  /** worker/supervisor 的包根（已就位的版本目录布局 <appRoot>/versions/<v>/app）；缺省 = npm pack 解包目录。 */
  workerRoot: string;
  /** 安装区根（current 软链所在；swap 载荷里的 appRoot 用）。 */
  appRoot: string;
  /** data.db 等数据目录（调用方持有；本函数预建）。 */
  dataDir: string;
}

export interface SupervisorInstance {
  pid: number;
  policyPath: string;
  supervisorEntry: string;
  stdout: string;
  stderr: string;
  stop(): Promise<void>;
}

export interface CprInstance {
  pid: number;
  /** 实际加载的 policy 文件路径。 */
  policyPath: string;
  /** 解包后实际运行入口（<tmp>/package/core/main.ts）。 */
  entryPath: string;
  /** 启动与运行期标准输出（含 boot 行，超时诊断用）。 */
  stdout: string;
  /** 启动与运行期标准错误。 */
  stderr: string;
  /** stop() 停法：'sigterm-clean' | 'sigkill-fallback' | 'already-exited'。 */
  get stopDetail(): string;
  /** 优雅停止：SIGTERM → 等 stopGraceMs → SIGKILL；进程退出后才 resolve。 */
  stop(): Promise<void>;
}

export class CprInstanceError extends Error {
  bootOutput: string;
  constructor(message: string, bootOutput = '') {
    super(message);
    this.bootOutput = bootOutput;
  }
}

function assertPortsSafe(ports: CprPorts): void {
  const entries: [string, number][] = [['infer', ports.infer], ['admin', ports.admin], ['upstreamA', ports.upstreamA], ['upstreamB', ports.upstreamB]];
  for (const [name, port] of entries) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CprInstanceError(`ports.${name} 必须是 1-65535 的整数，实际 ${port}`);
    if (FORBIDDEN_PORTS.includes(port)) {
      throw new CprInstanceError(`ports.${name}=${port} 落在生产保留端口 ${FORBIDDEN_PORTS.join('/')}，拒绝启动`);
    }
  }
}

function renderPolicy(ports: CprPorts, nowIso: string): string {
  // 字段名逐一对 core/contracts.ts 的 Backend/Model/Endpoint 与 core/policy/contract.ts 的 RouterPolicy：
  // backends 需要 name/family/base_url/key_env（family 只能 ocg|ccg）；models 需要 id + backends 按家族映射。
  // 不写 import type：类型名经 implements 会触发模块解析，纯声明（运行期鸭子类型经 validateConfig 校验）更稳。
  return `// e2e 自动生成的最小合法声明（cpr-instance.ts @ ${nowIso}）。字段名对齐 core/policy/contract.ts。
export default class E2ePolicy {
  master_key_env = '${E2E_MASTER_KEY_ENV}';
  identity_header = '${E2E_IDENTITY_HEADER}';
  listen = { host: '127.0.0.1', port: ${ports.infer} };
  admin = { host: '127.0.0.1', port: ${ports.admin} };
  routing = { snapshot_interval_ms: 300_000 };

  backends = [
    { name: 'be-a', family: 'ocg' as const, base_url: 'http://127.0.0.1:${ports.upstreamA}/v1', key_env: '${E2E_MASTER_KEY_ENV}', priority: 1 },
    { name: 'be-b', family: 'ccg' as const, base_url: 'http://127.0.0.1:${ports.upstreamB}/v1', key_env: '${E2E_MASTER_KEY_ENV}', priority: 2 },
  ];

  models = [
    { id: '${E2E_MODEL_ID}', backends: { ocg: '${E2E_MODEL_ID}', ccg: '${E2E_MODEL_ID}' } },
  ];

  // 恒 null = 交给内置路由；e2e 只关心透传与端口，不做自定义选路。
  decide() { return null; }
}
`;
}

/**
 * 从 repoDir 跑 npm pack，解到系统 TMPDIR 的临时目录，返回包内容目录（如 <tmp>/package）。
 * 产物 tgz 只含 package.json files 声明的 core/ static/ scripts/ policy.example.ts 等。
 */
async function packAndExtract(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', ['pack', '--json'], { cwd: repoDir, timeout: 120_000, encoding: 'utf8' });
  const parsed = JSON.parse(stdout) as { filename?: string }[];
  const tgzName = parsed[0]?.filename;
  if (!tgzName) throw new CprInstanceError(`npm pack --json 未返回 filename：${stdout.slice(0, 400)}`);
  const tgzPath = path.join(repoDir, tgzName);
  const extractRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cpr-e2e-pack-'));
  await execFileAsync('tar', ['-xzf', tgzPath, '-C', extractRoot], { timeout: 60_000 });
  await fs.promises.rm(tgzPath, { force: true });
  // npm pack 标准产出：单层顶层目录 package/。容错：找不到就找唯一含 core/main.ts 的目录。
  const direct = path.join(extractRoot, 'package', 'core', 'main.ts');
  if (fs.existsSync(direct)) return path.join(extractRoot, 'package');
  const candidates = (await fs.promises.readdir(extractRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => path.join(extractRoot, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'core', 'main.ts')));
  if (candidates.length !== 1) throw new CprInstanceError(`解包后找不到唯一含 core/main.ts 的目录（candidates=${candidates.length}）`);
  return candidates[0];
}

/** 校验包内容：files 字段含 core，入口文件真实存在。 */
function assertPackageLayout(pkgDir: string): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { files?: string[]; version?: string; name?: string };
  if (!Array.isArray(pkg.files) || !pkg.files.includes('core')) {
    throw new CprInstanceError(`包 package.json files 缺 core：${JSON.stringify(pkg.files)}`);
  }
  if (!fs.existsSync(path.join(pkgDir, 'core', 'main.ts'))) throw new CprInstanceError('包内缺 core/main.ts，无法启动');
}

/** 写 policy.ts（调用方 configDir 必须在 e2e 批次目录或 TMPDIR 下——不在 ~/.llm-cpr）。 */
async function writePolicy(configDir: string, ports: CprPorts): Promise<string> {
  const resolved = path.resolve(configDir);
  if (resolved === path.join(os.homedir(), '.llm-cpr')) {
    throw new CprInstanceError(`configDir 不能是 ~/.llm-cpr：${resolved}`);
  }
  await fs.promises.mkdir(resolved, { recursive: true });
  const policyPath = path.join(resolved, 'policy.ts');
  await fs.promises.writeFile(policyPath, renderPolicy(ports, new Date().toISOString()), 'utf8');
  return policyPath;
}

/** 启动一个独立 llm-cpr 实例。健康判定：管理口 GET /api/route/status（纯本地）到 200。 */
export async function startCprInstance(options: CprInstanceOptions): Promise<CprInstance> {
  const { repoDir, ports, configDir, dataDir } = options;
  assertPortsSafe(ports);

  const pkgDir = await packAndExtract(repoDir);
  assertPackageLayout(pkgDir);
  const entryPath = path.join(pkgDir, 'core', 'main.ts');
  const policyPath = await writePolicy(configDir, ports);
  await fs.promises.mkdir(dataDir, { recursive: true });

  // 环境垫：CPR_CONFIG_DIR/CPR_DATA_DIR 接缝（core/paths.ts），CPR_MASTER_KEY 鉴权值，
  // CPR_UNIT_NAME 万一内部走 systemctl 也只指向不存在的 unit。端口/env 源一律剔除，防外部泄漏。
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CPR_FORWARD_PORT', 'CPR_ADMIN_PORT', 'CPR_ENV_FILE', 'CPR_NPM_SOURCE', 'CPR_MASTER_KEY']) delete env[key];
  env.CPR_CONFIG_DIR = path.resolve(configDir);
  env.CPR_DATA_DIR = path.resolve(dataDir);
  env.CPR_MASTER_KEY = E2E_MASTER_KEY;
  env.CPR_UNIT_NAME = 'e2e-cpr-test.service';

  const child = spawn(process.execPath, [entryPath], { cwd: pkgDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let alive = true;
  let stopDetail = '';
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
  child.once('exit', () => { alive = false; });
  const exitedUnexpectedly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => reject(new CprInstanceError(`llm-cpr 提前退出（code=${code} signal=${signal}）`)));
  });

  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const pollOnce = async (): Promise<boolean> => {
    for (const pathname of ['/api/route/status', '/api/version']) {
      try {
        const res = await fetch(`http://127.0.0.1:${ports.admin}${pathname}`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) return true;
      } catch { /* 端口未就绪或该端点慢；下一个候选继续 */ }
    }
    return false;
  };
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await Promise.race([pollOnce(), exitedUnexpectedly.then(() => false)]);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    void child.kill('SIGKILL');
    throw new CprInstanceError(`llm-cpr ${readyTimeoutMs}ms 内未就绪（管理口 ${ports.admin} 无 200）`, stdoutBuf + stderrBuf);
  }

  return {
    pid: child.pid!,
    policyPath,
    entryPath,
    get stdout() { return stdoutBuf; },
    get stderr() { return stderrBuf; },
    async stop(): Promise<void> {
      if (!alive) { stopDetail = 'already-exited'; return; }
      const grace = options.stopGraceMs ?? 8_000;
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        new Promise<boolean>((resolve) => { child.once('exit', () => resolve(true)); setTimeout(() => resolve(alive ? false : true), grace); }),
      ]);
      stopDetail = stopped ? 'sigterm-clean' : 'sigkill-fallback';
      if (!stopped && alive) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3_000); });
        stopDetail = 'sigkill-fallback';
      }
      alive = false;
    },
    get stopDetail() { return stopDetail; },
  };
}

/**
 * supervisor 形态实例（supervisor-upgrade 票 04）：spawn <workerRoot>/core/supervisor.ts（e2e 的
 * PID 红线主体——supervisor PID 全程不变，worker PID 必随 swap 变化）。workerRoot 必须已是
 * versions/<v>/app 布局（swap 编排按它翻 current 软链）；本函数只写 policy.ts + 预建 dataDir。
 * 健康判定与 startCprInstance 同口径：管理口 /api/version 或 /api/route/status 到 200。
 */
export async function startSupervisorInstance(options: SupervisorInstanceOptions): Promise<SupervisorInstance> {
  const { repoDir, ports, configDir, dataDir, workerRoot, appRoot } = options;
  assertPortsSafe(ports);
  void repoDir; // pack 源由调用方消化成 workerRoot（版本目录布局）；这里只需要 ports/config/data
  const supervisorEntry = path.join(workerRoot, 'core', 'supervisor.ts');
  if (!fs.existsSync(supervisorEntry)) throw new CprInstanceError(`workerRoot 缺 core/supervisor.ts：${workerRoot}`);
  const policyPath = await writePolicy(configDir, ports);
  await fs.promises.mkdir(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CPR_FORWARD_PORT', 'CPR_ADMIN_PORT', 'CPR_ENV_FILE', 'CPR_NPM_SOURCE', 'CPR_MASTER_KEY']) delete env[key];
  env.CPR_CONFIG_DIR = path.resolve(configDir);
  env.CPR_DATA_DIR = path.resolve(dataDir);
  env.CPR_DB_FILE = path.join(path.resolve(dataDir), 'data.db');
  env.CPR_MASTER_KEY = E2E_MASTER_KEY;
  env.CPR_UNIT_NAME = 'e2e-cpr-test.service';
  env.CPR_APP_ROOT = path.resolve(appRoot);
  // /api/version 会现查 npm registry（缓存 1h）：钉到本地死口，测试不依赖真实 registry 的偶发慢。
  env.CPR_REGISTRY_URL = 'http://127.0.0.1:9';

  const child = spawn(process.execPath, [supervisorEntry], { cwd: workerRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let alive = true;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
  child.once('exit', () => { alive = false; });

  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const pollOnce = async (): Promise<boolean> => {
    for (const pathname of ['/api/version', '/api/route/status']) {
      try {
        const res = await fetch(`http://127.0.0.1:${ports.admin}${pathname}`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) return true;
      } catch { /* 未就绪 */ }
    }
    return false;
  };
  const exitedUnexpectedly = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => reject(new CprInstanceError(`supervisor 提前退出（code=${code} signal=${signal}）`, stdoutBuf + stderrBuf)));
  });
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await Promise.race([pollOnce(), exitedUnexpectedly.then(() => false)]);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    void child.kill('SIGKILL');
    throw new CprInstanceError(`supervisor ${readyTimeoutMs}ms 内未就绪（管理口 ${ports.admin} 无 200）`, stdoutBuf + stderrBuf);
  }

  return {
    pid: child.pid!,
    policyPath,
    supervisorEntry,
    get stdout() { return stdoutBuf; },
    get stderr() { return stderrBuf; },
    async stop(): Promise<void> {
      if (!alive) return;
      const grace = options.stopGraceMs ?? 8_000;
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        new Promise<boolean>((resolve) => { child.once('exit', () => resolve(true)); setTimeout(() => resolve(alive ? false : true), grace); }),
      ]);
      if (!stopped && alive) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3_000); });
      }
      alive = false;
    },
  };
}
