# 08 文档 npm 形态化

Status: completed
Blocked by: 05, 06

## 验收

- [x] README 安装/升级/卸载节重写：npm 单轨新故事——`npx -y llm-cpr install` 首装（固定位置 `~/.local/lib/llm-cpr` + 命令软链 `~/.local/bin/cpr` + 用户资产 `~/.llm-cpr`；ADR-0009），`cpr upgrade` 软链切换 + 零网络回滚；clone 留给引擎开发者，旧 clone 流程移入「引擎开发者（clone 轨道）」节。
- [x] `docs/deployment.md` 改写为 npm 发布视角；旧 XDG release 机制原文留档为历史稿（顶部加横幅，旧名旧路径按历史原样）。
- [x] `docs/policy-guide.md` 路径口径改 `~/.llm-cpr`（policy 住在 ~/.llm-cpr/policy.ts、改完 restart 即生效不再发版、mine.ts 归引擎开发者）。
- [x] 收尾跑 workspace-lint 0 ERROR。

## Comments

- README 其余跟随口径的小修：快速开始整节重写（npx 首装四步）；「生产机密钥放 ~/.config/coding-plan-router/.env」旧话删除；启动日志行从报 commit 改为报版本。
- 验证：typecheck 0 错 + `node --test` 158/158 + workspace-lint 0 ERROR（WARN 均为并行会话的预存脏树，与本票无关）。
- 没做的验证：README/deployment 里命令的逐条人工走查归发布前 e2e（工单 11 候选）。
