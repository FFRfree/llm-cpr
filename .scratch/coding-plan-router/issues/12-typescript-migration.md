# 12 — 全仓迁移到 TypeScript（去掉剩余的 .mjs）

**Status:** completed

**目标：**把 coding-plan-router 仓库自身的代码从「部分 `.ts` + 部分 `.mjs`」收敛成整仓 TypeScript：`lib/`、`test/`、`scripts/` 下不再有 `.mjs`，`npm run typecheck` 覆盖全部源码与测试，运行时仍然零第三方依赖、无构建步骤（Node 原生类型擦除），行为与迁移前逐字节一致。

## 范围与边界

- 只改仓库代码与文档，不动生产配置、systemd unit、生产运行副本与数据库；上线须另行授权。
- 保留 Node ≥ 22.18 的原生擦除运行方式：不引入构建产物、不引入 `ts-node`/`tsx`、不引入运行时依赖。
- `static/dashboard.html` 保持单文件内联 JS（看板无构建是既定设计），不纳入类型检查。
- 类型迁移不改变运行时校验：配置、上游 JSON、SQLite 行仍从 `unknown` 检查后读取。

## 验收

- [x] `lib/` 八个模块全部 `.ts` 并有类型：`audit`、`config`、`identity`、`main`、`selection`、`server`、`snapshots`、`translate`；`contracts.ts` 补齐配置、审计行/会话汇总/额度视图等共享类型。
- [x] 18 个 `test/*.test.ts` 全部带类型（fixture、HTTP 助手、假上游 handler、`TestContext`），无 `any`、无 `@ts-ignore`/`@ts-expect-error`、无靠非空断言压错。
- [x] `scripts/xdg-deploy/{migrate-dbs,smoke-release}.ts` 改为 `.ts` 并指向 `lib/main.ts` 入口。
- [x] `tsconfig.json`：去掉 `allowJs`/`checkJs`，`include` 覆盖 `lib/`、`test/`、`scripts/`、`type-tests/`；`package.json` 的 `start` 指向 `lib/main.ts`。
- [x] `npm run typecheck` 全仓通过；`node --test` 97 项全过；发布副本（`git archive HEAD lib static package.json`，无 `node_modules`）本机假上游冒烟全过。
- [x] 文档同步：`README.md`、`docs/xdg-deployment.md`、仓库 `AGENTS.md` 里的入口与路径引用；发布配方补上 `package.json`（`.ts` 的 ESM 判定依赖它）。

## Comments

- 2026-11-16：迁移提交 `e59697d`（部署辅助脚本 `.mjs`→`.ts`）、`1f905da`（lib/test 全量 `.ts` + 严格类型 + 文档）。改动前工作树干净，HEAD 为 `8b9989f`。
- 2026-11-16：迁移中抓到并修掉一个真实回归——`server.ts` 把 `onComplete` 的第二个参数窄化成「响应文本」，丢掉了流结束回调传的 usage 对象，导致账本 token/cache 全记 null。`test/audit`、`test/family-protocol-http` 当场失败，恢复原语义（字符串才走 `responseUsage()`，对象原样传）后全绿。这也是本次坚持「改后缀先跑全量测试而不是只跑 tsc」的原因：类型全绿不等于语义没漂。
- 2026-11-16：验证命令与结果（工作树 `1f905da`）：`npx tsc --noEmit` 通过（strict + `erasableSyntaxOnly` + `verbatimModuleSyntax`）；`node --test` 97 tests / 0 fail（79 个顶层测试）；`grep` 确认 `lib|test|scripts` 无 `any`/`@ts-ignore`/`@ts-expect-error`；发布副本冒烟 `node scripts/xdg-deploy/smoke-release.ts <release>` 全部步骤通过（进程启动、鉴权、JSON/SSE 转发、route/status、账本、会话聚合、看板、数据落位）。未调用真实推理、未消耗订阅额度。
- 2026-11-16：发布配方发现一处隐式依赖：`.ts` 文件的模块类型由最近的 `package.json`（`"type": "module"`）决定，而原配方 `git archive HEAD lib static` 不带它，副本能跑只是因为 Node 22 的语法探测在兜底。已把配方改成带上 `package.json`，并在 `smoke-release.ts` 里加断言（缺 `package.json` 或不是 `type: module` 直接失败）。
- 2026-11-16：生产未动：`current` 仍指向 `20261116-252f723`（全 `.mjs`），systemd `ExecStart=/usr/bin/node lib/main.mjs`。切换需要：发布新 release、把 unit 的 `ExecStart` 改成 `lib/main.ts`、`daemon-reload` + `restart`（会中断在途请求）。这三步属生产改动，待用户逐次授权后执行。
