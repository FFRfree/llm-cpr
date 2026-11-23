// vendor 机制回归（ADR-0010）：vendoredDependencies 声明 ↔ vendor/ 落盘一致、#别名接缝可达、
// dependencies 红线恒空（cpr.js bootstrap 会清掉 npm 落的依赖目录，运行时依赖只准走 vendor）。
// 本测试住 packages/cli/test——#pc 接缝（imports 字段）与 vendor/ 都是 cli 包的所有物。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  vendoredDependencies?: string[];
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
};

test('vendor：dependencies 恒空（bootstrap 红线，ADR-0010）', () => {
  assert.equal(pkg.dependencies, undefined, 'package.json 出现 dependencies 会装上即被 cpr.js bootstrap 删除——第三方代码只准走 vendor');
});

test('vendor：vendoredDependencies 每项都在 devDependencies 声明版本、vendor/ 落盘带 LICENSE', () => {
  for (const name of pkg.vendoredDependencies ?? []) {
    assert.ok(pkg.devDependencies[name], `${name} 必须在 devDependencies 声明版本（唯一正本）`);
    const vendored = path.join(root, 'vendor', name);
    assert.ok(fs.existsSync(path.join(vendored, 'package.json')), `vendor/${name} 缺落盘——跑 npm run vendor 重建`);
    assert.ok(
      fs.readdirSync(vendored).some((f) => f.toUpperCase().startsWith('LICENSE')),
      `vendor/${name} 缺 LICENSE 文本（开源许可证合规）`,
    );
  }
});

test('vendor：#别名 经 package.json imports 可达且导出可用', async () => {
  // picocolors 是 CJS（module.exports = createColors()），命名导出探测不到——必须走 default
  // （cpr.ts 同款姿势）；命名空间导入只拿得到 default，拿不到 red/green。
  const mod = await import('#pc');
  const pc = (mod.default ?? mod) as { red: (s: string) => string; green: (s: string) => string };
  assert.equal(typeof pc.red, 'function');
  assert.equal(typeof pc.green, 'function');
  assert.ok(pc.green('x').includes('x'), '着色函数应回传原文（纯文本或 ANSI 包裹）');
});
