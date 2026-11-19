// DB 迁移三件套（v0.2.0，spec .scratch/llm-cpr-npm-form/issues/04）：
//   1) PRAGMA user_version + 有序步骤表——只升不降；库版本高于代码 → 拒启动（fail fast）。
//   2) 分工：加法类（加列/加表/加索引）留在 applyBaseline 幂等路径（openDatabase 每次开库都会跑，
//      SCHEMA 管新建、PRAGMA table_info + ALTER 管旧库——沿用立仓以来的加列套路）；
//      非幂等的重活（搬数、换表）进步骤表，每步一个事务、完成即写 user_version，中断可续。
//   3) 有存量数据的库升级前自动备份：WAL checkpoint(TRUNCATE) + 拷贝到 <库目录>/backups/<时间戳>/
//      + integrity_check；备份或校验失败 → 拒绝改库（宁可停服务不半迁移）。
// 步骤必须幂等：新库经 applyBaseline 已是最新形状，步骤对其应 no-op（列存在即跳过）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

// 基线（版本 1）：data.db 双表 + 补列 + 看板索引，全部幂等。
// 从 openDatabase 原文收编（2026-11-19，工单 04）——行为逐字保持。
const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tenant TEXT NOT NULL DEFAULT 'default',
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
  tenant TEXT NOT NULL DEFAULT 'default',
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

export function applyBaseline(db: DatabaseSync): void {
  db.exec(BASELINE_SCHEMA);
  // 旧库列迁移（ttft/stream + tenant）：只对「早于当前 schema 的表」触发，新库由 SCHEMA 直接建全。
  // tenant 用 ALTER ... NOT NULL DEFAULT 'default'：SQLite 对常量默认值允许，旧行立即落到 'default'，无需回填语句。
  const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
  for (const [name, ddl] of [['ttft_ms', 'INTEGER'], ['stream_ms', 'INTEGER'], ['tenant', "TEXT NOT NULL DEFAULT 'default'"]] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${ddl}`);
  }
  const eventColumns = new Set((db.prepare('PRAGMA table_info(system_events)').all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!eventColumns.has('tenant')) db.exec(`ALTER TABLE system_events ADD COLUMN tenant TEXT NOT NULL DEFAULT 'default'`);
  // 看板查询索引：必须建在列迁移之后（sub_agg 依赖 ttft_ms/stream_ms），老库新库统一走这里。
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sess_group ON requests(identity, identity_kind, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sub_agg ON requests(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms)');
}

export interface MigrationStep {
  name: string;
  up: (db: DatabaseSync) => void;
}

// 步骤表：第 1 版是基线标记（结构由 applyBaseline 保证），后续非幂等变更从 version 2 起追加。
// 加法类新列仍进 applyBaseline（SCHEMA + ALTER 两半），不占步骤号；步骤号留给搬数/换表/破坏性变更。
const STEPS: MigrationStep[] = [];

export interface MigrationResult {
  status: 'fresh' | 'upgraded' | 'current';
  from: number;
  to: number;
  applied: string[];
  backupDir?: string;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint };
  return Number(row.user_version ?? 0);
}

function hasRequests(db: DatabaseSync): boolean {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((entry) => entry.name));
  return tables.has('requests');
}

// fresh 判定在 applyBaseline 之后做（openDatabase 开库即建表），所以不能看「表存在」，
// 要看「表里有没有行」：版本机之前的存量库必有数据；刚建的新库是空表。
function isEmptyDb(db: DatabaseSync): boolean {
  if (!hasRequests(db)) return true;
  const row = db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number | bigint };
  return Number(row.n) === 0;
}

// 迁移前备份：WAL checkpoint + 拷贝 + integrity check。任何一环失败都抛（调用方 fail fast 拒启动）。
function backupBeforeMigrate(db: DatabaseSync, dbFile: string): string {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dbFile), 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(dbFile, path.join(dir, path.basename(dbFile)));
  const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
  if (String(check.integrity_check) !== 'ok') {
    throw new Error(`${dbFile} integrity_check 未通过（${String(check.integrity_check)}），拒绝迁移——库已原样保留，备份在 ${dir}`);
  }
  return dir;
}

export function runMigrations(db: DatabaseSync, { dbFile, steps = STEPS, targetVersion = SCHEMA_VERSION }: { dbFile: string; steps?: MigrationStep[]; targetVersion?: number }): MigrationResult {
  const version = userVersion(db);
  if (version > targetVersion) {
    throw new Error(`库 schema 版本 ${version} 高于代码支持的 ${targetVersion}——库来自更新版本的 llm-cpr，请先升级代码（npm i -g llm-cpr@latest）再启动`);
  }
  if (version === targetVersion) return { status: 'current', from: version, to: version, applied: [] };

  const fresh = version === 0 && isEmptyDb(db);
  let backupDir: string | undefined;
  if (!fresh) {
    // 有存量数据的库先备份再动（新库无物可失）。
    backupDir = backupBeforeMigrate(db, dbFile);
  }

  const applied: string[] = [];
  // 从 version+1 升到 targetVersion；基线（v1）是幂等标记，重放无害。
  for (let next = version + 1; next <= targetVersion; next += 1) {
    const name = next === 1
      ? 'baseline: 双表 + 补列 + 索引（幂等，由 openDatabase 的 applyBaseline 保证）'
      : steps[next - 2]?.name;
    if (next === 1) {
      // 基线：结构由 openDatabase 的 applyBaseline 保证，这里只原子地写版本号。
      db.exec('BEGIN');
      try {
        db.exec('PRAGMA user_version = 1');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`标记 schema v1 失败：${error instanceof Error ? error.message : String(error)}——事务已回滚${backupDir ? `，备份在 ${backupDir}` : ''}`);
      }
    } else {
      const step = steps[next - 2];
      if (!step) throw new Error(`内部错误：schema v${next} 缺步骤定义（targetVersion=${targetVersion}，步骤表只有 ${steps.length} 步）`);
      db.exec('BEGIN');
      try {
        step.up(db);
        db.exec(`PRAGMA user_version = ${next}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`迁移到 schema v${next}（${step.name}）失败：${error instanceof Error ? error.message : String(error)}——事务已回滚${backupDir ? `，备份在 ${backupDir}` : ''}`);
      }
    }
    applied.push(name ?? `schema v${next}`);
  }
  return { status: fresh ? 'fresh' : 'upgraded', from: version, to: targetVersion, applied, backupDir };
}
