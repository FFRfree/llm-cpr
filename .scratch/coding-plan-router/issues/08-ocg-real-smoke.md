# 08: OCG 家族真链路接入冒烟（经 ocg-proxy）

**What to build:** 对真 ocg-proxy 的端到端冒烟：网关配置 ocg 家族指向本机 ocg-proxy（master key 从 ocg-proxy .env 读），真请求经路由器 → ocg-proxy → OpenCode Go 成功；验证 `x-opencode-session` 原样穿透（ocg-proxy 日志/身份字段里看到的是同一个 `gwk_` 身份而非 `cv_` 指纹兜底）；ocg 家族余量数据（管理口 /api/route/status）被快照器正确消费。不改 ocg-proxy 任何代码与配置。

**Blocked by:** 03、04、05（核心逻辑齐备）

**Status:** completed

- [x] 真上游冒烟：非流式+流式各一笔成功；账本可见
- [x] 会话头穿透验证：ocg-proxy 侧身份 == 网关侧身份（非指纹兜底）
- [x] ocg 快照接入单测（用真管理口返回样本做夹具）
- [x] `node --test` 全绿；中文 commit；工作树干净

## Comments

- 通过临时网关配置（转发/管理端口 18741/18740，数据目录 `/root/.hermes/cache/scratch/cpr-smoke/`）直连生产 `ocg-proxy` 的 8731 转发口和 8742 管理口；未改动 ocg-proxy 代码、配置或数据。
- `glm-5.3-flash` 非流式与流式请求均 HTTP 200；流式返回 SSE 数据并含 `[DONE]`。网关 usage ledger 同一测试会话下落 2 行，状态均 200、`identity_kind=session`、映射模型为 `glm-5.3-flash`。
- 为穿透验证使用专用 `gwk_` 会话头；ocg-proxy `/api/audit/sessions` 中按相同 identity 找到记录，`identity_kind=header`、请求数 2，非 `cv_` 指纹回退。
- 网关快照从真实管理口 `/api/route/status` 读取成功，`known=true`，月度/rolling/weekly 数据可用。生产接口真实返回的百分比和重置时间字段位于 `accounts[]` 直接字段（并非 `usage` 子对象）；原解析器已能读取百分比，但漏掉 rolling/weekly reset 时间，本票补齐 `resetAt` 并用脱敏真实形状夹具覆盖。
- 夹具只保留单个账号必要额度字段并将账号名替换为 `ocg-account-sample`；未包含 key、会话身份或其他认证信息。master key 仅由 `.env` 读入进程环境变量，未输出、写入仓库或传入提交内容。
- 取舍：在线真实上游请求通过本票临时配置手动执行，不把生产凭据或不稳定网络冒烟加入默认 `node --test`；首次链路检查后，将测试头调整为约定的 `gwk_` 前缀并完成最终会话穿透验收。
