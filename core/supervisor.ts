#!/usr/bin/env node
// core/supervisor.ts — 常驻外壳（supervisor-upgrade spec）：持有两监听 socket 终生不放（端口不空窗的全部
// 秘密——fd 交接而非重启后重 bind），派生 worker（core/main.ts --worker）并交接 handle，等 `ready`
// （pm2 wait_ready 同义）后进入就绪态。
//
// 为什么 bind 后不接受连接：net._createServerHandle 只 bind 不 listen（Node 自家 cluster SharedHandle
// 同款用法，lib/net.js createServerHandle 无 handle.listen）——没有 uv poll 就没有 accept，连接全部留在
// 内核 backlog 里等 worker 的 dup fd 上 `listen()` 后取走。给 net.Server 挂 onconnection=null 的路子实测
// 会丢连接（uv__server_io 先 accept 再发现回调为空、close accepted fd），不可用。
//
// 换版本编排（票 02）：从新版本目录起新 worker（旧的照常服务）→ 等 ready → 新旧短暂并存（同一监听
// socket 的两份 dup fd 由内核仲裁 accept）→ 回应换版本请求 → 通知旧 worker 排水 → 旧 worker 退出。
// 失败零损伤：新 worker ready 超时/起不来 → 杀之、软链回拨、旧 worker 全程未动。
// 自愈（票 02）：新 worker 就绪后连续快速退出（crash-loop）→ 读升级收据（磁盘）→ 窗口内未消费则拨回
// 上一版软链并重拉旧 worker，消费即作废；无收据/窗口外 → 只拉起不回滚（防无关崩溃连环回滚老版本）。
//
// systemd 保留兜底职责（Restart=always）：supervisor 自身启动失败（bind 失败/worker ready 超时）退出
// 非 0，交给 systemd 重启；worker 级监控（crash 拉起/自愈回滚）在本文件内闭环，不依赖 systemd 钩子。
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './store/db.ts';
import { createSystemEventStore, type RouteEventDetail } from './store/events.ts';
import { dataDir } from './paths.ts';
import type { Logger } from './contracts.ts';
import type { SwapRequest, SwapOutcome } from './swap.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 包根 = 本文件所在 core/ 的上一级（clone 根 / npm 安装区版本目录同构）。
function defaultSelfRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function versionOf(root: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// 监听端点解析（supervisor 自身视角）：env 优先（CPR_FORWARD_PORT/CPR_ADMIN_PORT，与
// resolveListenEndpoints 的 env 覆盖语义一致）；env 缺省读 policy.ts 的 listen/admin 端口字段
// （冷区端口；只取数值，不跑 validateConfig/decide——坏声明的 fail fast 归 worker，supervisor 读不到
// 就回落默认口并告警）；最终缺省 = 8741/8740。
export async function resolveSupervisorEndpoints(env: NodeJS.ProcessEnv = process.env): Promise<{ host: string; forwardPort: number; adminPort: number }> {
  const envPort = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fallback; // 非法值回落，worker 会按同一 env 报错
    return port;
  };
  const fallback = { host: '127.0.0.1', forwardPort: 8741, adminPort: 8740 };
  if (env.CPR_FORWARD_PORT !== undefined && env.CPR_ADMIN_PORT !== undefined) {
    return { host: '127.0.0.1', forwardPort: envPort('CPR_FORWARD_PORT', fallback.forwardPort), adminPort: envPort('CPR_ADMIN_PORT', fallback.adminPort) };
  }
  try {
    const policyFile = path.join(env.CPR_CONFIG_DIR || path.join(os.homedir(), '.llm-cpr'), 'policy.ts');
    if (fs.existsSync(policyFile)) {
      const loaded = await import(pathToFileURL(policyFile).href);
      const instance = new (loaded.default as new () => Record<string, unknown>)();
      const listen = instance.listen as { port?: unknown; host?: unknown } | undefined;
      const admin = instance.admin as { port?: unknown } | undefined;
      const readPort = (value: unknown, def: number): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : def;
      return {
        host: typeof listen?.host === 'string' && listen.host ? listen.host : fallback.host,
        forwardPort: envPort('CPR_FORWARD_PORT', readPort(listen?.port, fallback.forwardPort)),
        adminPort: envPort('CPR_ADMIN_PORT', readPort(admin?.port, fallback.adminPort)),
      };
    }
  } catch (error) {
    console.error(`supervisor: 读 policy 端口失败（${messageOf(error)}）——回落默认口 8741/8740（worker 若因此起不来会如实报错）`);
  }
  return fallback;
}

