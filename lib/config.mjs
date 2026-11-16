import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function portFrom(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer from 0 to 65535`);
  return port;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.backends) || raw.backends.length === 0) throw new Error('config.backends must contain at least one backend');
  if (!Array.isArray(raw.models) || raw.models.length === 0) throw new Error('config.models must contain at least one model');
  for (const [index, backend] of raw.backends.entries()) {
    if (!backend.name || !['ocg', 'ccg'].includes(backend.family) || !backend.base_url || !backend.key_env) throw new Error(`config.backends[${index}] requires name, family (ocg|ccg), base_url and key_env`);
    try { new URL(backend.base_url); } catch { throw new Error(`config.backends[${index}].base_url must be an absolute URL`); }
  }
  const ids = new Set();
  for (const [index, model] of raw.models.entries()) {
    if (!model.id || !model.backends || typeof model.backends !== 'object') throw new Error(`config.models[${index}] requires id and backends mapping`);
    if (ids.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  return raw;
}

export function loadConfig({ env = process.env, configFile } = {}) {
  const filename = configFile || env.CPR_CONFIG_FILE || path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
  validateConfig(raw);
  if (raw.identity_header !== undefined && (typeof raw.identity_header !== 'string' || !raw.identity_header.trim())) throw new Error('config.identity_header must be a non-empty header name when set');
  const forwardPort = portFrom(env.CPR_FORWARD_PORT, raw.listen?.port ?? 8741, 'CPR_FORWARD_PORT');
  const adminPort = portFrom(env.CPR_ADMIN_PORT, raw.admin?.port ?? 8740, 'CPR_ADMIN_PORT');
  return {
    ...raw,
    listen: { host: raw.listen?.host || '127.0.0.1', port: forwardPort },
    admin: { host: raw.admin?.host || '127.0.0.1', port: adminPort },
    masterKeyEnv: env.CPR_KEYS_ENV || raw.master_key_env || 'CPR_MASTER_KEY',
    identityHeader: (raw.identity_header || 'x-session-id').trim().toLowerCase(),
  };
}
