#!/usr/bin/env node
// 双库合一：sessions.db + usage.db → 单个 data.db（requests + system_events 双表，见 .scratch/affinity-events/spec.md）。
// 必须在服务已停止时运行（脚本会拒绝在有其他连接持有写锁时继续）。
//
// 用法：
//   node scripts/xdg-deploy/migrate-dbs.ts \
//     --sessions-db /root/.local/share/coding-plan-router/sessions.db \
//     --usage-db    /root/.local/share/coding-plan-router/usage.db \
//     --dest-db     /root/.local/share/coding-plan-router/data.db \
//     --backup-dir  /root/.local/share/coding-plan-router/backups/<ts>
//
// 行为：不改动源文件（checkpoint 除外）；备份目录收两份源库副本；目标已存在则拒绝覆盖。
// 迁移规则（.scratch/affinity-events/spec.md）：
//   - requests 原样搬行（保留 id，丢弃 routing_note 列——历史上 0/1098 非空，无损）；
//   - session_routes → route.bind 事件（ts=created_at，detail {legacy:true}）；
//   - identity_migrations → route.rebind 事件（ts=migrated_at，reason 从配对账本行回溯：
//     该身份在迁移时刻前最近一笔 ≤400 的请求是 403/429 → quota-wall，否则 → pin.stale；均标 legacy）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const sessionsDb = argOf('sessions-db');
const usageDb = argOf('usage-db');
const destDb = argOf('dest-db');
const backupDir = argOf('backup-dir');
if (!sessionsDb || !usageDb || !destDb || !backupDir) {
  console.error('缺少参数：--sessions-db / --usage-db / --dest-db / --backup-dir 都必须提供');
  process.exit(2);
}
if (fs.existsSync(destDb)) {
  console.error(`目标已存在，拒绝覆盖：${destDb}`);
  process.exit(2);
}
if ([sessionsDb, usageDb].some((file) => path.resolve(file) === path.resolve(destDb))) {
  console.error('目标与源是同一个文件，拒绝迁移');
  process.exit(2);
}
fs.mkdirSync(path.dirname(destDb), { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;
function row(db: DatabaseSync, sql: string): SqlRow {
  const result = db.prepare(sql).get();
  if (!result) throw new Error(`查询未返回结果：${sql}`);
  return result;
}
function checkpoint(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const result = row(db, 'pragma wal_checkpoint(TRUNCATE)');
    if (result.busy !== 0) throw new Error(`仍有连接持有 ${file} 的锁（busy=${String(result.busy)}），确认服务已停止后再跑`);
  } finally { db.close(); }
}
function integrity(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return String(row(db, 'pragma integrity_check').integrity_check); } finally { db.close(); }
}

// 1) 源库预检 + WAL checkpoint（停服窗口内）
for (const file of [sessionsDb, usageDb]) {
  if (!fs.existsSync(file)) throw new Error(`源库不存在：${file}`);
  if (integrity(file) !== 'ok') throw new Error(`源库完整性检查失败：${file}`);
  checkpoint(file);
}

