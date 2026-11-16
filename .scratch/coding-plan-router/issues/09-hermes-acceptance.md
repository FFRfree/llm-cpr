# 09: Hermes 真链路验收 + 对外 README 骨架

**What to build:** 收尾验收：准备好 Hermes 侧切换所需的全部材料（providers 条目 + `session_affinity_header` 的 config.yaml 增量 diff、切换/回滚步骤说明），**生产配置的实际改动须用户逐次点头后才应用**；应用后真对话穿全链路（hermes → 网关 → ocg-proxy / commandcode），`/model` 白名单可见、流式正常、账本与看板有数。同时产出面向外部用户的 README 骨架（快速开始：配置家族/账号/白名单、端口、master key；个人部署差异只留章节钩子），为开源做准备。

**Blocked by:** 07、08（两家真上游都通了）

**Status:** ready-for-agent

- [ ] config.yaml 增量 diff + 回滚步骤写成文档（不擅自应用）
- [ ] 用户同意后应用配置，真对话验收：/model 白名单、SSE、账本、看板四项全过
- [ ] README 骨架（快速开始 + 配置参考 + 本机部署可选章节钩子）
- [ ] `node --test` 全绿；中文 commit；工作树干净
