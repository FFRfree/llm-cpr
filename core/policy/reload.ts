// Policy 热加载器（工单 .scratch/policy-hot-reload/）：文件签名懒检查 + 坏文件保旧。
// 参照系（源码核实）：Hermes hermes_cli/config.py——每次用配置时比对文件签名，变了才重解析；
// 解析失败绝不静默回落默认而是保旧（last-known-good：回落默认会丢光用户覆盖项，注释引 #31188）。
// CPR 的 policy.ts 是带 decide 的代码文件，比 config.yaml 多两件事：
//   ① Node ESM 同 URL 只执行一次模块——重载必须 `?v=<sha256>` 破缓存（旧模块记录被 module map
//      钉住不释放；编辑低频、单实例 KB 级，接受，不做清理）；
//   ② 冷热分区——tenants/backends/capture 等字段在 createGatewayServers 启动时已拆走定型
//      （鉴权租户表、快照轮询器、capture 配置），这些字段热换只会造成「文件说了 A、进程跑着 B」
//      的裂缝，因此冷区有变更时整份拒绝热换（decide/routing 也不生效），提示重启。
// 错误语义：任何一步失败保旧不换，绝不回落内置 mine.ts（静默换内置 = 静默改路由，比保旧危险）。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { RouterPolicy } from './contract.ts';
import { validateConfig } from './config.ts';

// 冷区字段清单（唯一长期维护点）：contract 增加新声明字段时同步这里——
// 漏了会把「重启才生效」的字段静默热换掉。点路径支持（routing.snapshot_interval_ms 单独点出：
// routing 整体是热区，但该项启动时定型进快照轮询器）。
export const COLD_POLICY_FIELDS = [
  'backends', 'models', 'tenants', 'capture', 'listen', 'admin',
  'db_file', 'sessions_db', 'master_key_env', 'masterKeyEnv',
  'routing.snapshot_interval_ms',
] as const;

