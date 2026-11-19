#!/usr/bin/env node
// 配置即代码（v0.2.0）：声明与策略 = ~/.cpr/policy.ts（用户真身，CPR_CONFIG_DIR 接缝可挪）或 core/policy/mine.ts（内置默认）。
// 存在 ~/.cpr/policy.ts 则优先；坏声明在此拒绝启动（退出码 1）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './http/server.ts';
import { validateConfig } from './policy/config.ts';
import { configDir, envFile } from './paths.ts';
import { loadDotEnv } from './envfile.ts';
import type { RouterPolicy } from './policy/contract.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 版本可见性：release 目录读 RELEASE.txt 的 commit=；clone 里 spawn git；都没有报 unknown。
function bootVersion(): string {
  try {
    const match = /commit=(\S+)/.exec(fs.readFileSync(new URL('../RELEASE.txt', import.meta.url), 'utf8'));
    if (match) return match[1];
  } catch { /* clone 场景没有 RELEASE.txt */ }
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  return result.status === 0 ? (result.stdout ?? '').trim() : 'unknown';
}

try {
  // v0.2.0：引擎自己加载 ~/.cpr/.env（前台直跑无 systemd 时也能拿到密钥）；CPR_ENV_FILE 接缝优先
  // （与探针脚本同语义），只填缺失键不覆盖真实环境变量。systemd 场景 EnvironmentFile 先到、此处成无害重复。
  const envPath = envFile();
  if (fs.existsSync(envPath)) {
    const loadedKeys = loadDotEnv(envPath);
    if (loadedKeys > 0) console.log(`env: ${envPath}（${loadedKeys} 键）`);
  }
  const localPath = path.join(configDir(), 'policy.ts');
  const source = fs.existsSync(localPath) ? localPath : 'core/policy/mine.ts';
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
  console.log(`llm-cpr ${bootVersion()} — policy: ${source}`);
  const tenantNames = (policy.tenants ?? []).map((tenant) => tenant.name);
  if (tenantNames.length) console.log(`tenants: ${tenantNames.join(', ')}`); // 鉴权按租户 key；缺 env 的租户在 authenticate 处自然 401，不在此拒启动
  await startGateway(policy);
} catch (error) {
  console.error(messageOf(error));
  process.exitCode = 1;
}
