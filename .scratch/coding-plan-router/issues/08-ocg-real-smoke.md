# 08: OCG 家族真链路接入冒烟（经 ocg-proxy）

**What to build:** 对真 ocg-proxy 的端到端冒烟：网关配置 ocg 家族指向本机 ocg-proxy（master key 从 ocg-proxy .env 读），真请求经路由器 → ocg-proxy → OpenCode Go 成功；验证 `x-opencode-session` 原样穿透（ocg-proxy 日志/身份字段里看到的是同一个 `gwk_` 身份而非 `cv_` 指纹兜底）；ocg 家族余量数据（管理口 /api/route/status）被快照器正确消费。不改 ocg-proxy 任何代码与配置。

**Blocked by:** 03、04、05（核心逻辑齐备）

**Status:** ready-for-agent

- [ ] 真上游冒烟：非流式+流式各一笔成功；账本可见
- [ ] 会话头穿透验证：ocg-proxy 侧身份 == 网关侧身份（非指纹兜底）
- [ ] ocg 快照接入单测（用真管理口返回样本做夹具）
- [ ] `node --test` 全绿；中文 commit；工作树干净
