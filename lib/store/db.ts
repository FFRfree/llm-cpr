import { DatabaseSync } from 'node:sqlite';

// 数据库单文件：流量账 requests + 决策账 system_events 共库（2026-11-18 起，取代 sessions.db/usage.db 双文件）。
// 打开失败直接抛（fail fast）：记账是网关存在的理由之一，打不开库的进程不该跑路由；
// 运行中写入失败仍走各 store 的降级路径（不阻塞转发）。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  identity TEXT,
  identity_kind TEXT NOT NULL,
  subscription TEXT,
  account TEXT,
  model TEXT,
  translated_model TEXT,
  path TEXT,
  status INTEGER,
  ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cache_observed INTEGER NOT NULL DEFAULT 0,
  cache_outcome TEXT,
  ttft_ms INTEGER,
  stream_ms INTEGER,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_identity_ts ON requests(identity, ts, id);
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
`;

export function openDatabase(dbFile: string): DatabaseSync {
  const db = new DatabaseSync(dbFile);
  // 旧双库防线：指向旧 sessions.db（有 session_routes/identity_migrations 但无 requests）
  // 或旧 usage.db（requests 带 routing_note 列）时拒绝启动——否则会在旧库里静默建空表、
  // 亲和与长会话历史全部归零。必须先跑 scripts/xdg-deploy/migrate-dbs.ts 合库。
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!tables.has('requests') && (tables.has('session_routes') || tables.has('identity_migrations'))) {
    db.close();
    throw new Error(`${dbFile} 是旧版会话库（含 session_routes/identity_migrations，无 requests 表）——请先运行 scripts/xdg-deploy/migrate-dbs.ts 合库为 data.db，不要把 CPR_DB_FILE 指向旧库`);
  }
  if (tables.has('requests')) {
    const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
    if (columns.has('routing_note')) {
      db.close();
      throw new Error(`${dbFile} 是旧版用量库（requests 含 routing_note 列）——请先运行 scripts/xdg-deploy/migrate-dbs.ts 合库为 data.db，不要把 CPR_DB_FILE 指向旧 usage.db`);
    }
  }
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  // 旧库列迁移（ttft/stream）：只对「早于 2026-11-17 schema 的 requests 表」触发，新库由 SCHEMA 直接建全。
  const columns = new Set(db.prepare('PRAGMA table_info(requests)').all().map((entry) => String(entry.name)));
  for (const [name, ddl] of [['ttft_ms', 'INTEGER'], ['stream_ms', 'INTEGER']] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${ddl}`);
  }
  // 看板查询索引：必须建在列迁移之后（sub_agg 依赖 ttft_ms/stream_ms），老库新库统一走这里。
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sess_group ON requests(identity, identity_kind, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sub_agg ON requests(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms)');
  return db;
}
