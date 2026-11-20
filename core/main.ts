#!/usr/bin/env node
// 配置即代码（v0.2.0）：声明与策略 = ~/.llm-cpr/policy.ts（用户真身，CPR_CONFIG_DIR 接缝可挪）或 core/policy/mine.ts（内置默认）。
// 存在 ~/.llm-cpr/policy.ts 则优先；坏声明在此拒绝启动（退出码 1）。
// 两种运行形态（supervisor-upgrade spec）：
//   直跑（systemd ExecStart 直指本文件 / 测试）：自 bind 两监听口——v0.6.0 前的形态，行为不变。
//   --worker（supervisor 形态）：不自 bind，经 IPC 收 supervisor 交接的监听 handle（8741/8740 两个），
//   开库成功 + 两口就绪后发 `ready`（pm2 wait_ready 同义）；快照轮询等 ready 后才开（防并存窗口双跑）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { startGateway, type Gateway } from './http/server.ts';
import { validateConfig } from './policy/config.ts';
import { sha256File } from './policy/reload.ts';
import { configDir, envFile } from './paths.ts';
import { loadDotEnv } from './envfile.ts';
import type { RouterPolicy } from './policy/contract.ts';
import type { SwapCoordinator, SwapOutcome, SwapRequest } from './swap.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 版本可见性：包内 package.json 的 version 是唯一正源（npm 形态各处同源；v0.1.0 的 RELEASE.txt/git
// 机制已随 clone 分发退役——npm 装出来没有 RELEASE.txt 也没有 .git，读它们只会得到 unknown）。
function bootVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface PolicyBoot {
  policy: RouterPolicy;
  policyFile?: string;
  sourceLine: string;
}

// 启动装载（两形态共用）：.env → policy.ts/内置 mine → validateConfig → 启动行。
// 坏声明在此原样抛（消息带 source 前缀），直跑与 worker 模式都 fail fast。
async function loadPolicy(): Promise<PolicyBoot> {
  // v0.2.0：引擎自己加载 ~/.llm-cpr/.env（前台直跑无 systemd 时也能拿到密钥）；CPR_ENV_FILE 接缝优先
  // （与探针脚本同语义），只填缺失键不覆盖真实环境变量。systemd 场景 EnvironmentFile 先到、此处成无害重复。
  const envPath = envFile();
  if (fs.existsSync(envPath)) {
    const loadedKeys = loadDotEnv(envPath);
    if (loadedKeys > 0) console.log(`env: ${envPath}（${loadedKeys} 键）`);
  }
  const localPath = path.join(configDir(), 'policy.ts');
  const fromFile = fs.existsSync(localPath);
  const source = fromFile ? localPath : 'core/policy/mine.ts';
  // 动态 import 用变量路径：文件存在与否已用 existsSync 判定，import 失败（语法错/坏 import）一律原样抛。
  const loaded = source === 'core/policy/mine.ts'
    ? await import('./policy/mine.ts')
    : await import(pathToFileURL(localPath).href);
  const PolicyCtor = loaded.default as new () => RouterPolicy;
  const policy = new PolicyCtor();
  try {
    validateConfig(policy);
  } catch (error) {
    throw new Error(`${source}: ${messageOf(error)}`);
  }
  // 启动行附 sha256（工单 policy-hot-reload）：「现在跑的是哪份声明」的可审计锚点，
  // 与热更新后的 system_events policy.reload 事件、backups/policy 快照同源对账。
  const fileHash = fromFile ? ` · sha256 ${sha256File(localPath).slice(0, 12)}` : '';
  return {
    policy,
    policyFile: fromFile ? localPath : undefined,
    sourceLine: `llm-cpr ${bootVersion()} — policy: ${source}${fileHash}`,
  };
}

