// dashboard 构建产物一致性守卫：packages/dashboard/src 是唯一正本，packages/core/static 是 build 产物
// （两边都随源码 commit）。改了 src 忘跑 build = 这里的文件级 diff 会红——跑 npm run build -w @ffrfree/llm-cpr-dashboard。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'dashboard', 'src');
const built = path.resolve(here, '..', 'static');

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))],
  );
}

test('dashboard：src（正本）与 core/static（build 产物）文件清单一致', () => {
  const srcFiles = walk(src).sort();
  const builtFiles = walk(built).sort();
  assert.deepEqual(builtFiles, srcFiles, '产物清单与正本不一致——跑 npm run build -w @ffrfree/llm-cpr-dashboard');
});

test('dashboard：src↔static 逐文件字节一致', () => {
  for (const rel of walk(src)) {
    const a = fs.readFileSync(path.join(src, rel));
    const b = fs.readFileSync(path.join(built, rel));
    assert.ok(a.equals(b), `static/${rel} 与 src 正本不一致——跑 npm run build -w @ffrfree/llm-cpr-dashboard`);
  }
});
