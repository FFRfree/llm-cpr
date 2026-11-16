# coding-plan-router

对多个 coding-plan 订阅（OpenCode Go / CommandCode GOAT / 未来 Codex 等）做
负载均衡的 LLM 路由网关：agent-agnostic，hermes / pi / oh-my-pi / hindsight 等客户端
经上层适配接入，统一拿到「会话钉死 + 月度欠账评分 + 审计 + 看板」。

## 当前状态（重要）

**规划阶段，未写代码、未起服务、未改任何生产配置。** 设计与事实底座见
`docs/design.md`（含「已验证 / 待拍板 / 待验证」标注）。动手前所有待拍板项须用户逐项确认。

**定位与开源**：未来发布到 GitHub（规划期曾名 sub-router，2026-11-16 定名）。
三层结构：上层 per-harness 接入（薄）→ 中层路由器（本仓核心）→ 下层多家族订阅后端。

## 目录

```
docs/design.md    设计文档（规划稿 v0.2）
```

## 约定（与 ocg-proxy 同源的规矩）

- 纯 Node 零第三方依赖（node:sqlite），Node ≥ 22。
- `.env` 不进 git；真 key 只放 `.env`（chmod 600）。
- 管理口永远只绑回环；开发期用端口覆盖 + 假上游冒烟，不碰生产端口。
- 审计写失败只丢行不挡转发；不落请求正文。
- 正式改动单独中文 git commit，结束工作树应干净。
- Hermes config.yaml / systemd 等生产改动须用户逐次明确同意。

## Agent skills

### Issue tracker

工单以本地 markdown 存放在 `.scratch/<feature-slug>/`（暂无 remote；发 GitHub 后可切换）。See `docs/agents/issue-tracker.md`.

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/adr/`；现有领域叙事在 `docs/design.md`。See `docs/agents/domain.md`.
