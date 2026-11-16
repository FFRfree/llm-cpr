import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend, Environment, Family, GatewayConfig, LoadedConfig, Model } from './contracts.ts';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const FAMILIES: readonly Family[] = ['ocg', 'ccg'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function portFrom(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer from 0 to 65535`);
  return port;
}

// Validation checks only what routing depends on; everything else stays optional.
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

export function loadConfig({ env = process.env, configFile }: { env?: Environment; configFile?: string } = {}): LoadedConfig {
  const filename = configFile || env.CPR_CONFIG_FILE || path.join(root, 'config.json');
  const raw: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const config = validateConfig(raw);
  if (config.identity_header !== undefined && (typeof config.identity_header !== 'string' || !config.identity_header.trim())) throw new Error('config.identity_header must be a non-empty header name when set');
  const forwardPort = portFrom(env.CPR_FORWARD_PORT, config.listen?.port ?? 8741, 'CPR_FORWARD_PORT');
  const adminPort = portFrom(env.CPR_ADMIN_PORT, config.admin?.port ?? 8740, 'CPR_ADMIN_PORT');
  return {
    ...config,
    backends: config.backends as Backend[],
    models: config.models as Model[],
    listen: { host: config.listen?.host || '127.0.0.1', port: forwardPort },
    admin: { host: config.admin?.host || '127.0.0.1', port: adminPort },
    masterKeyEnv: env.CPR_KEYS_ENV || config.master_key_env || 'CPR_MASTER_KEY',
    identityHeader: (config.identity_header || 'x-session-id').trim().toLowerCase(),
  };
}
