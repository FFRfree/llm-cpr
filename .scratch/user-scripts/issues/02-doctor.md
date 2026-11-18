# 02 — doctor：只读体检（install/upgrade 共用闸门）

**Status:** ready-for-agent

**目标：** `scripts/cpr.ts doctor`，一次输出升级/安装决策所需的全部事实，不做任何写操作。

## 输出项

- Node 版本 vs `package.json` engines（≥22.18）。
- 当前 HEAD、所在分支/是否 detached、最新可用 tag（`git fetch --tags` 后）。
- 落后：`git rev-list --count HEAD..origin/main`；领先：`git log --oneline origin/main..HEAD` 逐条列 commit。
- 脏跟踪文件：`git status --porcelain` 排除未跟踪行，点名列出；未跟踪文件汇总一行（policy.local.ts 属预期）。
- 末尾打印「建议下一步」：干净→升级命令；领先→rebase 路线；脏→三条出路原文。

## 坑

- `git fetch --tags` 需网络；离线/无 remote 时降级为本地已知 tag 并标注「未联网核对」。
- 输出同时人读和 agent 读：结论行固定格式（如 `AHEAD=2`、`DIRTY=lib/main.ts`），细节跟在后面。

## 验收

- 五状态 fixture（见 06）各自输出正确的结论行；无 remote 仓库不炸。
- doctor 在任何状态都不改工作树（测试断言 `git status` 前后一致）。

## Comments
