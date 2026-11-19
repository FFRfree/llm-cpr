// v0.2.0 用户目录层（决策 ADR-0008）：用户一切文件落 ~/.llm-cpr 单目录——.env / data.db / backups / policy.ts。
// CPR_CONFIG_DIR / CPR_DATA_DIR 接缝保留（e2e fixture、本机迁移期覆盖用）；未覆盖时两者默认同为 ~/.llm-cpr。
// scripts/cpr.ts 为保持 CLI 自包含零依赖，并列复制了这两个默认值——改这里时同步那边。
import os from 'node:os';
import path from 'node:path';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CPR_CONFIG_DIR || path.join(os.homedir(), '.llm-cpr');
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CPR_DATA_DIR || path.join(os.homedir(), '.llm-cpr');
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), 'data.db');
}

export function envFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CPR_ENV_FILE || path.join(configDir(env), '.env');
}
