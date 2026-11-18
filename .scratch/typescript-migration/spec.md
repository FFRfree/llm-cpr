# Spec: 全仓 TypeScript 迁移（coding-plan-router）

**Status:** completed
**日期:** 2026-11-16（原属 coding-plan-router 伞下工单 12；2026-11-18 拆出为独立 feature）

## Problem Statement

仓库代码处于「部分 `.ts` + 部分 `.mjs`」的混合态：`lib/`、`test/`、`scripts/` 后缀不一致，类型覆盖只有一半，tsconfig 靠 `allowJs` 两头凑合。混合态不带来新能力，却让每次改动要同时维护两套命名与导入习惯，也说不清「哪部分有类型保障、哪部分没有」。

## Solution

`lib/`、`test/`、`scripts/` 全部收敛为 `.ts`，靠 Node ≥ 22.18 原生类型擦除直接运行——无构建步骤、无运行时依赖不变；`npm run typecheck`（strict、noEmit）成为唯一静态门，覆盖全仓含 type-tests 编译负例。发布配方必须带 `package.json`（`.ts` 的 ESM 判定由最近的 `package.json` 决定，原配方 `git archive HEAD lib static` 只靠 Node 语法探测兜底才碰巧能跑）。

**边界：** 只改仓库代码与文档；生产 systemd unit 的 `ExecStart` 从 `lib/main.mjs` 改 `lib/main.ts` 属生产改动，上线须用户逐次授权。

完整验收、逐文件坑与排错记录见 `issues/01-typescript-migration.md`；迁移步骤细节沉淀在技能 `references/typescript-migration.md`。
