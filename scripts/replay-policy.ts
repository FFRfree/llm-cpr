#!/usr/bin/env node
// 策略回放 CLI（observability 票 02）：用捕获库的历史轮次离线沙盘 decide 改动。
// 全程只读（capture.db + data.db 都以 readOnly 打开）、不碰真实上游、不写账本。
//
// 用法：
//   node scripts/replay-policy.ts --capture-db <capture.db> --db <data.db> \
//     --policy <新策略.ts> [--baseline <旧策略.ts>，默认 core/policy/mine.ts] \
//     [--tenant main] [--since <ms|ISO>] [--until <ms|ISO>] [--limit N] [--json]
//
// policy 模块默认导出 class（配置即代码形态）或对象均可；回放只调 decide，不做鉴权。
// 时钟/快照/亲和等口径与已知近似见 core/observability/replay.ts 头注与报告尾注。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { replayPolicy, renderReplayReport } from '../core/observability/replay.ts';
import type { RouterPolicy } from '../core/policy/contract.ts';

function usage(): never {
  console.error('用法：node scripts/replay-policy.ts --capture-db <capture.db> --db <data.db> --policy <新策略.ts> [--baseline <旧策略.ts>] [--tenant main] [--since <ms|ISO>] [--until <ms|ISO>] [--limit N] [--json]');
  process.exit(1);
}

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

const captureDb = parseArg('--capture-db');
const ledgerDb = parseArg('--db');
const policyPath = parseArg('--policy');
if (!captureDb || !ledgerDb || !policyPath) usage();
// 基线默认 = 仓库根 core/policy/mine.ts（脚本自身位置推算，与 cwd 无关）。
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = parseArg('--baseline') ?? path.join(here, '..', 'core', 'policy', 'mine.ts');
const json = process.argv.includes('--json');
const timeArg = (name: string): number | undefined => {
  const raw = parseArg(name);
  if (raw === undefined) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && raw.trim() !== '') return numeric;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  console.error(`${name} 需要毫秒时间戳或 ISO 日期：${raw}`);
  process.exit(1);
};

async function loadPolicy(file: string): Promise<RouterPolicy> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`策略文件不存在：${resolved}`);
    process.exit(1);
  }
  const loaded = await import(pathToFileURL(resolved).href);
  const exported = loaded.default ?? loaded;
  // 默认导出 class（配置即代码形态）→ new；对象直接用。
  const policy = typeof exported === 'function' ? new (exported as new () => RouterPolicy)() : exported as RouterPolicy;
  if (typeof policy.decide !== 'function') {
    console.error(`${resolved}: 没有可调用的 decide——回放只测 decide，这个文件不适合当回放对象`);
    process.exit(1);
  }
  return policy;
}

try {
  const candidate = await loadPolicy(policyPath!);
  const baseline = await loadPolicy(baselinePath);
  const result = replayPolicy({
    captureDbFile: captureDb!,
    ledgerDbFile: ledgerDb!,
    baseline: { label: `baseline(${path.basename(baselinePath)})`, policy: baseline },
    candidate: { label: `candidate(${path.basename(policyPath!)})`, policy: candidate },
    tenant: parseArg('--tenant'),
    since: timeArg('--since'),
    until: timeArg('--until'),
    limit: parseArg('--limit') !== undefined ? Number(parseArg('--limit')) : undefined,
  });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${renderReplayReport(result)}\n`);
} catch (error) {
  console.error(`回放失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
