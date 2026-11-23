// packages/cli/scripts/assemble.ts — 发布装配（prepack 自动跑）：把引擎与看板产物拷进本包，
// 发布物 = 自包含 npm 包（npm 仍只是下载器，包内布局与 v0.2.0 以来一致：core/ + static/ + scripts/ + vendor/）。
// 单一发布入口 = @ffrfree/llm-cpr：core 与 dashboard 是 private 内部包，不单独发 npm、不单独占版本号。
// 装配产物不进仓（.gitignore packages/cli/core|static），pack/publish 时现拷。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, '..', 'core');
for (const name of ['core', 'static'] as const) {
  const src = path.join(core, name);
  if (!fs.existsSync(src)) {
    console.error(`assemble: ${src} 不存在——monorepo 不完整，中止。`);
    process.exit(1);
  }
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.cpSync(src, path.join(root, name), { recursive: true });
  console.log(`assemble: packages/core/${name} → packages/cli/${name}`);
}
if (!fs.existsSync(path.join(root, 'core', 'main.ts')) || !fs.existsSync(path.join(root, 'static'))) {
  console.error('assemble: 装配后仍缺 core/main.ts 或 static/——中止，不要发布。');
  process.exit(1);
}
console.log('assemble: 发布物就绪（npm pack / npm publish 在本目录执行）。');
