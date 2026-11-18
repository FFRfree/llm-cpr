# Spec: lib 按模块归目录（消灭平铺）

**Status:** claimed
**日期:** 2026-11-18

## Problem Statement

`lib/` 下 12 个 `.ts` 文件平铺，模块职责（HTTP 门面、决策面、存储）只能靠文件名猜；`protocols/`、`providers/` 两个扩展轴已经是目录+注册表形态，其余模块却浮在外面，结构不对称。

## Solution

按子系统归目录，根只留两个全员共享的文件：

- `lib/main.ts`（入口；`test/family-protocol-http` 子进程与 `smoke-release.ts` 均按 `lib/main.ts` 字符串引用，不动）
- `lib/contracts.ts`（共享类型词汇表，所有模块 import）
- `lib/http/`：`server.ts`、`headers.ts`（对外 HTTP 门面与跨信任边界头过滤）
- `lib/policy/`：`contract.ts`（原 policy-contract）、`loader.ts`（原 policy-loader，随后续工单退役）、`config.ts`（声明校验）、`selection.ts`、`builtin-decide.ts`（决策面全收拢）
- `lib/store/`：`audit.ts`、`identity.ts`、`snapshots.ts`（持久账本/会话钉死/额度快照缓存）
- `lib/protocols/`、`lib/providers/` 原样保留

纯挪文件 + 改 import，行为零改动；`lib/translate.ts` 为全仓零引用的死代码，顺手删除（README 对应行同步更新）。机械改名与行为改动分轮做，本轮后跑全量 `npm run typecheck` + `node --test`。
