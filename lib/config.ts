import type { Family, GatewayConfig } from './contracts.ts';

const FAMILIES: readonly Family[] = ['ocg', 'ccg'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// 校验的是「声明」：policy 实例（或任何对象）的 backends/models 必填字段、唯一键、URL 合法性。
// 只在文件加载路径调用（PolicyStore）；测试直传的静态实例不校验。
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
  return config as unknown as GatewayConfig;
}
