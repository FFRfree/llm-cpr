# llm-cpr（原 coding-plan-router）

对多个 coding-plan 订阅（OpenCode Go / CommandCode GOAT / 未来 Codex 等）做
负载均衡的 LLM 路由网关：agent-agnostic，hermes / pi / oh-my-pi / hindsight 等客户端
经上层适配接入，统一拿到「会话亲和 + 月度欠账评分 + 审计 + 看板」。

## 当前状态（重要）

以当前代码、测试与服务状态为准；`docs/design.md` 是历史规划与事实底座，不代表当前实现。
涉及生产配置或服务上线时须用户逐次明确同意。

**定位与开源**：未来发布到 GitHub（规划期曾名 sub-router，2026-11-16 定名）。
三层结构：上层 per-harness 接入（薄）→ 中层路由器（本仓核心）→ 下层多家族订阅后端。

## 目录

```
packages/core/     引擎：core/（路由+管理面+账本，零构建 .ts）+ static/（看板分发产物，dashboard build 落点）
packages/dashboard/ 看板页面源码唯一正本：src/ → build → packages/core/static/（React/Vite 将来住这）
packages/cli/      唯一 npm 发布包 @ffrfree/llm-cpr：bin 引导器 + vendor/（ADR-0010）+ prepack 装配 core/static
GLOSSARY.md       领域词汇表（术语唯一正本）
docs/adr/         已拍板的架构决策（ADR）
docs/design.md    历史规划与事实底座（2026-11-16 规划稿，不随实现更新）
docs/agents/      agent 协作约定（issue tracker、domain docs）
```

## 约定（与 ocg-proxy 同源的规矩）

- 依赖从少不从无：当前实现是零第三方依赖（node:sqlite 与原生类型擦除直接跑 .ts，无构建步骤），但这不是禁令——前后端在确有必要时都可以引第三方库。要引就先给选型理由（为什么非它不可、有什么替代、体积/维护成本），经用户点头再加；依赖进 package.json 正常管理，前端资产保持自包含、不挂 CDN。运行时依赖进包走 vendor 机制（ADR-0010）：版本声明进 devDependencies、`npm run vendor` 拷进 `vendor/`、业务代码经 package.json `imports` 的 `#别名` 引用；`dependencies` 恒为空（bootstrap 会清掉 npm 落的依赖目录）。monorepo 形态见 ADR-0011：三包一发布入口，包间只有构建期装配、没有运行期包依赖（node_modules 下的 .ts 跑不了）。
- 全仓 `.ts`（`core/`、`test/`、`scripts/`）：Node 原生类型擦除直接运行，没有构建步骤，`import` 必须写 `.ts` 后缀；`npm run typecheck` 覆盖这三处，`node --test` 会自动发现 `test/*.test.ts`。编译期负例放 `type-tests/`（`node --test` 不扫该目录）。
- 配置即代码（v0.2.0 加载序）：用户声明在 `~/.llm-cpr/policy.ts`（存在则优先，坏文件原样抛拒启动），否则内置 `core/policy/mine.ts`；密钥在 `~/.llm-cpr/.env`（引擎自加载、只填缺失键，`CPR_ENV_FILE` 接缝优先）。仓库只放 `.env.example` 与 `policy.example.ts` 模板，用户真身不进仓、不进 release。
- 生产运行副本在 `~/.local/lib/llm-cpr/versions/<v>/app`（`current` 软链切换，ADR-0009），配置/密钥/数据库在 `~/.llm-cpr/`；旧 `/root/.local/lib|share/coding-plan-router/` 路径已停用、纯为回滚材料；源码树不是生产运行目录，发布/回滚见 `docs/deployment.md`（通用版）；本机专属部署事实以技能 `llm-cpr` 的 `references/production-deployment.md` 为准。
- 管理口永远只绑回环；开发期用端口覆盖 + 假上游冒烟，不碰生产端口。
- 审计写失败只丢行不挡转发；请求正文默认不落库，租户 opt-in（`capture: true`）才写侧库 capture.db（内容寻址去重、TTL 清理）。
- 正式改动单独中文 git commit，结束工作树应干净。
- Hermes config.yaml / systemd 等生产改动须用户逐次明确同意。

## Agent skills

### Issue tracker

工单以本地 markdown 存放在 `.scratch/<feature-slug>/`（暂无 remote；发 GitHub 后可切换）。See `docs/agents/issue-tracker.md`.

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/adr/`；现有领域叙事在 `docs/design.md`。See `docs/agents/domain.md`.
