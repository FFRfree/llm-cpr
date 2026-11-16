# 01: 网关空壳 — 配置 + 转发骨架（固定单后端）

**What to build:** 一个能跑起来的最小网关：读配置（家族/后端、模型白名单与翻译表、端口、key 环境变量名），流量口带 master key 鉴权，`GET /v1/models` 本地返回白名单目录，`POST /v1/chat/completions` 把请求按配置翻译后转发给**固定的第一个后端**（模型名翻译、Authorization 替换、按家族规则处理统一会话头：ocg 家族透传、ccg 家族剥除），响应（含 SSE 流）原样管道回客户端。身份/评分/迁移都不在本票——固定选第一个后端即可。测试上游全部用假件。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 单测：配置解析（家族/账号/白名单/翻译表/端口覆盖）、模型名翻译、会话头家族规则
- [ ] e2e（假上游）：非流式与流式 chat completions 全链路——假上游收到翻译后的请求（模型名/Authorization/会话头三处正确），客户端收到完整 SSE
- [ ] e2e：master key 错误 → 401；上游 5xx → 状态码与错误体透传
- [ ] `node --test` 全绿；正式中文 commit；工作树干净
