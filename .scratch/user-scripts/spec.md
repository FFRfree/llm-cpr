# Spec: 用户侧安装/升级/卸载（clone 路线）

**Status:** claimed
**日期:** 2026-11-18

## Problem Statement

仓库要面向其他用户分发，安装体验的硬约束是「用户对源代码绝对透明、完全控制」。已拍板走 **clone + git 升级**路线（否决 npm/Docker/二进制/curl|sh——四类各砍掉透明或控制的至少一条）。当前缺口：仓库无 remote、无 tag、无用户侧安装/升级故事；配置即代码（`lib/policy/mine.ts`）意味着用户价值改动住在被跟踪文件里，升级 `git pull` 必撞冲突。

## Solution

三件套，全部随源码走（脚本先于代码到达 = curl|sh，明确不做）：

1. **policy.local.ts 机制**：`policy.example.ts`（tracked，模板，从不加载）+ `policy.local.ts`（gitignored，用户真身）。`main.ts` 动态 import：存在则优先、否则回落 `mine.ts`，`validateConfig` 照旧。升级 = git checkout/pull 不碰未跟踪文件 → policy 冲突归零。
2. **`scripts/cpr.ts` 单文件零依赖，四个子命令**：
   - `doctor`：只读体检（Node 版本、当前 commit/tag、落后 N、领先 commit 清单、脏跟踪文件清单）。install 与 upgrade 共用，输出兼作 agent 可执行的操作指引。
   - `install`：Node 检查 → `cp policy.example.ts policy.local.ts` → 写 systemd unit（服务名约定 `coding-plan-router.service`）→ `node --test` → 交互确认启动。install 拥有环境 = upgrade/uninstall 有资格按名动服务。
   - `upgrade`：决策树——干净+领先0 → `git pull --ff-only`；干净+领先N → 打印 commit 清单、确认后 rebase（撞冲突立即 `--abort` 原地恢复、退出非零）→ 全量测试 + 假上游冒烟 → 交互确认重启（`--yes` 跳过）。**脏跟踪文件无条件拒绝**：点名列出 + 三条出路（用户自己 commit/stash/discard），脚本绝不代 stash/commit/discard。
   - `uninstall`：stop/disable/删 unit；`/root/.local/share/coding-plan-router/` 数据库**永不静默删**（打印路径留证，`--purge` 才删）。
3. **发布侧**：release = tag；打 tag 前先 `git archive` 快照 + `smoke-release.ts` 冒烟（验的即发给用户的字节）；克隆源 = 自托管 Forgejo（hermes-git），不经过第三方。

## 边界

- 本机生产部署流程不变（release 目录 + symlink + 备份回滚），脚本不服务本机生产。
- `mine.ts` 含真实订阅声明，公开化之前需通用化——另立工单，不在本 feature。
- 语义破坏（rebase 干净但上游改了契约）靠升级后全量测试兜底；契约变更属大版本，release note 写明。
- 版本可见性：启动日志/管理 API 报当前 commit（clone 场景 `git describe`，release 目录用打包时写入的版本文件）——随 doctor/04 落地。

## 验收

- 五个升级状态（干净/领先/脏/又脏又领先/路径冲突）各有 `node --test` 用例，fixture 全部临时 clone + 可注入 systemctl，不触碰本机生产服务与真实 unit。
- abort 后工作树逐字节还原；uninstall 后数据文件原样存在；全程无 curl|sh 路径。
