# 08 文档 npm 形态化

Status: ready-for-agent
Blocked by: 05, 06

## 验收

- [ ] README 安装/升级/卸载节重写：npm 单轨新故事——`npx -y llm-cpr install` 首装（固定位置 `~/.local/lib/llm-cpr` + 命令软链 `~/.local/bin/cpr` + 用户资产 `~/.llm-cpr`；ADR-0009），`cpr upgrade` 软链切换 + 零网络回滚；clone 留给引擎开发者，旧 clone 流程移入「历史/开发者」节。
- [ ] `docs/deployment.md` 改写为 npm 发布视角；旧 XDG release 机制原文留档为历史稿（顶部加横幅）。
- [ ] `docs/policy-guide.md` 路径口径改 `~/.llm-cpr`。
- [ ] 收尾跑 workspace-lint 0 ERROR。

## Comments
