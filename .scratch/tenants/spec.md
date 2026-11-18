# 租户（Tenants）：key 即租户

2026-11-18 与用户在对话中拍板（设计稿先文字过、用户回复「可以的 开工吧」）。

## 动机

网关此前只有一个身份概念：所有带 master key 的请求算同一个人。三个缺口——
账本不认人（Hermes 流量只能靠 session-id 前缀猜，fingerprint 单笔完全分不出归属）、
亲和是全局的（租户间撞 identity 会互相粘错）、决策全局一套（没法按调用方分策略）。

## 方案（单进程多租户，否决第二实例）

第二实例会对同一批订阅凭据各自刷快照——违反「凭据刷新唯一负责人」，且有双库双看板。单进程内加租户维度：

- **鉴权即归属**：`tenants[]` 声明在 policy 里，每个租户一个 `key_env`；请求的 Bearer 命中哪个租户的 key 就归属哪个租户，全不匹配才 401。**声明了 tenants 就不再读 master_key_env 做鉴权**（main 租户显式写 key_env: 'CPR_MASTER_KEY' 即可）；不声明 tenants 时一切照旧（隐式租户 `default` + master key），外部用户零感知。
- **记账**：`requests`/`system_events` 各加 `tenant TEXT NOT NULL DEFAULT 'default'` 列。ALTER 带常量默认值，旧行自动落 `default`，无需回填语句。
- **亲和/冷却隔离**：归属与冷却查询从 (identity_kind, identity_hash) 扩成 (tenant, identity_kind, identity_hash)；租户间同 identity 不串粘。长会话判定（sessionSummary）同样按 (tenant, identity) 查账。
- **决策契约**：`DecisionCtx` 加 `tenant: string`；候选先按租户 `backends` 子集过滤再进 policy/内置月欠账；租户 `models` allowlist 之外的模型 400。
- **管理口/看板**：`/api/audit/*` 与 `/api/audit/sessions/{id}` 接受 `?tenant=`；`/api/route/status` 附 `tenants` 清单供看板下拉；mappings 概览按租户分列。

## 边界（第一版不做）

- **额度不隔离**：订阅是上游账号的物理属性，租户共享池子；「Hermes 每天最多烧 N token」类租户预算留作后续引擎护栏。
- **池子不限定**：本机 mine.ts 两租户都不写 backends/models 子集（先分账，跑一两周看 Hermes 实际烧量再决定收紧）。
- key 仍只在 `/root/.config/coding-plan-router/.env`，不进仓；Hermes 侧换 key 属生产 config 改动，部署时单独授权。

## 声明形状

```ts
tenants = [
  { name: 'main',   key_env: 'CPR_MASTER_KEY' },
  { name: 'hermes', key_env: 'CPR_TENANT_HERMES_KEY' },
];
// 可选开关（本机暂不用）：backends?: string[]（订阅 name 子集）、models?: string[]（模型 id allowlist）
```

## 兼容面

- 不声明 tenants：隐式 `default` 租户 + master key 鉴权，行为与 v0.1.0 逐字节一致；账本/事件行 tenant 列恒 'default'。
- 旧库：开库时 ALTER 自动加列，旧行 = 'default'；与 ttft_ms 同套路（SCHEMA 管新库、PRAGMA+ALTER 管旧库）。
- `session.pin`/`rebind_cooldown_ms`/`db_file` 等旧名兼容不受影响。

## 交付面改动清单

contracts.ts（Tenant/AuditEntry.tenant/AuditRow.tenant/GatewayConfig.tenants）、policy/contract.ts（RouterPolicy.tenants + ctx.tenant）、policy/config.ts（校验：唯一 name、必填 key_env、backends/models 子集引用必须存在）、store/db.ts（双表加列）、store/events.ts（tenant 进 INSERT 与三条查询、overview 分租户）、store/audit.ts（INSERT 加列、listRequests/listSessions/summary/sessionSummary 过滤）、http/server.ts（authenticate、候选/模型过滤、ctx、事件与账本带 tenant、admin ?tenant=）、mine.ts（两租户声明）、main.ts（启动行报租户清单）、static/dashboard.html（租户下拉 + 传参）、docs/policy-guide.md（ctx.tenant 铁律）、GLOSSARY（Tenant 词条）、ADR-0007。
测试：test/tenants.test.ts（鉴权/亲和隔离/记账/ctx/backends 子集/models allowlist/旧库迁移/无声明兼容）+ 既有调用点适配。