// 角色接缝（spec「角色接缝」先行设计）：默认 [{role:'all'}] 单 worker 跑两口；未来拆
// [{role:'relay'},{role:'admin'}] 时按 role → 端口子集映射，零架构返工。归属规则已在 spec 钉死。
export interface SupervisorRoleConfig { role: 'all' }
export type SupervisorHandle = unknown; // net._createServerHandle 的 TCP wrap（私有形状，本文件单点收口）

export interface ReadyInfo {
  version: string;
  dbFile?: string;
  pid: number;
}

// 换版本请求/结果的接缝契约：正本在 core/swap.ts（worker 桥/admin 面/CLI 三方共用），这里转出口。
export type { SwapRequest, SwapOutcome, SwapCoordinator } from './swap.ts';

// 升级收据（磁盘，dataDir/upgrade-receipt.json）：切换即落盘，自愈消费即作废（selfHealed 置真后
// 不再参与回滚裁决）。看板与排障认收据不认输出（票 03）。
export interface UpgradeReceipt {
  from: string;
  to: string;
  fromRoot: string;
  toRoot: string;
  switchedAt: string; // ISO
  windowMs: number;   // 收据有效窗口（写入时定型）
  selfHealed: null | boolean; // null = 未消费；true/false = 自愈已触发（结果）
  rollbackAt?: string;
  rollbackReason?: string;
}

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  roles?: SupervisorRoleConfig[];
  readyTimeoutMs?: number; // 默认 15_000（可用 CPR_SUPERVISOR_READY_TIMEOUT_MS 覆盖）：ready 超时 → 杀 worker、supervisor 报错退出（systemd Restart=always 兜底）
  selfRoot?: string;       // worker 源根（缺省 = 包根；换版本编排时按请求指向新版本目录）
  drainTimeoutMs?: number; // 排水上限（默认 30s，可用 CPR_DRAIN_TIMEOUT_MS 覆盖）：超时强切，账本收尾=现状硬切语义
  crashLimit?: number;     // 自愈触发阈值：连续快速退出次数（默认 2）
  crashWindowMs?: number;  // 「快速退出」判定：ready 后存活小于该值算一次（默认 10s）
  receiptWindowMs?: number; // 收据有效窗口（默认 15min）：窗口外不回滚
}

// fd 交接单点：net._createServerHandle（bind 不 listen）。Node ≥22.18 钉死该内部 API 的存在性，
// 缺失时明确报错而不是静默退化（宁可拒绝启动也不假装持有端口）。
const createServerHandle = (net as unknown as { _createServerHandle?: (address: string, port: number, addressType: number, fd?: number, flags?: number) => unknown })._createServerHandle;

function bindSupervisorHandle(host: string, port: number, label: string): SupervisorHandle {
  if (typeof createServerHandle !== 'function') throw new Error('net._createServerHandle 不可用（Node 版本变化？）——supervisor 无法持有监听口，拒绝启动');
  const handle = createServerHandle(host, port, host.includes(':') ? 6 : 4);
  if (typeof handle === 'number') throw new Error(`supervisor bind ${label} 口 ${host}:${port} 失败（errno ${handle}）——端口被占或权限不足`);
  return handle;
}

interface WorkerEntry {
  child: ChildProcess;
  ready: ReadyInfo;
  root: string;
  readyAt: number;
  crashStreak: number;
}

