// packages/dashboard/build.ts — 看板构建：src/（唯一正本）→ packages/core/static/（管理口分发目录）。
// 当前页面形态 = 无构建静态页（源码即产物，build = 原样拷贝）；将来 React/Vite 源码住进 src/
// 后，这里换成 vite build（vite-plugin-singlefile 单文件产物），core 侧与 cli 装配零改动。
// 产物随源码一起 commit（单人仓不跑 CI 的既定约定）；test/dashboard-sync.test.ts 守两边一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dest = path.join(here, '..', 'core', 'static');
if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('dashboard: src/index.html 不存在——源码目录不完整，中止。');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`dashboard: src → ../core/static（${fs.readdirSync(dest).length} 项）`);
