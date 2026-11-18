# 04 — upgrade：决策树与安全边界

**Status:** ready-for-agent

**目标：** `scripts/cpr.ts upgrade`，核心原则：只处理干净状态，带杂质一律拒绝并把选择权递回用户；脚本永不 stash/commit/discard。

## 决策树

进门 `git fetch --tags` → doctor 闸门，按状态分支：

1. **干净 + 领先 0**：`git pull --ff-only origin main` → 全量 `node --test` + 假上游冒烟 → 交互「重启服务？（y/N）」→ y 则 `systemctl restart coding-plan-router`。升级前记录旧 SHA，任一步失败打印「回滚：git checkout <旧SHA>」。
2. **干净 + 领先 N**：打印 N 条 commit → 交互「尝试 rebase？（y/N）」→ `git rebase origin/main`；**撞冲突立即 `--abort`（工作树逐字节还原）**、退出非零、打印冲突文件清单与手工路线。rebase 干净通过仍须走最严验收（全量测试 + 冒烟，防语义破坏）。
3. **脏跟踪文件**：无条件拒绝（优先级高于一切），点名列出 + `diff --stat` + 三条出路原文（commit/stash/discard，全由用户亲手执行）。
4. **又脏又领先**：按 3 先拦。
5. **路径冲突**（新版本新增跟踪文件撞用户未跟踪文件）：透传 git 原始报错，不包装。

`--yes` 跳过交互（无人值守）；重启永远显式确认，不在 `--yes` 语义内默默带上——`--yes` 只跳过已打印清楚的确认。

## 坑

- detached HEAD 用户（直接 checkout tag 的人）：ff-only 语义换算成 checkout tag 路线，doctor 输出里标注状态。
- 冒烟复用 `smoke-release.ts`（假上游、本机回环），不能碰真实订阅额度。

## 验收

- 五状态用例（06）：该走的走、该拒的拒、abort 后 `git status` 与 `git diff HEAD` 与升级前逐字节一致。
- 测试全部经 `CPR_SYSTEMCTL` 注入，断言仅收到预期调用（restart 仅在 y/--yes 分支）。

## Comments
