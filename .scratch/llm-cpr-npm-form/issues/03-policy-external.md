# 03 policy 加载点外置 ~/.cpr/policy.ts

Status: completed
Blocked by: 02

## 验收

- [x] 加载顺序：`~/.cpr/policy.ts` 存在则优先，否则内置 `core/policy/mine.ts`；local 存在但 import 失败一律原样抛（不静默回落——沿 v0.1.0 纪律）。
- [x] `~/.cpr/policy.example.ts` 模板由 `cpr install` 落盘；`~/.cpr/tsconfig.json` 指路类型补全（paths 'llm-cpr' → 包内 contract）。
- [x] 启动日志报 policy 来源与版本可见性。
- [x] 测试：local 优先 / 缺失回落 / 坏 local 拒启动（validateConfig 报错带来源前缀）。

## Comments

- commit 6b98048：`main.ts` 加载序改 `configDir()/policy.ts` 优先回落内置；install 落 policy 三件套（模板/policy.ts 真身/tsconfig 指路，幂等不重置既有文件）；`policy.example.ts` import 改 `'llm-cpr'` 并纳入仓 tsconfig paths+include（模板受静态门约束）；仓库根 policy.local.ts 机制整体退役（main.ts 不再读、.gitignore 行删除）。
- 验证：`npm run typecheck` 0 错；`node --test` 140/140（install 三件套断言、幂等、local 优先/回落/坏 local 拒启三例重写为 ~/.cpr 语义，bootMain 的 `...extra` 收尾以允许测试覆盖 CPR_CONFIG_DIR）。
- 没做的验证：npm 全局安装形态下 tsconfig paths 指向全局包路径（05/06 号票落地后 e2e 实测；clone 形态指向仓库根）。
