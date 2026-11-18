import type { Endpoint, Environment, Family, GatewayConfig } from '../contracts.ts';
import type { RouterPolicy } from './contract.ts';

const FAMILIES: readonly Family[] = ['ocg', 'ccg'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// 校验「声明」：policy 实例（或任何对象）的 backends/models 必填字段、唯一键、URL 合法性。
// 配置即代码：启动路径（main.ts）调用它拒绝坏声明；测试直传的实例不经过这里（保持宽容口径）。
export function validateConfig(raw: unknown): GatewayConfig {
  const config = record(raw);
  if (!config || !Array.isArray(config.backends) || config.backends.length === 0) throw new Error('config.backends must contain at least one backend');
  if (!Array.isArray(config.models) || config.models.length === 0) throw new Error('config.models must contain at least one model');
  const backendNames = new Set<string>();
  for (const [index, entry] of (config.backends as unknown[]).entries()) {
    const backend = record(entry);
    if (!backend || !backend.name || !FAMILIES.includes(backend.family as Family) || !backend.base_url || !backend.key_env) {
      throw new Error(`config.backends[${index}] requires name, family (ocg|ccg), base_url and key_env`);
    }
    const name = String(backend.name);
    if (backendNames.has(name)) throw new Error(`duplicate backend name: ${name}`);
    backendNames.add(name);
    try { new URL(String(backend.base_url)); } catch { throw new Error(`config.backends[${index}].base_url must be an absolute URL`); }
  }
  const ids = new Set<string>();
  for (const [index, entry] of (config.models as unknown[]).entries()) {
    const model = record(entry);
    if (!model || !model.id || !record(model.backends)) throw new Error(`config.models[${index}] requires id and backends mapping`);
    const id = String(model.id);
    if (ids.has(id)) throw new Error(`duplicate model id: ${id}`);
    ids.add(id);
  }
  // 决策面字段（原 PolicyStore 加载期校验，随 policy 内联并入启动校验）
  if (config.identity_header !== undefined && (typeof config.identity_header !== 'string' || !config.identity_header.trim())) throw new Error('identity_header must be a non-empty header name when set');
  if (config.decide !== undefined && typeof config.decide !== 'function') throw new Error('decide must be a function when set');
  return config as unknown as GatewayConfig;
}

function portFrom(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer from 0 to 65535`);
  return port;
}

// 启动监听端点：声明 + 环境覆盖（原 policy-loader 导出，随其退役移入此处）。
export function resolveListenEndpoints(policy: RouterPolicy, env: Environment): { listen: Endpoint; admin: Endpoint } {
  return {
    listen: { host: policy.listen?.host || '127.0.0.1', port: portFrom(env.CPR_FORWARD_PORT, policy.listen?.port ?? 8741, 'CPR_FORWARD_PORT') },
    admin: { host: policy.admin?.host || '127.0.0.1', port: portFrom(env.CPR_ADMIN_PORT, policy.admin?.port ?? 8740, 'CPR_ADMIN_PORT') },
  };
}
