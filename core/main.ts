#!/usr/bin/env node
// 配置即代码（v0.2.0）：声明与策略 = ~/.llm-cpr/policy.ts（用户真身，CPR_CONFIG_DIR 接缝可挪）或 core/policy/mine.ts（内置默认）。
// 存在 ~/.llm-cpr/policy.ts 则优先；坏声明在此拒绝启动（退出码 1）。
// 两种运行形态（supervisor-upgrade spec）：
//   直跑（systemd ExecStart 直指本文件 / 测试）：自 bind 两监听口——v0.6.0 前的形态，行为不变。
//   --worker（supervisor 形态）：不自 bind，经 IPC 收 supervisor 交接的监听 handle（8741/8740 两个），
//   开库成功 + 两口就绪后发 `ready`（pm2 wait_ready 同义）；快照轮询等 ready 后才开（防并存窗口双跑）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGateway, type Gateway } from './http/server.ts';
import { validateConfig } from './policy/config.ts';
import { sha256File } from './policy/reload.ts';
import { configDir, envFile } from './paths.ts';
import { loadDotEnv } from './envfile.ts';
import type { RouterPolicy } from './policy/contract.ts';

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

// --worker 模式（supervisor-upgrade 票 01）：收两口 handle → 起网关（不自 bind）→ 发 ready → 开快照轮询。
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
  const gateway: Gateway = await startGateway(boot.policy, {
    policyFile: boot.policyFile,
    listenHandles: handles,
    deferSnapshots: true,
  });
  // 就绪 = 开库成功 + 两口接管完成：此刻才发 ready（pm2 wait_ready 同义）——开库失败会走 catch
  // 原样退出（退出码 1），supervisor 侧可见「没就绪就退出」。
  const readyDelay = Number(process.env.CPR_WORKER_READY_DELAY_MS ?? 0);
  if (Number.isFinite(readyDelay) && readyDelay > 0) await new Promise((resolve) => setTimeout(resolve, readyDelay));
  process.send?.({ act: 'ready', version: bootVersion(), dbFile: gateway.dbPath });
  gateway.startSnapshots();
  // supervisor 死亡（IPC 通道 EOF）= 外壳没了：worker 立即退场，绝不留孤儿占着监听口
  // （否则重启的 supervisor bind 会 EADDRINUSE，systemd 兜底重启循环）。在途请求硬切 = 现状硬切语义。
  process.on('disconnect', () => { process.exit(0); });
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