export class Supervisor {
  readonly selfRoot: string;
  readonly roles: SupervisorRoleConfig[];
  readonly readyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly crashLimit: number;
  readonly crashWindowMs: number;
  readonly receiptWindowMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private forwardHandle: SupervisorHandle | null = null;
  private adminHandle: SupervisorHandle | null = null;
  private endpoints: { host: string; forwardPort: number; adminPort: number } | null = null;
  // 角色接缝的运行面：role → worker 进程。'all' 模式恒一条记录。
  private readonly roleWorkers = new Map<string, WorkerEntry>();
  private started = false;
  // 换版本进行中（票 02 并发防线：第二个换版本请求被拒，不留磁盘锁文件）。
  private swapInFlight = false;
  // 并存窗口的旧 worker 若在换版本完成前自己死了：swap 失败路径要补拉（成功路径已被新 worker 替代）。
  private oldWorkerDiedDuringSwap = false;
  private currentDbFile: string | undefined;

  constructor({ env = process.env, roles = [{ role: 'all' }], readyTimeoutMs, selfRoot: root = defaultSelfRoot(), drainTimeoutMs, crashLimit, crashWindowMs, receiptWindowMs }: SupervisorOptions = {}, logger: Pick<Console, 'log' | 'warn' | 'error'> = console) {
    for (const { role } of roles) {
      if (role !== 'all') throw new Error(`角色 ${role} 未实现（本批只支持 'all' 单 worker 跑两口；roles 接缝为将来留门）`);
    }
    this.selfRoot = root;
    this.roles = roles;
    // ready 门禁上限：显式参数 > env 接缝 > 默认 15s。非法值（非正数）回落默认。
    const envReady = Number(env.CPR_SUPERVISOR_READY_TIMEOUT_MS);
    this.readyTimeoutMs = readyTimeoutMs ?? (Number.isFinite(envReady) && envReady > 0 ? envReady : 15_000);
    const envDrain = Number(env.CPR_DRAIN_TIMEOUT_MS);
    this.drainTimeoutMs = drainTimeoutMs ?? (Number.isFinite(envDrain) && envDrain > 0 ? envDrain : 30_000);
    this.crashLimit = crashLimit ?? 2;
    this.crashWindowMs = crashWindowMs ?? 10_000;
    this.receiptWindowMs = receiptWindowMs ?? 15 * 60_000;
    this.env = env;
    this.logger = logger;
  }

  // 启动：bind 两口 → spawn worker → handle 交接 → 等 ready → 就绪态。
  async start(): Promise<void> {
    if (this.started) throw new Error('supervisor 已启动');
    this.started = true;
    const endpoints = await resolveSupervisorEndpoints(this.env);
    this.endpoints = endpoints;
    // 终生持有：handle 只在本进程内存里，永不 close（worker 退出只减 worker 侧 dup 的 fd 引用）。
    this.forwardHandle = bindSupervisorHandle(endpoints.host, endpoints.forwardPort, 'forward');
    this.adminHandle = bindSupervisorHandle(endpoints.host, endpoints.adminPort, 'admin');
    for (const { role } of this.roles) {
      await this.spawnAndArmWorker(role, this.selfRoot);
    }
  }

