#!/usr/bin/env node
// scripts/cpr.js — bootstrap 引导器（纯 ESM JS、零依赖）。
// 为什么存在：Node 拒绝对 node_modules 路径下的 .ts 做类型擦除（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，
// 2026-11-19 本机 Node v22.22.3 实测，工单 12）——npm/npx 的一切落盘都在 node_modules 里，.ts 入口在那里跑不起来。
// 所以包的 bin 是这个 .js：它负责把包搬离 node_modules（versions/<v>/app），再从那里拉起真正的 .ts CLI。
// 接缝：CPR_NPM（npm 路径）、CPR_APP_ROOT（安装区，fixture 钉 tmp）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@ffrfree/llm-cpr';
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '');
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`cpr: 包内版本号不合法：${version}`);
  process.exit(1);
}
const appRoot = process.env.CPR_APP_ROOT || path.join(os.homedir(), '.local', 'lib', 'llm-cpr');
const npmBin = process.env.CPR_NPM || 'npm';
const appDir = path.join(appRoot, 'versions', version, 'app');

if (!fs.existsSync(path.join(appDir, 'scripts', 'cpr.ts'))) {
  // bootstrap：npm 只当下载器 → 搬离 node_modules → 版本内建 bin 软链 → 从 app/ 拉起 .ts。
  const prefix = path.join(appRoot, 'versions', version);
  fs.rmSync(appDir, { recursive: true, force: true });
  console.log(`cpr: bootstrap ${PKG}@${version} → ${prefix}`);
  const install = spawnSync(npmBin, ['install', '-g', '--prefix', prefix, `${PKG}@${version}`], { stdio: 'inherit' });
  if (install.status !== 0) {
    console.error(`cpr: npm 下载失败（exit ${install.status}）——未做任何改动。`);
    process.exit(1);
  }
  const src = path.join(prefix, 'lib', 'node_modules', PKG);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    console.error(`cpr: npm 声称装好但 ${src} 缺包——prefix 落点异常，中止。`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  fs.renameSync(src, appDir); // 搬离 node_modules：rename 原子，路径里不再有 node_modules，.ts 才能跑
  fs.rmSync(path.join(prefix, 'lib'), { recursive: true, force: true }); // npm 落盘的空壳与指向旧地址的 bin 软链一并清掉
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.rmSync(path.join(prefix, 'bin', 'cpr'), { force: true }); // npm 自建的那条指向 node_modules 旧地址，作废重指
  fs.symlinkSync('../app/scripts/cpr.js', path.join(prefix, 'bin', 'cpr'), 'file'); // 指向 JS 引导器：不依赖 .ts 带 +x 位，且任何环境都能跑
  console.log(`cpr: 引擎就位 ${appDir}（已搬离 node_modules）`);
}

const child = spawnSync(process.execPath, [path.join(appDir, 'scripts', 'cpr.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(child.status === null ? 1 : child.status);
