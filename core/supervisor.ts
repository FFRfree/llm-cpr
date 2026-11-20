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
// systemd 保留兜底职责（Restart=always）：supervisor 自身启动失败（bind 失败/worker ready 超时）退出
// 非 0，交给 systemd 重启；worker 级监控（crash 拉起/自愈回滚）在本文件内闭环，不依赖 systemd 钩子。
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 包根 = 本文件所在 core/ 的上一级（clone 根 / npm 安装区版本目录同构）。
function selfRoot(): string {
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
      const readPort = (value: unknown, name: string, def: number): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : def;
      return {
        host: typeof listen?.host === 'string' && listen.host ? listen.host : fallback.host,
        forwardPort: envPort('CPR_FORWARD_PORT', readPort(listen?.port, 'listen.port', fallback.forwardPort)),
        adminPort: envPort('CPR_ADMIN_PORT', readPort(admin?.port, 'admin.port', fallback.adminPort)),
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

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  roles?: SupervisorRoleConfig[];
  readyTimeoutMs?: number; // 默认 15_000（可用 CPR_SUPERVISOR_READY_TIMEOUT_MS 覆盖）：ready 超时 → 杀 worker、supervisor 报错退出（systemd Restart=always 兜底）
  selfRoot?: string;       // worker 源根（缺省 = 包根；换版本编排时按请求指向新版本目录）
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

export class Supervisor {
  readonly selfRoot: string;
  readonly roles: SupervisorRoleConfig[];
  readonly readyTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private forwardHandle: SupervisorHandle | null = null;
  private adminHandle: SupervisorHandle | null = null;
  private endpoints: { host: string; forwardPort: number; adminPort: number } | null = null;
  // 角色接缝的运行面：role → worker 进程。'all' 模式恒一条记录。
  private readonly roleWorkers = new Map<string, { child: ChildProcess; ready: ReadyInfo; root: string }>();
  private started = false;

  constructor({ env = process.env, roles = [{ role: 'all' }], readyTimeoutMs, selfRoot: root = selfRoot() }: SupervisorOptions = {}, logger: Pick<Console, 'log' | 'warn' | 'error'> = console) {
    for (const { role } of roles) {
      if (role !== 'all') throw new Error(`角色 ${role} 未实现（本批只支持 'all' 单 worker 跑两口；roles 接缝为将来留门）`);
    }
    this.selfRoot = root;
    this.roles = roles;
    // ready 门禁上限：显式参数 > env 接缝 > 默认 15s。非法值（非正数）回落默认。
    const envTimeout = Number(env.CPR_SUPERVISOR_READY_TIMEOUT_MS);
    this.readyTimeoutMs = readyTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15_000);
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

  // spawn worker（--worker 模式）→ 发两口 handle → 等 ready。ready 超时/起不来 → 杀 worker、
  // supervisor 报错退出（「起来就没就绪过」，交给 systemd Restart=always 兜底）。
  private async spawnAndArmWorker(role: string, root: string): Promise<ReadyInfo> {
    const child = fork(path.join(root, 'core', 'main.ts'), ['--worker'], {
      cwd: root,
      env: this.env, // 单源 env：supervisor 的环境就是 worker 的（unit 已钉全部 CPR_* 接缝）
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg: { act?: string }, handle: unknown) => {
      void handle; // handle 消息在 runWorker 内消费；这里只留 supervisor 侧观察点
      if (msg?.act === 'ready') this.onWorkerMessage(role, 'ready');
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
    this.roleWorkers.set(role, { child, ready, root });
    this.wireSteadyState(role, child);
    return ready;
  }

  private sendHandles(child: ChildProcess): void {
    if (!this.forwardHandle || !this.adminHandle) throw new Error('监听 handle 未 bind——先 start()');
    // fd 交接的受控越界点：handle 是内部 TCP wrap（net.Native），@types/node 的 Handle 联合不含它；
    // 运行期走 child_process 的 handleConversion（cluster SharedHandle 同一条路），此处只收类型。
    child.send({ act: 'listen', kind: 'forward' }, this.forwardHandle as never);
    child.send({ act: 'listen', kind: 'admin' }, this.adminHandle as never);
  }

  private onWorkerMessage(_role: string, _kind: string): void { /* 就绪态观察点（票 02 换版本编排扩展） */ }

  // 就绪态的 worker 级监控：意外退出 → 原根重拉（crash 拉起是 supervisor 的天职；票 02 在这里挂自愈回滚）。
  private wireSteadyState(role: string, child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      if (!this.started) return; // supervisor 自身在停机：不再拉起
      this.logger.warn?.(`supervisor: ${role} worker 退出（code=${code} signal=${signal ?? ''}）——原根重拉`);
      void this.spawnAndArmWorker(role, this.roleWorkers.get(role)?.root ?? this.selfRoot).catch((error) => {
        this.logger.error?.(`supervisor: worker 重拉失败：${messageOf(error)}——退出交 systemd 兜底`);
        process.exit(1);
      });
    });
  }

  // 优雅停机（SIGTERM/SIGINT 同义）：worker 排水由票 02 的 drain 语义接手；本票先保「杀了不残留」。
  async stop(): Promise<void> {
    this.started = false;
    for (const [, entry] of this.roleWorkers) {
      entry.child.kill('SIGTERM');
      await new Promise<void>((resolve) => { entry.child.once('exit', () => resolve()); setTimeout(resolve, 5_000).unref?.(); });
    }
    this.roleWorkers.clear();
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
