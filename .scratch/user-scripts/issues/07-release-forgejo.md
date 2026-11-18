# 07 — 发布侧：Forgejo 远端、首个 tag、README 安装/升级文档

**Status:** ready-for-agent

**目标：** 让「clone + 升级」真正可达。

## 内容

- **Forgejo（hermes-git）建仓 + remote**：自托管克隆源，不经过第三方；私有仓起步。**公开化前置**：`lib/policy/mine.ts` 真实订阅声明需先通用化（另立工单），公开前 private 不变。
- **首个 tag**：流程照本仓纪律——提交合入后 `git archive` 快照 + `smoke-release.ts` 冒烟通过才打 tag；tag 即「发给用户的字节」。
- **README 安装/升级章节**：三行主线（clone → `node scripts/cpr.ts install` → 改 policy.local.ts）+ 升级四行（fetch/doctor→upgrade/看版本号）+ fork 用户 rebase 路线 + doctor 输出解读（AHEAD/DIRTY 行）+ 回滚一句话。
- **版本可见性**：启动日志/管理 API 报当前 commit——clone 场景 spawn `git describe --tags`，release 目录用打包时写入的版本文件；随本票一并实现。

## 坑

- 推送前核实推的是哪个分支、远端仓库可见性；不推 `.scratch` 之外的本地杂项（.scratch 本身 tracked，跟分支走）。
- 主仓 `.scratch` 里有未提交的文档改动（AGENTS.md/README.md/docs/deployment.md，2026-11-18 工作树）——本 feature 合入时不裹挟它们。

## 验收

- 从一台干净目录 clone Forgejo 上的仓 → install（临时 unit 目录）→ 改 policy.local.ts → upgrade（注入）全链路走通。
- `git ls-remote` 能看到 tag；启动日志/管理 API 报出的 commit 与 tag 一致。

## Comments
