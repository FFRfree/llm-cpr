# 01 — policy.local.ts：本地 policy 文件机制

**Status:** completed

**目标：** 用户 policy 改动移出 git 跟踪范围，升级零冲突。这是 02-05 的地基。

## 做法

- 新增 `policy.example.ts`（tracked）：通用默认声明 + 注释指引（改 `name` 前先读 GLOSSARY「绝不改 name」口径），从不被代码加载。
- `.gitignore` 加 `/policy.local.ts`。
- `main.ts`：先 `await import('../policy.local.ts')`（相对 `lib/main.ts`），模块不存在（ERR_MODULE_NOT_FOUND）回落 `./policy/mine.ts`；拿到实例后 `validateConfig` 照旧，坏声明拒绝启动语义不变。
- `mine.ts` 本身不动语义（本机生产继续用）。

## 坑

- 动态 import 的相对路径按 `import.meta.url` 推算——main.ts 在 `lib/` 下，local 在仓库根，别算错一层（admin-dashboard 测试当年抓过同款错）。
- 类型检查：local 在 tsconfig include 外，启动时 validateConfig 兜底；是否把根加进 include 另行小取舍，本票先不加。

## 验收

- 无 local：行为与现状逐字节一致（全量 `node --test` 不变绿）。
- 有 local：加载 local；local 引用 `./lib/policy/contract.ts` 类型有补全（人工 + 一个 type 用例）。
- local 坏声明：启动退出码 1，报错指向 local 文件本身。
- `git status` 永远不显示 policy.local.ts；smoke-release 不受影响（release 目录无 local，走回落路径）。

## Comments

- 2026-11-18 落地于 `scripts/cpr.ts`（commit ce8bf5b）。实现与验收的差异：报错指向用 `${source}: <原报错>` 前缀实现（validateConfig 报错统一加文件名前缀）；tsconfig include 未扩（按票面取舍，local 文件靠启动校验兜底）。
- 验证：`node --test test/user-scripts.test.ts` 三条 main.ts 用例（回落 twin / local 优先 / 坏 local 拒启报 `policy.local.ts:`）全过；全量 `node --test` 119/119、`npm run typecheck` 干净。
- 没做的验证：真实 fork（改 lib）用户视角的手工路径未端到端跑过（测试是 fixture 替身）；type-tests 未覆盖 local 文件（include 外）。
