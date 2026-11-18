# 1 — lib 按模块归目录

**Status:** completed

**目标：**把 `lib/` 下平铺的模块按子系统归目录，与 `protocols/`、`providers/` 的目录形态对齐；纯挪文件 + import 修正，行为零改动。

## 结构（2026-11-18 落地）

- 根保留：`main.ts`（入口，`lib/main.ts` 字符串被 `smoke-release.ts` 断言与文档引用，不动）、`contracts.ts`（全员共享类型）。
- `lib/http/`：`server.ts`、`headers.ts`。
- `lib/policy/`：`contract.ts`（原 policy-contract）、`loader.ts`（原 policy-loader，随后续工单删除）、`config.ts`（原 lib/config）、`selection.ts`、`builtin-decide.ts`。
- `lib/store/`：`audit.ts`、`identity.ts`、`snapshots.ts`。
- `lib/protocols/`、`lib/providers/` 原样。
- 顺手删除 `lib/translate.ts`（兼容转发桩，唯一引用在 `test/gateway.test.ts`，改直调 `chatCompletions.prepareRequest`）。

## 验收

- [x] `git mv` 保留历史；全部 import（lib 内相对路径、test 的 `../lib/...`、policies 的跨目录引用）一次改齐。
- [x] 两处按文件位置推算的相对路径修正：`lib/http/server.ts` 的 `../../static/dashboard.html` 与 `../../sessions.db` 兜底（挪入 http/ 后深了一层，admin-dashboard 测试当场抓住）；`lib/policy/loader.ts` 的 `../../package.json`。
- [x] `lib/providers/shared.ts` 的 `../headers.ts` → `../http/headers.ts`（首轮 grep 漏网的相对引用，typecheck 抓住）。
- [x] `npm run typecheck` 通过；`node --test` 110/110 全绿。
- [x] 开发依赖回归：本工作树 node_modules 曾缺失（目录迁入 FFR 后 `npm ci` 未重跑，`tsc` 报 TS2688），本轮补装；这是环境问题非代码问题。

## Comments

- 2026-11-18：目录判据 = 「同一抽象会有多个并列实现 + 注册表挑选」才开目录；audit/identity/snapshots/决策面是单例职责，归目录只为阅读分层，不为扩展多态——决策面的「第二实现」是用户 policy 文件，不在 lib。
- 2026-11-18：README 的模块职责一节同步（删 translate.ts 句）；`docs/xdg-deployment.md` 的 `lib/server.ts` 引用改为 `lib/http/server.ts`。
