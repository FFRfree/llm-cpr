#!/usr/bin/env node
// 配置即代码：声明与策略 = lib/policy/mine.ts；坏声明在此拒绝启动（退出码 1）。
import { startGateway } from './http/server.ts';
import { validateConfig } from './policy/config.ts';
import Mine from './policy/mine.ts';

try {
  const policy = new Mine();
  validateConfig(policy);
  await startGateway(policy);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
