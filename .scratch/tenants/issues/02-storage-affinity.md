# 02 存储与亲和隔离：tenant 列 + (tenant, identity) 键

Status: completed
Blocked by: 01

## 验收

- [x] `store/db.ts`：requests 与 system_events 各加 `tenant TEXT NOT NULL DEFAULT 'default'`（SCHEMA 管新库，PRAGMA+ALTER 管旧库，旧行自动 'default'，行数不变）。
- [x] `store/events.ts`：INSERT 带 tenant；affinity/lastRebind/coolingDown 以 (tenant, kind, key) 查询；append 默认 'default'；mappingOverview 按租户分列。
- [x] `store/audit.ts`：INSERT 占位符数清（初版 23 值 22 列被测试当场抓住，已修）；listRequests/listSessions/summary 接受 tenant 过滤；sessionSummary 以 (tenant, identity) 查。
- [x] 租户间同 identity 不串亲和：A 租户 bind 到 X 后，B 租户同 key 仍可独立选 Y。

## Comments

- commit 51a0ad4（含 review 修复 amend）：双表加列走 ALTER 常量默认值免回填；review 追加两项修复——summary 会话数按 (tenant, identity) 去重（原 COUNT(DISTINCT identity) 少计）、sessionSummary 省略 tenant 时不再强查 'default'（跨租户合并，与同响应 requests 明细同范围）。
- 验证：`node --test`（identity/rebind-cooldown/error-rebind 调用点改造 + tenants.test.ts 亲和隔离/旧库迁移/summary 去重/范围一致）；review 的 guardrails.mjs 故障注入（拒写触发器）复验失败笔+事件事务回滚、原亲和保留。
- 没做的验证：真生产 data.db（90k 行）的加列耗时实测——ALTER ADD COLUMN 常量默认在 SQLite 是 O(1) 元数据操作，不动存量行；部署时仍按纪律先备份。