function readPath(obj: unknown, dotted: string): unknown {
  let node: unknown = obj;
  for (const key of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

// 冷区差异：按字段路径逐项比对（JSON 序列化口径）。advisory 门——序列化对键序敏感，
// 用户重排对象字面量可能误报差异，此时拒绝热换并提示重启是保守侧错误，可接受。
export function coldZoneDiff(a: RouterPolicy, b: RouterPolicy): string[] {
  const changed: string[] = [];
  for (const field of COLD_POLICY_FIELDS) {
    const left = JSON.stringify(readPath(a, field) ?? null);
    const right = JSON.stringify(readPath(b, field) ?? null);
    if (left !== right) changed.push(field);
  }
  return changed;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export type ReloadTrigger = 'file-change' | 'manual';

export type ReloadOutcome =
  | { kind: 'unchanged' }
  // 换新成功：backupPath/backupError 只在配置了 backupDir 时出现；备份失败不拦换新。
  | { kind: 'reloaded'; fromHash: string | null; toHash: string; backupPath?: string; backupError?: string }
  | {
      kind: 'kept';
      reason: 'load-failed' | 'cold-zone-change' | 'file-missing';
      error: string;            // 摘要（截断，不含文件全文——防密钥进日志/账本）
      coldChanged?: string[];   // 仅 cold-zone-change
      // 同一内容签名的失败已报过（文件没再变）：调用方据此跳过事件/日志，防坏文件每请求刷屏。
      deduped?: boolean;
    };

export interface PolicyStatus {
  source: string | null;      // null = builtin（无文件热更新）
  sha256: string | null;      // 当前生效声明的文件哈希
  loadedAt: number | null;
  reloads: number;            // 成功热换次数（不含启动首次加载）
  failedReloads: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastColdChanged: string[] | null; // 最近一次冷区拒绝的差异清单
}

export interface PolicyReloader {
  readonly file: string | null;
  current(): RouterPolicy;
  status(): PolicyStatus;
  maybeReload(trigger: ReloadTrigger): Promise<ReloadOutcome>;
}

interface ReloadOptions {
  policy: RouterPolicy;            // 启动时已加载并 validate 过的实例（首个 current）
  policyFile?: string;             // undefined = builtin：maybeReload 恒 unchanged
  validate?: (raw: unknown) => unknown; // 缺省 validateConfig
  backupDir?: string;              // 成功换新时拷一份声明快照（审计「当时跑的是哪份文件」）
  now?: () => number;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const ERROR_SUMMARY_MAX = 400;

// 文件签名：mtimeMs + size。同毫秒等长改写理论可漏检，两元素同时撞上的概率对「人手改配置」
// 频率可忽略（Hermes 用四元组同思路）；size 进签名已天然覆盖绝大多数测试与真实编辑。
function fileSig(file: string): string {
  const stat = fs.statSync(file);
  return `${stat.mtimeMs}:${stat.size}`;
}

export function createPolicyReloader({ policy, policyFile, validate = validateConfig, backupDir, now = Date.now }: ReloadOptions): PolicyReloader {
  let current = policy;
  // loadedSig = 当前生效实例对应的文件签名；attemptSig = 最近一次尝试（含失败）的签名——
  // 失败后签名不变则跳过重试（不重读不重报）；文件再变（attemptSig 变新）自然重试。
  let loadedSig: string | null = null;
  let attemptSig: string | null = null;
  let lastFailureSig: string | null = null;
  let missingReported = false;
  const status: PolicyStatus = {
    source: policyFile ?? null, sha256: null, loadedAt: null, reloads: 0, failedReloads: 0,
    lastError: null, lastErrorAt: null, lastColdChanged: null,
  };
  if (policyFile) {
    try {
      loadedSig = fileSig(policyFile);
      status.sha256 = sha256File(policyFile);
      status.loadedAt = now();
    } catch { /* 启动后文件即被删/不可读：维持 builtin 实例，后续触发按文件缺失口径报 */ }
  }

  const kept = (reason: 'load-failed' | 'cold-zone-change' | 'file-missing', error: string, sig: string | null, coldChanged?: string[]): ReloadOutcome => {
    status.failedReloads += 1;
    status.lastError = error;
    status.lastErrorAt = now();
    if (coldChanged) status.lastColdChanged = coldChanged;
    lastFailureSig = sig;
    return coldChanged ? { kind: 'kept', reason, error, coldChanged } : { kind: 'kept', reason, error };
  };

  const run = async (trigger: ReloadTrigger): Promise<ReloadOutcome> => {
    void trigger; // trigger 只进审计事件（server 侧），加载流程对两种来源同径
    if (!policyFile) return { kind: 'unchanged' };
    let sig: string;
    try { sig = fileSig(policyFile); } catch (error) {
      // stat 失败：ENOENT = 文件被删（保旧，一次性报）；其他（权限等）按读取失败处理。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const deduped = missingReported;
        missingReported = true;
        if (deduped) return { kind: 'kept', reason: 'file-missing', error: 'policy file removed; keeping last loaded policy', deduped: true };
        return kept('file-missing', 'policy file removed; keeping last loaded policy', null);
      }
      const deduped = lastFailureSig === 'stat-error';
      lastFailureSig = 'stat-error';
      if (deduped) return { kind: 'kept', reason: 'load-failed', error: `stat failed: ${messageOf(error)}`, deduped: true };
      return kept('load-failed', `stat failed: ${messageOf(error)}`, 'stat-error');
    }
    missingReported = false;
    if (sig === loadedSig) return { kind: 'unchanged' };
    if (sig === attemptSig && lastFailureSig === sig) {
      // 同一坏文件重复触发：不重试不重报（server 侧靠 deduped 跳过事件）。
      return { kind: 'kept', reason: 'load-failed', error: status.lastError ?? 'previous load failed', deduped: true };
    }
    attemptSig = sig;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(policyFile); } catch (error) {
      return kept('load-failed', `read failed: ${messageOf(error)}`, sig);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    let candidate: unknown;
    try {
      // 破缓存：同 URL 的 ESM 模块只执行一次，查询参数用内容哈希保证「同内容不重复实例化、
      // 改了内容必是新记录」。
      const mod = (await import(`${pathToFileURL(policyFile).href}?v=${hash}`)) as { default?: unknown };
      if (typeof mod.default !== 'function') throw new Error('policy file must export a default class');
      candidate = new (mod.default as new () => unknown)();
    } catch (error) {
      return kept('load-failed', `${policyFile}: ${messageOf(error)}`.slice(0, ERROR_SUMMARY_MAX), sig);
    }
    try { validate(candidate); } catch (error) {
      return kept('load-failed', `${policyFile}: ${messageOf(error)}`.slice(0, ERROR_SUMMARY_MAX), sig);
    }
    const coldChanged = coldZoneDiff(current, candidate as RouterPolicy);
    if (coldChanged.length > 0) {
      return kept('cold-zone-change', `cold-zone fields changed (restart required): ${coldChanged.join(', ')}`, sig, coldChanged);
    }
    let backupPath: string | undefined;
    let backupError: string | undefined;
    if (backupDir) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${backupDir}/${stamp}-${hash.slice(0, 8)}.ts`;
        fs.copyFileSync(policyFile, backupPath);
      } catch (error) { backupError = messageOf(error); } // 备份失败不拦换新
    }
    const fromHash = status.sha256;
    current = candidate as RouterPolicy;
    loadedSig = sig;
    lastFailureSig = null;
    status.sha256 = hash;
    status.loadedAt = now();
    status.reloads += 1;
    return { kind: 'reloaded', fromHash, toHash: hash, ...(backupPath ? { backupPath } : {}), ...(backupError ? { backupError } : {}) };
  };

  let inflight: Promise<ReloadOutcome> | null = null;
  return {
    file: policyFile ?? null,
    current: () => current,
    status: () => ({ ...status, ...(status.lastColdChanged ? { lastColdChanged: status.lastColdChanged } : {}) }),
    // 并发合流：重载进行中（async import）后到者复用同一 Promise；首个触发者的 trigger 生效。
    maybeReload(trigger: ReloadTrigger): Promise<ReloadOutcome> {
      if (inflight) return inflight;
      inflight = run(trigger).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