// --worker 模式（supervisor-upgrade 票 01/02）：收两口 handle → 起网关（不自 bind）→ 发 ready →
// 开快照轮询 → 挂换版本桥/排水/promote 消息面。
// 测试接缝 CPR_WORKER_READY_DELAY_MS：ready 前人为拖延（仅测试用，钉死在 fixture env）。
async function runWorker(): Promise<void> {
  const handles = await new Promise<{ forward: unknown; admin: unknown }>((resolve, reject) => {
    const got: Partial<Record<'forward' | 'admin', unknown>> = {};
    const timer = setTimeout(() => reject(new Error('worker 30s 内未收齐两口监听 handle——supervisor 交接缺失')), 30_000);
    const onMessage = (msg: { act?: string; kind?: string }, handle: unknown): void => {
      if (msg?.act !== 'listen' || (msg.kind !== 'forward' && msg.kind !== 'admin')) return;
      got[msg.kind] = handle;
      if (got.forward !== undefined && got.admin !== undefined) {
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve({ forward: got.forward, admin: got.admin });
      }
    };
    process.on('message', onMessage);
  });
  const boot = await loadPolicy();
  console.log(boot.sourceLine);
  const tenantNames = (boot.policy.tenants ?? []).map((tenant) => tenant.name);
  if (tenantNames.length) console.log(`tenants: ${tenantNames.join(', ')}`);
  // 换版本桥（票 02/03）：admin 面 /api/supervisor/swap → IPC 转发 supervisor 编排 → swap-result 回填。
  // 时限 = ready 门 15s + 排水 30s + 富余；supervisor 不应答按失败结案（CLI 会经健康门另见真相）。
  let swapSeq = 0;
  const pendingSwaps = new Map<number, (outcome: SwapOutcome) => void>();
  // IPC 通道死亡时 process.send 返回 false 并发 'error' 事件——挂 listener 兜住，别炸 worker。
  process.on('error', (error: Error) => { console.error(`worker: IPC 通道错误（${error.message}）——按通道关闭处理`); });
  const sendToSupervisor = (msg: Record<string, unknown>): void => {
    if (process.connected) process.send?.(msg);
  };
  const swapBridge: SwapCoordinator = {
    swap: (request?: SwapRequest): Promise<SwapOutcome> => new Promise((resolve) => {
      const seq = ++swapSeq;
      pendingSwaps.set(seq, resolve);
      const timer = setTimeout(() => {
        if (!pendingSwaps.has(seq)) return;
        pendingSwaps.delete(seq);
        resolve({ ok: false, status: 'failed', error: 'supervisor 未在时限内应答换版本请求（进程还在？）' });
      }, 180_000);
      timer.unref?.();
      sendToSupervisor({ act: 'swap', seq, payload: request ?? {} });
    }),
  };
  const gateway: Gateway = await startGateway(boot.policy, {
    policyFile: boot.policyFile,
    listenHandles: handles,
    deferSnapshots: true,
    swapCoordinator: swapBridge,
    policyEventsQuiet: true, // 并存窗口：旧 worker 是 policy.reload 事件记录者，promote 后解除（票 02）
  });
  // 就绪 = 开库成功 + 两口接管完成：此刻才发 ready（pm2 wait_ready 同义）——开库失败会走 catch
  // 原样退出（退出码 1），supervisor 侧可见「没就绪就退出」。
  const readyDelay = Number(process.env.CPR_WORKER_READY_DELAY_MS ?? 0);
  if (Number.isFinite(readyDelay) && readyDelay > 0) await new Promise((resolve) => setTimeout(resolve, readyDelay));
  sendToSupervisor({ act: 'ready', version: bootVersion(), dbFile: gateway.dbPath });
  gateway.startSnapshots();
  // 排水（票 02）：停接新请求 → 在途跑完 → 退出；上限 CPR_DRAIN_TIMEOUT_MS（默认 30s），
  // 超时强切——账本收尾行为与现状 systemd 硬切一致（在途请求直接死、无收尾行）。
  // 实现细节（零断粮的关键，实测教训）：
  //   · 停接 = net 层关 listening handle，不走 http.Server.close()——它自带的 idle keep-alive
  //     清理会把客户端连接池里的空闲 socket 掐掉（复用即被 reset，压测 16 条挂 4 条）。
  //   · 排水期的每个响应标 `Connection: close`（客户端干净轮换到新 worker，不回收旧 socket），
  //     响应一结束就 end() 存活连接；闲置残留连接只在排水上限的最后一次扫尾里收（窗口最小化）。
  let drained = false;
  let drainFlag = false;
  // 包一层 request 前处理：排水期响应标 Connection: close + finish 即收线；顺带记录在途响应
  // （排水开始时要给「头部已发出的在途请求」补挂 finish 收线钩子——SSE 的头可能早已出去）。
  const wrapServer = (server: http.Server): Set<http.ServerResponse> => {
    const handlers = server.listeners('request') as ((req: http.IncomingMessage, res: http.ServerResponse) => void)[];
    server.removeAllListeners('request');
    const open = new Set<http.ServerResponse>();
    server.on('request', (req, res) => {
      open.add(res);
      res.on('close', () => open.delete(res));
      if (drainFlag) {
        res.setHeader('Connection', 'close');
        res.on('finish', () => { res.socket?.end(); });
      }
      for (const handler of handlers) handler(req, res);
    });
    return open;
  };
  const wrapped: [http.Server, Set<http.ServerResponse>][] = [
    [gateway.forwardServer, wrapServer(gateway.forwardServer)],
    [gateway.adminServer, wrapServer(gateway.adminServer)],
  ];
  const stopAccepting = (server: http.Server): void => {
    // 只关 listening handle：fd 引用各减各的（监听口本体归 supervisor）；存活连接不受影响，
    // 'close' 事件照常在连接清零时由 net 层退出路径发出。
    const holder = server as unknown as { _handle?: { close(): void } | null };
    if (holder._handle) {
      holder._handle.close();
      holder._handle = null;
    }
  };
  const drain = (): void => {
    if (drained) return;
    drained = true;
    drainFlag = true;
    for (const [server, open] of wrapped) {
      stopAccepting(server);
      for (const res of open) res.on('finish', () => { res.socket?.end(); }); // 在途请求（含已出头的 SSE）收线
    }
    gateway.snapshots.stop();
    const timeoutMs = Number(process.env.CPR_DRAIN_TIMEOUT_MS ?? 30_000);
    const grace = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
    // 上限防线：先扫尾闲置连接（此刻才收，窗口最小化），稍候强切——强切语义=现状硬切（在途直接死）。
    const capTimer = setTimeout(() => {
      for (const [server] of wrapped) server.closeIdleConnections();
      setTimeout(() => process.exit(0), 200);
    }, grace);
    void Promise.all([once(gateway.forwardServer, 'close'), once(gateway.adminServer, 'close')]).then(() => {
      clearTimeout(capTimer);
      process.exit(0); // 连接清零：gateway 的 'close' 收尾（audit/snapshots/capture）已在前一步跑过
    }, () => { clearTimeout(capTimer); process.exit(0); });
  };
  // SIGTERM/SIGINT 与 supervisor 的 drain 指令同语义（排水而非硬死——旧形态无处理器即硬切，worker 形态升级）。
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
  // supervisor 死亡（IPC 通道 EOF）= 外壳没了：worker 排水退场（短上限），绝不留孤儿占着监听口
  // （否则重启的 supervisor bind 会 EADDRINUSE，systemd 兜底重启循环）。
  process.on('disconnect', () => {
    console.log('worker: supervisor 连接断开——排水退场（防孤儿占口）');
    const timeoutMs = Number(process.env.CPR_DRAIN_TIMEOUT_MS ?? 30_000);
    process.env.CPR_DRAIN_TIMEOUT_MS = String(Math.min(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000, 5_000));
    drain();
  });
  process.on('message', (msg: { act?: string; seq?: number; outcome?: SwapOutcome }) => {
    if (msg?.act === 'swap-result' && typeof msg.seq === 'number' && msg.outcome) {
      const resolve = pendingSwaps.get(msg.seq);
      if (resolve) {
        pendingSwaps.delete(msg.seq);
        resolve(msg.outcome);
      }
      return;
    }
    if (msg?.act === 'drain') return drain();
    if (msg?.act === 'promote') {
      gateway.setPolicyEventsQuiet(false); // 旧 worker 已退场：policy.reload 事件恢复落账
      console.log('worker: promoted——并存窗口结束，policy.reload 事件恢复落账');
    }
  });
}

try {
  if (process.argv.includes('--worker')) {
    await runWorker();
  } else {
    const boot = await loadPolicy();
    console.log(boot.sourceLine);
    const tenantNames = (boot.policy.tenants ?? []).map((tenant) => tenant.name);
    if (tenantNames.length) console.log(`tenants: ${tenantNames.join(', ')}`); // 鉴权按租户 key；缺 env 的租户在 authenticate 处自然 401，不在此拒启动
    await startGateway(boot.policy, { policyFile: boot.policyFile });
  }
} catch (error) {
  console.error(messageOf(error));
  process.exitCode = 1;
}
