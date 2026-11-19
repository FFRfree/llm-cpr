#!/usr/bin/env node
// 配置即代码：声明与策略 = policy.local.ts（用户自定义，gitignored）或 core/policy/mine.ts（仓库默认）。
// 存在 policy.local.ts 则优先；坏声明在此拒绝启动（退出码 1）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startGateway } from './http/server.ts';
import { validateConfig } from './policy/config.ts';
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
  const localUrl = new URL('../policy.local.ts', import.meta.url);
  const source = fs.existsSync(localUrl) ? 'policy.local.ts' : 'core/policy/mine.ts';
  // 动态 import 用变量路径：文件存在与否已用 existsSync 判定，import 失败（语法错/坏 import）一律原样抛。
  const loaded = source === 'policy.local.ts'
    ? await import(localUrl.href)
    : await import('./policy/mine.ts');
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
