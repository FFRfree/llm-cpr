// PolicyStore：policy 文件的加载、校验与 mtime 热重载。
// 启动时首次加载失败 → current() 抛错 → 进程拒绝启动（Q2）；
// 运行中重载失败 → 保留旧实例 + 记 lastError（Q5）。
// 静态实例（测试直传）不走校验——reliability 口径：空声明构造网关不得抛错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from './config.ts';
import type { RouterPolicy } from './policy-contract.ts';
import type { Endpoint, Environment, Logger } from './contracts.ts';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
export const DEFAULT_POLICY_FILE = path.join(root, 'policy.ts');

export interface PolicyMeta {
  file: string;
  // 当前生效实例的来源文件 mtime（首次加载前为 null）。
  mtimeMs: number | null;
  loadedAt: number | null;
  lastError: string | null;
  source: 'file' | 'static';
}

export interface PolicySource {
  current(): Promise<RouterPolicy>;
  meta(): PolicyMeta;
}

function portFrom(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer from 0 to 65535`);
  return port;
}

// 启动监听端点：policy 声明 + 环境覆盖（与 config 时代口径一致）。
export function resolveListenEndpoints(policy: RouterPolicy, env: Environment): { listen: Endpoint; admin: Endpoint } {
  return {
    listen: { host: policy.listen?.host || '127.0.0.1', port: portFrom(env.CPR_FORWARD_PORT, policy.listen?.port ?? 8741, 'CPR_FORWARD_PORT') },
    admin: { host: policy.admin?.host || '127.0.0.1', port: portFrom(env.CPR_ADMIN_PORT, policy.admin?.port ?? 8740, 'CPR_ADMIN_PORT') },
  };
}

export class PolicyStore implements PolicySource {
  readonly file: string;
  #logger: Logger;
  #now: () => number;
  #loaded: RouterPolicy | null = null;
  #mtimeMs: number | null = null;
  #loadedAt: number | null = null;
  #lastError: string | null = null;
  #inflight: Promise<RouterPolicy> | null = null;

  constructor({ file, logger = console, now = Date.now }: { file?: string; logger?: Logger; now?: () => number } = {}) {
    this.file = file || process.env.CPR_POLICY_FILE || DEFAULT_POLICY_FILE;
    this.#logger = logger;
    this.#now = now;
  }

  meta(): PolicyMeta {
    return { file: this.file, mtimeMs: this.#mtimeMs, loadedAt: this.#loadedAt, lastError: this.#lastError, source: 'file' };
  }

  current(): Promise<RouterPolicy> {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = `policy file unavailable: ${message}`;
      if (this.#loaded) return Promise.resolve(this.#loaded);
      return Promise.reject(new Error(this.#lastError));
    }
    if (this.#loaded && mtimeMs === this.#mtimeMs) return Promise.resolve(this.#loaded);
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#reload(mtimeMs).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  // ?mtime= 绕过 ESM 模块缓存：文件每次变更都拿到全新实例（实例身份 = 版本号，
  // server 用它判断要不要重建派生状态）。policy 是单文件：import 辅助文件的变更不触发重载。
  async #reload(mtimeMs: number): Promise<RouterPolicy> {
    try {
      const mod = await import(`${pathToFileURL(this.file).href}?mtime=${mtimeMs}`);
      const exported = (mod as { default?: unknown }).default;
      if (typeof exported !== 'function') throw new Error('policy file must default-export a class');
      const instance = new (exported as new () => unknown)();
      validateConfig(instance);
      const policy = instance as RouterPolicy;
      if (policy.identity_header !== undefined && (typeof policy.identity_header !== 'string' || !policy.identity_header.trim())) throw new Error('policy.identity_header must be a non-empty header name when set');
      if (policy.decide !== undefined && typeof policy.decide !== 'function') throw new Error('policy.decide must be a function');
      this.#loaded = policy;
      this.#mtimeMs = mtimeMs;
      this.#loadedAt = this.#now();
      this.#lastError = null;
      return policy;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = message;
      if (!this.#loaded) throw new Error(`policy load failed: ${message}`);
      this.#logger.warn?.(`[policy] reload failed, keeping previous instance: ${message}`);
      return this.#loaded;
    }
  }
}

// 测试/嵌入场景：实例直传，永不重载，不校验（保持 config 时代 createGatewayServers 的宽容口径）。
export class StaticPolicyStore implements PolicySource {
  #policy: RouterPolicy;
  constructor(policy: RouterPolicy) { this.#policy = policy; }
  meta(): PolicyMeta { return { file: 'static', mtimeMs: null, loadedAt: null, lastError: null, source: 'static' }; }
  current(): Promise<RouterPolicy> { return Promise.resolve(this.#policy); }
}
