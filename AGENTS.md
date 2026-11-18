# coding-plan-router

对多个 coding-plan 订阅（OpenCode Go / CommandCode GOAT / 未来 Codex 等）做
负载均衡的 LLM 路由网关：agent-agnostic，hermes / pi / oh-my-pi / hindsight 等客户端
经上层适配接入，统一拿到「会话钉死 + 月度欠账评分 + 审计 + 看板」。

## 当前状态（重要）

以当前代码、测试与服务状态为准；`docs/design.md` 是历史规划与事实底座，不代表当前实现。
涉及生产配置或服务上线时须用户逐次明确同意。

**定位与开源**：未来发布到 GitHub（规划期曾名 sub-router，2026-11-16 定名）。
三层结构：上层 per-harness 接入（薄）→ 中层路由器（本仓核心）→ 下层多家族订阅后端。

## 目录

```
GLOSSARY.md       领域词汇表（术语唯一正本）
docs/adr/         已拍板的架构决策（ADR）
docs/design.md    历史规划与事实底座（2026-11-16 规划稿，不随实现更新）
docs/agents/      agent 协作约定（issue tracker、domain docs）
```

## 约定（与 ocg-proxy 同源的规矩）

- 运行时零第三方依赖（node:sqlite 与原生类型擦除），Node ≥ 22.18；TypeScript 为开发依赖。
- 全仓 `.ts`（`lib/`、`test/`、`scripts/`）：Node 原生类型擦除直接运行，没有构建步骤，`import` 必须写 `.ts` 后缀；`npm run typecheck` 覆盖这三处，`node --test` 会自动发现 `test/*.test.ts`。编译期负例放 `type-tests/`（`node --test` 不扫该目录）。
- 配置即代码：订阅声明与路由策略在仓库 `lib/policy/mine.ts`（随 release 发布）；仓库只放不含密钥的 `.env.example`，开发复制成 `.env`（被 `.gitignore` 排除），生产密钥在 `/root/.config/coding-plan-router/.env`。改声明 = 改代码，走 typecheck + 测试 + 冒烟 + release 切换。
- 生产运行副本在 `/root/.local/lib/coding-plan-router/current`，SQLite 在 `/root/.local/share/coding-plan-router/`；源码树不是生产运行目录，发布/回滚见 `docs/deployment.md`（通用版）；本机专属部署事实以技能 `coding-plan-router` 的 `references/production-deployment.md` 为准。
- 管理口永远只绑回环；开发期用端口覆盖 + 假上游冒烟，不碰生产端口。
- 审计写失败只丢行不挡转发；不落请求正文。
- 正式改动单独中文 git commit，结束工作树应干净。
- Hermes config.yaml / systemd 等生产改动须用户逐次明确同意。

## Agent skills

### Issue tracker

工单以本地 markdown 存放在 `.scratch/<feature-slug>/`（暂无 remote；发 GitHub 后可切换）。See `docs/agents/issue-tracker.md`.

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/adr/`；现有领域叙事在 `docs/design.md`。See `docs/agents/domain.md`.
