#!/usr/bin/env node
// 配置即代码（v0.2.0）：声明与策略 = ~/.llm-cpr/policy.ts（用户真身，CPR_CONFIG_DIR 接缝可挪）或 core/policy/mine.ts（内置默认）。
// 存在 ~/.llm-cpr/policy.ts 则优先；坏声明在此拒绝启动（退出码 1）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startGateway } from './http/server.ts';
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

try {
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
  console.log(`llm-cpr ${bootVersion()} — policy: ${source}${fileHash}`);
  const tenantNames = (policy.tenants ?? []).map((tenant) => tenant.name);
  if (tenantNames.length) console.log(`tenants: ${tenantNames.join(', ')}`); // 鉴权按租户 key；缺 env 的租户在 authenticate 处自然 401，不在此拒启动
  await startGateway(policy, { policyFile: fromFile ? localPath : undefined });
} catch (error) {
  console.error(messageOf(error));
  process.exitCode = 1;
}
