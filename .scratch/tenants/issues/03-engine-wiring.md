# 03 引擎接线与候选过滤：server.ts 全链路带租户

Status: completed
Blocked by: 02

## 验收

- [x] 候选池 = 声明后端 ∩ 租户 backends 子集 ∩ 模型支持；租户 models allowlist 外的模型 400 'model not allowed'；`/v1/models` 按租户过滤。
- [x] 亲和读取按 (tenant, identity)：租户 backends 收缩后，池外亲和按 stale-pin 处理（重选并 rebind）。
- [x] ctx/errorCtx 都带 `tenant: name`；decide 可按租户分支。
- [x] 账本行（record/failEntry）与四类事件都带 tenant；policy.error 也带。
- [x] 长会话判定 sessionSummary 按 (tenant, identity)。

## Comments

- commit 51a0ad4（含 review 修复 amend）：server.ts 全部调用点带租户（review 逐调用点 grep+探针核对无漏）；池外亲和复用 stale-pin 语义，重选限定租户池内。
- 验证：`node --test` 全量（stale-pin 子集收缩、ctx.tenant 两决策点、并发探针由 review 的 probe.mjs 复验：12 并发同 identity 双租户各 6 笔、错误路径 ctx 带 error+tenant）。
- 没做的验证：真实多订阅上游的跨池迁移（第一版两租户不限池，本机声明不走该路径；外部用户用到子集时由 e2e 冒烟覆盖）。
