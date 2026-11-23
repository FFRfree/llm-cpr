// scripts/vendor.ts — 第三方运行时依赖的 vendor 落盘器（ADR-0010）。
// 为什么 vendor 而不打 bundle：发布物保持可读可审计（依赖原始源码 + LICENSE 原样随包，
// 用户拿到的每个字节都能直接读），仓库零构建贯彻到发布；代价是升级依赖要手动重跑本脚本。
// 约定：依赖版本号唯一正本 = package.json devDependencies；vendor/ 只是它的落盘副本，
// 清单 = package.json vendoredDependencies，`npm run vendor` 全量重建。
// 接缝：业务代码一律经 package.json "imports" 的 #别名 引用（如 `#pc`），绝不写 vendor/ 深路径——
// 目录挪动或将来换 esbuild（依赖涨到 4-5 个/活库/原生扩展时）业务代码零改动。
// 红线：dependencies 必须恒为空 —— cpr.js bootstrap 把包搬离 node_modules 后会清掉 npm 落的
// lib/，运行时依赖装上即被删；第三方代码只准走 vendor 这一条通道（test/vendor.test.ts 守着）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// node_modules 自 root 起逐级向上找：monorepo 里依赖被 npm hoist 到仓库根，独立包里就在脚下。
function nodeModulesDir(): string {
  let dir = root;
  for (;;) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(nm)) return nm;
    const up = path.dirname(dir);
    if (up === dir) {
      console.error('vendor: 找不到 node_modules——先 npm install（版本以 devDependencies 声明为准）。');
      process.exit(1);
    }
    dir = up;
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  vendoredDependencies?: string[];
};

const deps = pkg.vendoredDependencies ?? [];
if (deps.length === 0) {
  console.log('vendor: vendoredDependencies 为空，无事可做。');
  process.exit(0);
}

fs.rmSync(path.join(root, 'vendor'), { recursive: true, force: true });
const nm = nodeModulesDir();
for (const name of deps) {
  const src = path.join(nm, name);
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    console.error(`vendor: ${name} 不在 node_modules —— 先 npm install（版本以 devDependencies 声明为准）。`);
    process.exit(1);
  }
  fs.cpSync(src, path.join(root, 'vendor', name), { recursive: true, dereference: true });
  const version = JSON.parse(fs.readFileSync(path.join(root, 'vendor', name, 'package.json'), 'utf8')) as { version: string };
  console.log(`vendor: ${name}@${version.version} → vendor/${name}`);
}