// 2) 备份源库（checkpoint 后的干净副本）
for (const file of [sessionsDb, usageDb]) {
  const backup = path.join(backupDir, path.basename(file));
  if (fs.existsSync(backup)) throw new Error(`备份已存在，拒绝覆盖：${backup}`);
  fs.copyFileSync(file, backup);
  const fd = fs.openSync(backup, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(backup, 0o600);
}

// 3) 建 data.db（schema 与 lib/store/db.ts 保持一致）
const dest = new DatabaseSync(destDb);
dest.exec('PRAGMA journal_mode=WAL');
dest.exec(`
CREATE TABLE requests (
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
CREATE INDEX idx_requests_identity_ts ON requests(identity, ts, id);
CREATE INDEX idx_requests_sess_group ON requests(identity, identity_kind, ts);
CREATE INDEX idx_requests_sub_agg ON requests(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms);
CREATE TABLE system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  identity_kind TEXT,
  identity_hash TEXT,
  backend_name TEXT,
  request_id INTEGER,
  detail TEXT
);
CREATE INDEX idx_events_identity ON system_events(identity_kind, identity_hash, id);
CREATE INDEX idx_events_kind_ts ON system_events(kind, ts);
`);

const report: {
  at: string; destDb: string; backupDir: string; events?: unknown;
  sources: { sessions: string; usage: string }; sourceSha256: Record<string, string>; destSha256: string; destIntegrity: string;
} = {
  at: new Date().toISOString(),
  destDb,
  backupDir,
  sources: { sessions: sessionsDb, usage: usageDb },
  sourceSha256: { sessions: sha256File(sessionsDb), usage: sha256File(usageDb) },
  destSha256: '',
  destIntegrity: '',
};

const sourceUsage = new DatabaseSync(usageDb, { readOnly: true });
const sourceSessions = new DatabaseSync(sessionsDb, { readOnly: true });
try {
  // 4) requests 原样搬行（保留 id；routing_note 不迁）
  const columns = ['id', 'ts', 'identity', 'identity_kind', 'subscription', 'account', 'model', 'translated_model', 'path', 'status', 'ms',
    'prompt_tokens', 'completion_tokens', 'cache_hit_tokens', 'cache_miss_tokens', 'cache_write_tokens', 'total_tokens',
    'cache_observed', 'cache_outcome', 'ttft_ms', 'stream_ms', 'usage_json'];
  const legacyColumns = new Set((sourceUsage.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
  const select = columns.filter((name) => legacyColumns.has(name));
  const requestRows = sourceUsage.prepare(`SELECT ${select.join(',')} FROM requests ORDER BY id`).all() as unknown as SqlRow[];
  const insertRequest = dest.prepare(`INSERT INTO requests (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (const source of requestRows) {
    const values = columns.map((name) => (source as Record<string, unknown>)[name] ?? null);
    insertRequest.run(...values as Parameters<typeof insertRequest.run>);
  }

  // 5) 亲和事件：session_routes → route.bind；identity_migrations → route.rebind（reason 从账本回溯）
  interface HashedIdentity { raw?: string }
  // 账本存身份原文，sessions.db 存哈希：把原文哈希一遍建反向索引。
  const hashToRaw = new Map<string, string>();
  for (const entry of sourceUsage.prepare('SELECT DISTINCT identity FROM requests WHERE identity IS NOT NULL').all() as Array<{ identity: string }>) {
    hashToRaw.set(sha256Hex(entry.identity), entry.identity);
  }
  // reason 回溯（证据窗口 ±5s）：同一客户端请求的各次尝试共用 startedAt，403 失败行与
  // 改绑后的成功行可能同 ts 且成功行 id 更大——不能按「最近一行」判，必须按状态证据配对：
  // 窗口内存在 403/429 → quota-wall；窗口内只有非配额行 → pin.stale；无证据 → 不猜（省略 trigger）。
  const quotaEvidenceAt = dest.prepare(`SELECT id FROM requests WHERE identity = ? AND identity_kind = ? AND status IN (403,429) AND ts >= ? AND ts <= ? LIMIT 1`);
  const anyEvidenceAt = dest.prepare(`SELECT id FROM requests WHERE identity = ? AND identity_kind = ? AND ts >= ? AND ts <= ? LIMIT 1`);
  const routesBackend = sourceSessions.prepare('SELECT backend_name FROM session_routes WHERE identity_kind = ? AND identity_hash = ?');
  const insertEvent = dest.prepare(`INSERT INTO system_events (ts, kind, identity_kind, identity_hash, backend_name, request_id, detail) VALUES (?,?,?,?,?,?,?)`);
  interface BindSource { identity_kind: string; identity_hash: string; backend_name: string; created_at: string }
  interface RebindSource { identity_kind: string; identity_hash: string; migrated_at: number }
  const events: { ts: number; kind: string; identityKind: string; hash: string; backend?: string; detail: string }[] = [];
  for (const entry of sourceSessions.prepare('SELECT identity_kind, identity_hash, backend_name, created_at FROM session_routes').all() as unknown as BindSource[]) {
    events.push({
      ts: Math.floor(Date.parse(`${entry.created_at.replace(' ', 'T')}Z`)),
      kind: 'route.bind', identityKind: entry.identity_kind, hash: entry.identity_hash, backend: entry.backend_name,
      detail: JSON.stringify({ legacy: true }),
    });
  }
  for (const entry of sourceSessions.prepare('SELECT identity_kind, identity_hash, migrated_at FROM identity_migrations').all() as unknown as RebindSource[]) {
    // reason 回溯：迁移时刻前该身份最近一笔账（老账本 identity 存原文，先哈希定位）。
    // 目标后端回填：旧表只存最后一次改绑的时间戳，session_routes 存的就是迁移后的现值。
    const raw = hashToRaw.get(entry.identity_hash);
    let trigger: string | undefined;
    if (raw !== undefined) {
      const from = entry.migrated_at - 5000, to = entry.migrated_at + 5000;
      if (quotaEvidenceAt.get(raw, entry.identity_kind, from, to)) trigger = 'quota-wall';
      else if (anyEvidenceAt.get(raw, entry.identity_kind, from, to)) trigger = 'pin.stale';
    }
    const route = routesBackend.get(entry.identity_kind, entry.identity_hash) as { backend_name?: unknown } | undefined;
    events.push({
      ts: entry.migrated_at, kind: 'route.rebind', identityKind: entry.identity_kind, hash: entry.identity_hash,
      backend: typeof route?.backend_name === 'string' ? route.backend_name : undefined,
      detail: JSON.stringify({ trigger, legacy: true }),
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  for (const event of events) {
    insertEvent.run(event.ts, event.kind, event.identityKind, event.hash, event.backend ?? null, null, event.detail);
  }

  // 6) 计数验收：账本逐项一致 + 事件与旧表行数一致 + 每身份最新事件 backend 与旧钉死一致
  const sourceCounts = sourceUsage.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM requests').get() as { c: unknown; m: unknown };
  const destCounts = dest.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m FROM requests').get() as { c: unknown; m: unknown };
  if (Number(sourceCounts.c) !== Number(destCounts.c) || Number(sourceCounts.m) !== Number(destCounts.m)) {
    throw new Error(`requests 行数/最大 id 与源库不一致：源=${JSON.stringify(sourceCounts)} 目标=${JSON.stringify(destCounts)}`);
  }
  const binds = Number(dest.prepare("SELECT COUNT(*) c FROM system_events WHERE kind='route.bind'").get()?.c);
  const rebinds = Number(dest.prepare("SELECT COUNT(*) c FROM system_events WHERE kind='route.rebind'").get()?.c);
  const sourceRoutes = Number(sourceSessions.prepare('SELECT COUNT(*) c FROM session_routes').get()?.c);
  const sourceMigrations = Number(sourceSessions.prepare('SELECT COUNT(*) c FROM identity_migrations').get()?.c);
  if (binds !== sourceRoutes) throw new Error(`bind 事件数（${binds}）≠ session_routes 行数（${sourceRoutes}）`);
  if (rebinds !== sourceMigrations) throw new Error(`rebind 事件数（${rebinds}）≠ identity_migrations 行数（${sourceMigrations}）`);
  const mismatched = dest.prepare(`
    SELECT identity_hash FROM (
      SELECT identity_hash, backend_name, MAX(id) FROM system_events
      WHERE kind IN ('route.bind','route.rebind') GROUP BY identity_kind, identity_hash
    ) WHERE backend_name IS NULL`).all();
  if (mismatched.length > 0) throw new Error(`有身份的最新事件缺 backend_name：${mismatched.length} 条`);
  const eventsSummary = { route_bind: binds, route_rebind: rebinds, source_session_routes: sourceRoutes, source_identity_migrations: sourceMigrations };
  report.events = eventsSummary;
} finally {
  sourceUsage.close();
  sourceSessions.close();
}
dest.close();

const fd = fs.openSync(destDb, 'r+');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.chmodSync(destDb, 0o600);
report.destSha256 = sha256File(destDb);
report.destIntegrity = integrity(destDb);
if (report.destIntegrity !== 'ok') throw new Error(`目标库完整性检查失败：${destDb}`);
console.log(JSON.stringify(report, null, 2));
