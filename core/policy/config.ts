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
  // 租户声明：name 是身份键（唯一、不改）；key_env 必填；backends/models 子集必须引用已声明的名字。
  // 声明了 tenants 就不再用 master_key_env 鉴权——每个能进门的调用方都必须有归属（含 main 租户显式写 CPR_MASTER_KEY）。
  if (config.tenants !== undefined) {
    if (!Array.isArray(config.tenants) || config.tenants.length === 0) throw new Error('config.tenants must be a non-empty array when set');
    const tenantNames = new Set<string>();
    const keyEnvs = new Set<string>();
    for (const [index, entry] of (config.tenants as unknown[]).entries()) {
      const tenant = record(entry);
      // 类型钉死：name/key_env 必须是非空字符串（`{}`/数组经 String() 都能骗过 truthy 检查），子集元素逐个验串。
      if (!tenant || typeof tenant.name !== 'string' || !tenant.name.trim() || typeof tenant.key_env !== 'string' || !tenant.key_env.trim()) throw new Error(`config.tenants[${index}] requires non-empty string name and key_env`);
      const name = tenant.name;
      if (name === 'default') throw new Error(`config.tenants[${index}].name must not be 'default' (reserved for the implicit no-tenants mode)`);
      if (tenantNames.has(name)) throw new Error(`duplicate tenant name: ${name}`);
      tenantNames.add(name);
      // 同一个 key_env 指两个租户：静态可判的凭据冲突（运行期 env 值相同由 createGatewayServers fail fast 兜底）。
      if (keyEnvs.has(tenant.key_env)) throw new Error(`duplicate tenant key_env: ${tenant.key_env} (shared by more than one tenant)`);
      keyEnvs.add(tenant.key_env);
      if (tenant.backends !== undefined) {
        if (!Array.isArray(tenant.backends) || tenant.backends.length === 0 || tenant.backends.some((backend) => typeof backend !== 'string' || !backend)) throw new Error(`config.tenants[${index}].backends must be a non-empty array of backend names when set`);
        for (const backend of tenant.backends) {
          if (!backendNames.has(backend)) throw new Error(`config.tenants[${index}].backends references unknown backend: ${backend}`);
        }
      }
      if (tenant.models !== undefined) {
        if (!Array.isArray(tenant.models) || tenant.models.length === 0 || tenant.models.some((model) => typeof model !== 'string' || !model)) throw new Error(`config.tenants[${index}].models must be a non-empty array of model ids when set`);
        for (const model of tenant.models) {
          if (!ids.has(model)) throw new Error(`config.tenants[${index}].models references unknown model: ${model}`);
        }
      }
      // 观测层 opt-in：开关必须显式布尔（'true'/'1' 这类字符串不收——配置即代码，宁可拒启动）。
      if (tenant.capture !== undefined && typeof tenant.capture !== 'boolean') throw new Error(`config.tenants[${index}].capture must be a boolean when set`);
    }
  }
  // 观测层全局参数：ttl_days / max_body_bytes 非负有限数；语义（0=关闭对应限制）见 contracts.ts。
  if (config.capture !== undefined) {
    const capture = record(config.capture);
    if (!capture) throw new Error('config.capture must be an object when set');
    for (const key of ['ttl_days', 'max_body_bytes'] as const) {
      const value = capture[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`config.capture.${key} must be a non-negative finite number`);
    }
    // 泄漏取证豁免清单（票 04）：必须是非空字符串数组。
    if (capture.privacy !== undefined) {
      const privacy = record(capture.privacy);
      if (!privacy) throw new Error('config.capture.privacy must be an object when set');
      if (privacy.extra_allow !== undefined && (!Array.isArray(privacy.extra_allow) || privacy.extra_allow.some((entry) => typeof entry !== 'string' || !entry))) {
        throw new Error('config.capture.privacy.extra_allow must be an array of non-empty strings when set');
      }
    }
  }
  // 决策面字段（原 PolicyStore 加载期校验，随 policy 内联并入启动校验）
  if (config.identity_header !== undefined && (typeof config.identity_header !== 'string' || !config.identity_header.trim())) throw new Error('identity_header must be a non-empty header name when set');
  if (config.decide !== undefined && typeof config.decide !== 'function') throw new Error('decide must be a function when set');
  // routing 数值参数：非有限/负数一律拒启动（server 侧另有兜底回落默认，直传实例的测试不经这里）。
  const routing = record(config.routing);
  if (routing) {
    for (const key of ['long_session_min_requests', 'snapshot_interval_ms', 'upstream_timeout_ms', 'rebind_cooldown_ms', 'migration_cooldown_ms', 'wall_retry_max_attempts', 'wall_retry_max_after_ms'] as const) {
      const value = routing[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`routing.${key} must be a non-negative finite number`);
    }
  }
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
