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
  usage_json TEXT,
  capture_id TEXT
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
  // 观测层锚点列（observability 票 01，加法迁移不占步骤号）：账本行 ↔ capture.db turns 的关联键。
  // 旧行自然 NULL = 未捕获；capture_id 存在但查无 turn = 侧库降级缺行（不可宣称完整）。
  if (!columns.has('capture_id')) db.exec('ALTER TABLE requests ADD COLUMN capture_id TEXT');
  // 看板查询索引：必须建在列迁移之后（sub_agg 依赖 ttft_ms/stream_ms），老库新库统一走这里。
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sess_group ON requests(identity, identity_kind, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sub_agg ON requests(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms)');
}

export interface MigrationStep {
  name: string;
  up: (db: DatabaseSync) => void;
}

// 步骤表：第 1 步是基线（双表 + 补列 + 索引，幂等——SCHEMA 管新建、PRAGMA table_info + ALTER 管旧库，
// 沿用立仓以来的加列套路）。加法类新列继续改 applyBaseline（不占新步骤号）；
// 非幂等重活（搬数/换表/破坏性）从 v2 起追加步骤，每步一个事务、完成即写 user_version，中断可续。
// 基线只在迁移步骤里跑（server 走 openDatabase({baseline:false})）——备份先于任何结构变更（review P2 修正）。
const STEPS: MigrationStep[] = [
  {
    name: 'baseline: 双表 + 补列 + 索引（幂等）',
    up: (db) => { applyBaseline(db); },
  },
];

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

// fresh 判定在版本机里做（server 开库不带基线），看「两本账都没有行」：
// 版本机之前的存量库必有数据；requests 为空但 system_events 有行也是存量（决策账本身是持久数据）。
function isEmptyDb(db: DatabaseSync): boolean {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((entry) => entry.name));
  const countOf = (table: string): number => {
    if (!tables.has(table)) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
    return Number(row.n);
  };
  return countOf('requests') === 0 && countOf('system_events') === 0;
}

// 迁移前备份：WAL checkpoint（busy 即拒，绝不带不完整快照继续）+ 拷贝 + 对**备份产物**做 integrity check。
// 任何一环失败都抛（调用方 fail fast 拒启动）。
function backupBeforeMigrate(db: DatabaseSync, dbFile: string): string {
  const ckpt = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number | bigint; log?: number; checkpointed?: number };
  if (Number(ckpt.busy ?? 0) !== 0) {
    throw new Error(`WAL checkpoint busy（${JSON.stringify(ckpt)}）——还有别的连接持着读快照，此刻备份会缺最新已提交数据；先停掉占用本库的进程再启动`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dbFile), 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const copyPath = path.join(dir, path.basename(dbFile));
  fs.copyFileSync(dbFile, copyPath);
  // 校验的是备份产物本身（review P1 修正）：源库 integrity 不能证明拷贝可用。
  const verify = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const check = verify.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    if (String(check.integrity_check) !== 'ok') {
      throw new Error(`迁移前备份 ${copyPath} integrity_check 未通过（${String(check.integrity_check)}）——库已原样保留，拒绝迁移`);
    }
  } finally {
    verify.close();
  }
  return dir;
}

export function runMigrations(db: DatabaseSync, { dbFile, steps = STEPS, targetVersion = SCHEMA_VERSION }: { dbFile: string; steps?: MigrationStep[]; targetVersion?: number }): MigrationResult {
  const version = userVersion(db);
  if (version > targetVersion) {
    throw new Error(`库 schema 版本 ${version} 高于代码支持的 ${targetVersion}——库来自更新版本的 llm-cpr，请先升级代码（cpr upgrade）再启动`);
  }
  // 「已是最新版本」不等于「形状最新」：加法类新列走 applyBaseline 幂等补齐（列存在即跳过），
  // 不占步骤号、不触发备份——纯 ADD COLUMN/CREATE INDEX IF NOT EXISTS，与历史上 openDatabase
  // 每次开库跑基线的语义同权。漏掉这里的教训见 2026-11-19 生产火情：v1 老库开 0.3.0 直接
  // `no column named capture_id` 拒启动（升级器冒烟用的是新库，测不出存量库缺列）。
  if (version === targetVersion) {
    db.exec('BEGIN');
    try {
      applyBaseline(db);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`存量库补齐基线形状失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: 'current', from: version, to: version, applied: [] };
  }

  const fresh = version === 0 && !hasRequests(db) && isEmptyDb(db);
  let backupDir: string | undefined;
  if (!fresh) {
    // 有存量数据的库先备份再动（新库无物可失）。
    backupDir = backupBeforeMigrate(db, dbFile);
  }

  const applied: string[] = [];
  // 从 version+1 升到 targetVersion；steps[next-1] 对应版本 next（steps[0]=基线）。基线幂等，重放无害。
  for (let next = version + 1; next <= targetVersion; next += 1) {
    const step = steps[next - 1];
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
    applied.push(step.name);
  }
  return { status: fresh ? 'fresh' : 'upgraded', from: version, to: targetVersion, applied, backupDir };
}
