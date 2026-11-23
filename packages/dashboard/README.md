# @ffrfree/llm-cpr-dashboard（看板页面源码）

`src/` 是看板页面的**唯一正本**；`npm run build`（= `build.ts`）把产物落进 `packages/core/static/`——
那才是管理口实际分发的目录，也随源码一起 commit（产物随源码进仓的既定约定）。

- 现在：无构建静态页（源码即产物，build = 原样拷贝），`test/dashboard-sync.test.ts` 守 src↔static 一致。
- 将来：React/Vite 源码住进 `src/`（usage-series 分支的 `dashboard/` 是现成前例），build 换 vite 单文件产物——
  core 侧与 cli 装配零改动，这正是本包存在的意义：页面源码与引擎解耦，构建管线有且只有一个出口。

改看板页面的动作：改 `src/` → `npm run build -w @ffrfree/llm-cpr-dashboard` → 连产物一起 commit。
