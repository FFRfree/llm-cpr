# 09: Hermes 真链路验收 + 对外 README 骨架

**What to build:** 收尾验收：准备好 Hermes 侧切换所需的全部材料（providers 条目 + `session_affinity_header` 的 config.yaml 增量 diff、切换/回滚步骤说明），**生产配置的实际改动须用户逐次点头后才应用**；应用后真对话穿全链路（hermes → 网关 → ocg-proxy / commandcode），`/model` 白名单可见、流式正常、账本与看板有数。同时产出面向外部用户的 README 骨架（快速开始：配置家族/账号/白名单、端口、master key；个人部署差异只留章节钩子），为开源做准备。

**Blocked by:** 07、08（两家真上游都通了）

**Status:** ready-for-agent

- [ ] config.yaml 增量 diff + 回滚步骤写成文档（不擅自应用）
- [ ] 用户同意后应用配置，真对话验收：/model 白名单、SSE、账本、看板四项全过
- [ ] README 骨架（快速开始 + 配置参考 + 本机部署可选章节钩子）
- [ ] `node --test` 全绿；中文 commit；工作树干净


## Comments

- 2026-11-16 生产切换完成（用户逐项批准）：
  1) 网关真配置（config.json：ocg-main 经 ocg-proxy 8731 + admin_url 8742 快照鉴权；ccg-main 直连；12 个统一白名单；identity_header=x-session-id）；
  2) systemd `coding-plan-router.service`（EnvironmentFile=.env，enable --now，8741/8740 回环）；
  3) Hermes config.yaml：model 块切 custom:sub-router + providers 新增条目（key_env: CPR_MASTER_KEY, session_affinity_header: x-session-id），原 opencode-go/commandcode 条目保留作为回滚；/root/.hermes/.env 追加 CPR_MASTER_KEY。
- 生产排障两笔：① ocg 快照 401/HTML——admin_url 须为**完整 URL**（含 /api/route/status 路径），配裸端口会 GET 到看板 HTML；② 快照鉴权字段是 admin_key_env。均已修正并验证。
- 验收：双订阅快照 known=true（OCG 月 8% 周 0/100、CCG 月 2.29% 5h 0.175/14）；systemd 服务真请求 200；`hermes -z` 单发穿透全链路（账本 id=6：identity_kind=session、gwk_ 身份、ocg-main、16k prompt tokens），Hermes→网关→OCG 会话头钉死链路实证。
- 回滚：cp /root/.hermes/config.yaml.bak-subrouter-20261116 覆盖回去即可。