  // spawn worker（--worker 模式）→ 发两口 handle → 等 ready。ready 超时/起不来 → 杀 worker、抛错
  // （「起来就没就绪过」：启动路径交 systemd 兜底；换版本路径由 swapCore 回拨软链、旧 worker 不动）。
  private async bootWorker(root: string): Promise<{ child: ChildProcess; ready: ReadyInfo }> {
    const child = fork(path.join(root, 'core', 'main.ts'), ['--worker'], {
      cwd: root,
      env: this.env, // 单源 env：supervisor 的环境就是 worker 的（unit 已钉全部 CPR_* 接缝）
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    // IPC 通道死亡（worker 先退场）时 send 返回 false 并发 'error' 事件——挂 listener 兜住，
    // 绝不让它变成 uncaughtException 炸掉 supervisor（发送侧一律先看 connected）。
    child.on('error', (error) => {
      this.logger.warn?.(`supervisor: worker IPC 错误（${messageOf(error)}）——按通道关闭处理`);
    });
    this.sendHandles(child);
    const ready = await new Promise<ReadyInfo>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
      const timer = setTimeout(() => {
        cleanup();
        child.kill('SIGKILL'); // ready 超时：杀了再报错（防半死进程占库/占口）
        reject(new Error(`worker ready 超时（${this.readyTimeoutMs}ms）——杀之`));
      }, this.readyTimeoutMs);
      const onMessage = (msg: { act?: string; version?: string; dbFile?: string }): void => {
        if (msg?.act !== 'ready') return;
        cleanup();
        resolve({ version: msg.version ?? 'unknown', dbFile: msg.dbFile, pid: child.pid ?? -1 });
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`worker 未发 ready 即退出（code=${code} signal=${signal ?? ''}）——开库/声明装载失败在 worker 的 stderr 里`));
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
    });
    // journal 启动行（版本可见性惯例）：supervisor/worker 两级版本 + 角色 + 两口端点。
    this.logger.log?.(`llm-cpr supervisor ${versionOf(this.selfRoot)} — roles: ${this.roles.map((entry) => entry.role).join(',')} — worker ${ready.version} pid ${ready.pid}（forward :${this.endpoints?.forwardPort} admin :${this.endpoints?.adminPort}）`);
    return { child, ready };
  }

  private sendHandles(child: ChildProcess): void {
    if (!this.forwardHandle || !this.adminHandle) throw new Error('监听 handle 未 bind——先 start()');
    // fd 交接的受控越界点：handle 是内部 TCP wrap（net.Native），@types/node 的 Handle 联合不含它；
    // 运行期走 child_process 的 handleConversion（cluster SharedHandle 同一条路），此处只收类型。
    if (child.connected) {
      child.send({ act: 'listen', kind: 'forward' }, this.forwardHandle as never);
      child.send({ act: 'listen', kind: 'admin' }, this.adminHandle as never);
    }
  }

  // worker 转正：进角色台账 + 接稳态监控。crashStreak/readyAt 可从前任继承（自愈重拉计数不归零）。
  private adoptWorker(role: string, child: ChildProcess, ready: ReadyInfo, root: string, carry?: { crashStreak: number; readyAt: number }): void {
    const entry: WorkerEntry = { child, ready, root, readyAt: carry?.readyAt ?? Date.now(), crashStreak: carry?.crashStreak ?? 0 };
    this.roleWorkers.set(role, entry);
    this.wireSteadyState(role, child);
    // 换版本窗口里新 worker 可能已在排水等待期间自我退场（exit 发生在 wire 之前，事件没人接）：
    // 转正后核对存活，已死立即走 crash 处理（streak 计数 / 收据自愈回滚），绝不收养尸体干耗。
    if (child.exitCode !== null || child.signalCode !== null) {
      void this.handleWorkerCrash(role, child.exitCode, child.signalCode);
    }
  }

  private async spawnAndArmWorker(role: string, root: string, carry?: { crashStreak: number; readyAt: number }): Promise<ReadyInfo> {
    const { child, ready } = await this.bootWorker(root);
    this.adoptWorker(role, child, ready, root, carry);
    return ready;
  }

  // 就绪态的 worker 级监控：意外退出 → crash 计数 →（达标且有可用收据）自愈回滚，否则原根重拉。
  private wireSteadyState(role: string, child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      if (!this.started) return; // supervisor 自身在停机：不再拉起
      const entry = this.roleWorkers.get(role);
      if (!entry || entry.child !== child) return; // 已被换版本替代的旧进程：退出事件不归稳态监控管
      if (this.swapInFlight) { this.oldWorkerDiedDuringSwap = true; return; } // 换版本编排自己收尾
      void this.handleWorkerCrash(role, code, signal);
    });
    // 换版本请求（票 03 CLI 经 admin 面 /api/supervisor/swap → worker IPC 转发到这里）。
    child.on('message', (msg: { act?: string; seq?: number; payload?: SwapRequest }) => {
      if (msg?.act !== 'swap' || typeof msg.seq !== 'number') return;
      void (async (): Promise<void> => {
        const result = await this.swapCore(msg.payload ?? {});
        if (child.connected) child.send({ act: 'swap-result', seq: msg.seq, outcome: result.outcome }); // 旧 worker 已死：CLI 会经健康门得知结果
        if (result.outcome.ok && result.worker) await this.finishSwap(child, result.worker);
      })();
    });
  }

  private async handleWorkerCrash(role: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const entry = this.roleWorkers.get(role);
    if (!entry) return;
    const runtimeMs = Date.now() - entry.readyAt;
    // 连续快速退出计数跨重拉继承（crash-loop 的定义就是「连续」）；活过 crashWindow 再死 = 从头计。
    const streak = runtimeMs < this.crashWindowMs ? entry.crashStreak + 1 : 0;
    this.logger.warn?.(`supervisor: worker 退出（code=${code} signal=${signal ?? ''}，存活 ${runtimeMs}ms，连续快速退出 ${streak}/${this.crashLimit}）`);
    if (streak >= this.crashLimit) {
      const rolled = await this.trySelfHealRollback(entry);
      if (rolled) return; // 已拨回上一版并重拉
      this.logger.warn?.('supervisor: 连续快速退出但无可用收据（无/已消费/窗口外/旧根缺失）——只拉起不回滚（防无关崩溃连环回滚老版本）');
    }
    // 原根重拉（crash 拉起是 supervisor 的天职；自愈失败/无收据都在这里兜底成普通重拉）。
    try {
      await this.spawnAndArmWorker(role, entry.root, { crashStreak: streak, readyAt: Date.now() });
    } catch (error) {
      this.logger.error?.(`supervisor: worker 重拉失败：${messageOf(error)}——退出交 systemd 兜底`);
      process.exit(1);
    }
  }

  // 收据自愈（票 02）：升级后 crash-loop → 收据在窗口内且未消费 → 拨软链回上一版、消费收据、
  // 落 upgrade.rollback 事件、从旧版本根重拉 worker。消费即作废（selfHealed 置真，不再参与裁决）。
  private async trySelfHealRollback(entry: WorkerEntry): Promise<boolean> {
    const receipt = this.readReceipt();
    if (!receipt) return false;
    const withinWindow = Date.now() - Date.parse(receipt.switchedAt) <= receipt.windowMs;
    const usable = receipt.selfHealed === null && withinWindow
      && receipt.fromRoot !== entry.root
      && fs.existsSync(path.join(receipt.fromRoot, 'core', 'main.ts'));
    if (!usable) {
      if (receipt.selfHealed !== null) this.logger.warn?.(`supervisor: 收据已消费（selfHealed=${receipt.selfHealed}）——不再回滚`);
      else if (!withinWindow) this.logger.warn?.('supervisor: 收据在窗口外——不回滚（防无关崩溃连环回滚老版本）');
      return false;
    }
    this.logger.warn?.(`supervisor: 自愈触发——升级 ${receipt.from} → ${receipt.to} 后 crash-loop，拨回 ${receipt.from} 并重拉旧 worker`);
    const appRoot = this.appRootOf(receipt.toRoot) ?? this.appRootOf(receipt.fromRoot);
    if (appRoot) this.flipCurrentLink(appRoot, receipt.from);
    this.consumeReceipt(receipt, 'crash-loop');
    this.appendUpgradeEvent('upgrade.rollback', { reason: 'crash-loop', from_version: receipt.to, to_version: receipt.from });
    try {
      const ready = await this.spawnAndArmWorker('all', receipt.fromRoot);
      this.logger.warn?.(`supervisor: 已回滚到 ${receipt.from}（worker pid ${ready.pid}）`);
      return true;
    } catch (error) {
      this.logger.error?.(`supervisor: 回滚重拉失败：${messageOf(error)}——退出交 systemd 兜底`);
      process.exit(1);
    }
  }

  // ---- 升级收据（dataDir/upgrade-receipt.json）----
  private receiptPath(): string {
    return path.join(dataDir(this.env), 'upgrade-receipt.json');
  }

  private writeReceipt(receipt: UpgradeReceipt): void {
    const file = this.receiptPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
      fs.renameSync(tmp, file); // 原子落盘：断电不留半张收据
    } catch (error) {
      this.logger.warn?.(`supervisor: 升级收据落盘失败（${messageOf(error)}）——自愈将无从谈起，请查 ${file}`);
    }
  }

  readReceipt(): UpgradeReceipt | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.receiptPath(), 'utf8')) as UpgradeReceipt;
      if (typeof parsed?.from !== 'string' || typeof parsed?.to !== 'string' || typeof parsed?.switchedAt !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private consumeReceipt(receipt: UpgradeReceipt, reason: string): void {
    this.writeReceipt({ ...receipt, selfHealed: true, rollbackAt: new Date().toISOString(), rollbackReason: reason });
  }

  // ---- 换版本编排（票 02）----
  // 内部 API（票 03 CLI 接线）：从指定版本目录 spawn 新 worker（旧的不动）→ 等 ready → 回应 →
  // 旧 worker 排水退出。成功收据 + upgrade.swap 事件；失败零损伤（杀新 worker、软链回拨、旧的不动）。
  async swap(request: SwapRequest = {}): Promise<SwapOutcome> {
    const entry = this.roleWorkers.get('all');
    if (!entry) return { ok: false, status: 'failed', error: 'worker 未就绪（supervisor 尚未完成启动）' };
    const result = await this.swapCore(request);
    if (!result.outcome.ok || !result.worker) return result.outcome;
    await this.finishSwap(entry.child, result.worker);
    return result.outcome;
  }

  // swapCore：到 ready 过门 + 收据/事件落账为止（不排水）。IPC 面先回结果再排水——旧 worker 扛着
  // HTTP 响应，先答话后走人，避免「等旧 worker 退出才回结果」的死锁。成功路径把 swapResultPending
  // 置真并保持 swapInFlight（并发防线延续到排水结束，finishSwap 统一复位）。
  private async swapCore(request: SwapRequest): Promise<{ outcome: SwapOutcome; worker?: { child: ChildProcess; ready: ReadyInfo; root: string } }> {
    if (!this.started) return { outcome: { ok: false, status: 'failed', error: 'supervisor 正在停机——不接受换版本请求' } };
    if (this.swapInFlight) return { outcome: { ok: false, status: 'in-progress', error: '上一次换版本还在进行中（升级期间 supervisor 拒绝第二个请求）' } };
    const entry = this.roleWorkers.get('all');
    if (!entry) return { outcome: { ok: false, status: 'failed', error: 'worker 未就绪（supervisor 尚未完成启动）' } };
    this.swapInFlight = true;
    this.oldWorkerDiedDuringSwap = false;
    const fromRoot = entry.root;
    const fromVersion = versionOf(fromRoot);
    try {
      const targetRoot = request.root ? path.resolve(request.root) : fromRoot;
      if (!fs.existsSync(path.join(targetRoot, 'core', 'main.ts'))) {
        return { outcome: { ok: false, status: 'failed', error: `目标版本目录缺 core/main.ts：${targetRoot}` } };
      }
      const toVersion = request.version ?? versionOf(targetRoot);
      // 软链翻转（先翻后换）：supervisor 是唯一拨链者（票 03——CLI 不自己拨）。失败回拨由本函数兜底。
      const appRoot = request.appRoot ?? this.appRootOf(targetRoot);
      const linkFlipped = Boolean(appRoot && toVersion !== fromVersion && this.flipCurrentLink(appRoot, toVersion));
      let booted: { child: ChildProcess; ready: ReadyInfo };
      try {
        booted = await this.bootWorker(targetRoot);
      } catch (error) {
        if (linkFlipped && appRoot) this.flipCurrentLink(appRoot, fromVersion); // 失败零损伤：软链回拨，旧 worker 全程未动
        return { outcome: { ok: false, status: 'failed', error: messageOf(error) } };
      }
      // ready 过门：跨版本换 → 落收据（自愈的锚）；upgrade.swap 事件每次成功换 worker 都落（reload 同版本换也留痕）。
      if (booted.ready.dbFile) this.currentDbFile = booted.ready.dbFile;
      if (toVersion !== fromVersion) {
        this.writeReceipt({ from: fromVersion, to: toVersion, fromRoot, toRoot: targetRoot, switchedAt: new Date().toISOString(), windowMs: this.receiptWindowMs, selfHealed: null });
      }
      this.appendUpgradeEvent('upgrade.swap', { from_version: fromVersion, to_version: toVersion, same_version: toVersion === fromVersion });
      this.swapResultPending = true; // 成功：并发防线延续到 finishSwap 复位
      return { outcome: { ok: true, fromVersion, toVersion, workerPid: booted.ready.pid }, worker: { child: booted.child, ready: booted.ready, root: targetRoot } };
    } finally {
      // 失败/异常路径在此复位；成功路径 swapResultPending=true 挡住复位，交给 finishSwap。
      if (!this.swapResultPending) this.swapInFlight = false;
    }
  }

  private swapResultPending = false;

  // 排水 + 转正（票 02）：旧 worker 收排水指令 → 停接新请求 → 在途跑完 → 退出（上限 drainTimeoutMs，
  // 超时强切=现状 systemd 硬切语义）；随后新 worker 收 promote（quiet 窗口解除，policy.reload 事件不再双记）。
  private async finishSwap(oldChild: ChildProcess, worker: { child: ChildProcess; ready: ReadyInfo; root: string }): Promise<void> {
    this.swapResultPending = true;
    if (oldChild.connected) oldChild.send({ act: 'drain' });
    // 旧 worker 若在换版本进行中已自己退场：不等了（exit 事件不会再发），直接转正。
    const alreadyGone = oldChild.exitCode !== null || oldChild.signalCode !== null;
    await new Promise<void>((resolve) => {
      if (alreadyGone) return resolve();
      const timer = setTimeout(() => {
        try { oldChild.kill('SIGKILL'); } catch { /* 已退出 */ }
        this.logger.warn?.(`supervisor: 旧 worker 排水超 ${this.drainTimeoutMs}ms——强切（账本收尾=现状硬切语义）`);
        resolve();
      }, this.drainTimeoutMs + 5_000);
      oldChild.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (worker.child.connected) worker.child.send({ act: 'promote' });
    this.adoptWorker('all', worker.child, worker.ready, worker.root, { crashStreak: 0, readyAt: Date.now() });
    this.swapResultPending = false;
    this.swapInFlight = false;
    this.logger.log?.(`supervisor: 换 worker 完成（${worker.ready.version} pid ${worker.ready.pid}），旧 worker 已退出`);
  }

  // ---- 软链（versions/<v>/app 布局）----
  // root 形如 <appRoot>/versions/<v>/app 时返回 appRoot，否则 null（dev 单目录布局不翻链）。
  private appRootOf(root: string): string | null {
    const versionDir = path.dirname(root); // <appRoot>/versions/<v>
    if (path.basename(path.dirname(versionDir)) === 'versions') {
      return path.dirname(path.dirname(versionDir));
    }
    return null;
  }

  // current 翻转：先建新链再 rename 换名（原子，永不出现「没有 current」的窗口；CLI flipCurrent 同款）。
  private flipCurrentLink(appRoot: string, version: string): boolean {
    const link = path.join(appRoot, 'current');
    try {
      const currentTarget = path.basename(fs.readlinkSync(link));
      if (currentTarget === version) return false; // 已指向目标（同版本换/repeat）
      const tmp = `${link}.new-${process.pid}`;
      fs.rmSync(tmp, { force: true });
      fs.symlinkSync(path.join('versions', version), tmp, 'dir');
      fs.renameSync(tmp, link);
      const flipped = path.basename(fs.readlinkSync(link));
      if (flipped !== version) throw new Error(`current 翻转异常：期望 ${version} 实指 ${flipped}`);
      this.logger.log?.(`supervisor: current → ${version}`);
      return true;
    } catch (error) {
      this.logger.warn?.(`supervisor: current 软链翻转失败（${messageOf(error)}）——运行不受影响（worker 按显式目录拉起），但下次重启会跑回旧版`);
      return false;
    }
  }

  // ---- system_events（upgrade.swap / upgrade.rollback，tenant 恒 'default'，对齐 policy.reload 口径）----
  // supervisor 侧的独立库连接：WAL 多进程已是现状（cpr CLI 并发访问先例）；每次事件现开现关，
  // busy_timeout 兜并发写。开库失败只丢事件不挡编排（worker 自己的 ready 证明库存在且可用）。
  private appendUpgradeEvent(kind: 'upgrade.swap' | 'upgrade.rollback', detail: RouteEventDetail): void {
    const dbFile = this.currentDbFile;
    if (!dbFile) {
      this.logger.warn?.(`supervisor: ${kind} 未落账——worker 未上报 dbFile`);
      return;
    }
    let db: import('node:sqlite').DatabaseSync | null = null;
    try {
      db = openDatabase(dbFile, { baseline: false });
      db.exec('PRAGMA busy_timeout=5000');
      const noop: Logger = { log: () => {}, warn: () => {}, error: () => {} };
      createSystemEventStore(db, noop).append({ kind, tenant: 'default', detail });
      this.logger.log?.(`supervisor: ${kind} 已落账（${JSON.stringify(detail)}）`);
    } catch (error) {
      this.logger.warn?.(`supervisor: ${kind} 落账失败（${messageOf(error)}）——编排继续，账本少一行`);
    } finally {
      try { db?.close(); } catch { /* 已关 */ }
    }
  }

  // 优雅停机（SIGTERM/SIGINT 同义）：先等在途换版本编排收尾（finishSwap 完成后 roleWorkers 才
  // 指向接任 worker——否则 stop 会漏掉新 worker，留孤儿占着监听口，重启的 supervisor bind 必炸），
  // 再统一通知 worker 排水退出（上限本 drainTimeoutMs）后收摊。
  async stop(): Promise<void> {
    this.started = false;
    const swapDeadline = Date.now() + this.readyTimeoutMs + this.drainTimeoutMs + 10_000;
    while (this.swapInFlight && Date.now() < swapDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const children = [...this.roleWorkers.values()].map((entry) => entry.child);
    this.roleWorkers.clear();
    for (const child of children) {
      if (child.connected) child.send({ act: 'drain' });
      else child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { for (const child of children) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } resolve(); }, this.drainTimeoutMs + 5_000);
      let left = children.length;
      if (left === 0) { clearTimeout(timer); return resolve(); }
      for (const child of children) child.once('exit', () => { left -= 1; if (left === 0) { clearTimeout(timer); resolve(); } });
    });
  }
}

// CLI 入口：node core/supervisor.ts（unit 模板 ExecStart 与 e2e 都从这里拉起）。
// 非 direct-run（被 import）不进 main——进程生命周期归调用方。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const supervisor = new Supervisor({});
  try {
    await supervisor.start();
  } catch (error) {
    console.error(`supervisor: 启动失败：${messageOf(error)}——退出（systemd Restart=always 兜底）`);
    process.exit(1);
  }
  const shutdown = (): void => {
    void supervisor.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
