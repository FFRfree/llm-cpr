# Affinity 词汇 + 双表事件模型（data.db）

2026-11-18 与用户逐条拍板（本对话），替代所有旧词汇与旧存储形态。

## 词汇（GLOSSARY/ADR-0006 正本）

- Pinning/会话钉死 → **Affinity/亲和**：身份↔订阅的持久归属。
- Migration/错误迁移 → **Rebind/改绑**：403/429 或 policy 覆写导致的归属变更。
- sticky-long（长会话保钉死）→ **keep-affinity**（长会话保亲和）。
- 配置键 `migration_cooldown_ms` → `rebind_cooldown_ms`（旧键别名兼容）。
- ctx 字段 `session.pin` → `session.affinity`（过渡期双字段同值，pin 标 deprecated）。
- 声明字段 `sessions_db` → `db_file`（旧名别名兼容）。

## 存储：一个 `data.db`、两张表（取代 sessions.db + usage.db 四张表）

- **`requests`**：流量账，一行 = 一次发往上游的 LLM 请求（含上游拒绝；现查证实全部行含 subscription）。现 22 列去掉 `routing_note`（历史 0/1098 非空，无损）。
- **`system_events`**：决策账，一行 = 网关一次自主动作。`kind` 开放枚举；首批 route.bind / route.rebind / route.hold / policy.error。
- 打不开库 → fail fast 拒绝启动（记账是网关存在理由，没账的流量不该跑）；运行中写入失败仍降级（不写账继续路由 + historyIncomplete 锁存）。

### system_events DDL

```sql
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  identity_kind TEXT,
  identity_hash TEXT,
  backend_name TEXT,
  request_id INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_identity ON system_events(identity_kind, identity_hash, id);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON system_events(kind, ts);
```

### 事件语义

- `route.bind`：新身份首次指定后端。detail `{trigger:'new-session'|'stale-pin', source:'policy'|'builtin', note?}`。request_id 为空（首请求账本行在响应完成后才落，配对靠身份+ts 隐式）。
- `route.rebind`：归属变更。detail `{trigger:'quota-wall'|'policy-override'|'stale-pin', source, note?}` + request_id（错误路径与失败账本行同事务成对）。
- `route.hold`：撞墙但不改绑。detail `{cause:'sticky-long'|'cooldown'|'no-alternate'|'policy-keep', status}` + request_id。
- `policy.error`：decide 抛错或返回非法。detail `{error}`。
- 状态全为派生查询：当前归属 = 每身份最新 bind/rebind；改绑次数 = rebind 计数；冷却 = 最新 rebind ts 距今 < cooldown。冷却只认 rebind 不认 bind（新会话首绑不得自带改绑锁）。

## 契约：Decision +reason

`{backend, model?, reason?}` | 'keep' | null。用户自己的话进事件 note（source=policy）；引擎事实（trigger/cause）是固定枚举，不由 policy 声明。decided_by 概念废除，只剩 `source` 一个词（回答"是不是我的规则在生效"）。

## 兼容面（v0.1.0 外部用户）

- `rebind_cooldown_ms` 旧名 `migration_cooldown_ms` 仍读；`session.affinity` 旧名 `session.pin` 仍填（同值）；`db_file` 旧名 `sessions_db` 仍读；`CPR_DB_FILE` 旧 env `CPR_SESSIONS_DB` 仍读。
- 账本历史 routing_note 全 null，直接不迁该列。

## 数据迁移（生产，需单独授权）

停服 → `migrate-dbs.ts` 建 data.db：session_routes 125 行 → route.bind 事件（ts=created_at），identity_migrations 4 行 → route.rebind 事件（ts=migrated_at，reason 从配对账本行回溯，标 legacy），requests 1098 行原样（去 routing_note 列）→ 三组计数验收 → unit env 换 `CPR_DB_FILE` → 起 release。旧两文件原地留证不删。

## 交付面改动清单

contracts/policy-contract 类型；store/db.ts 新增、identity.ts 删除、events.ts 新增、audit.ts 收口；server.ts 决策点改写；builtin-decide note→reason/hold；config.ts 校验键；dashboard 词汇；测试改名+重写（identity→events、migration-cooldown→rebind-cooldown、error-migration→error-rebind）；GLOSSARY/ADR-0002 改名/ADR-0006 新立/policy-guide/deployment/README/AGENTS/design 同步；scripts（smoke-release env、migrate-dbs 重写、cpr.ts unit 模板）。本机技能文件与 references 随后单独更新。
