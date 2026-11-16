#!/usr/bin/env node
// 把 SQLite 库从旧目录搬到新目录：先 WAL checkpoint，再复制，再校验完整性与行数。
// 必须在服务已停止时运行（脚本会拒绝在有其他连接持有写锁时继续）。
//
// 用法：
//   node scripts/xdg-deploy/migrate-dbs.ts \
//     --sessions-db /root/workspace/services/coding-plan-router/sessions.db \
//     --usage-db    /root/workspace/services/coding-plan-router/usage.db \
//     --dest-dir    /root/.local/share/coding-plan-router \
//     --backup-dir  /root/.local/share/coding-plan-router/backups/<ts>
//
// 行为：不改动源文件；目标目录里已有的同名库会被拒绝覆盖（防止误覆盖生产数据）。
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
const destDir = argOf('dest-dir');
const backupDir = argOf('backup-dir');
if (!sessionsDb || !usageDb || !destDir || !backupDir) {
  console.error('缺少参数：--sessions-db / --usage-db / --dest-dir / --backup-dir 都必须提供');
  process.exit(2);
}
if (path.dirname(sessionsDb) === path.resolve(destDir) || path.dirname(usageDb) === path.resolve(destDir)) {
  console.error('源库已在新目录里，拒绝重复迁移');
  process.exit(2);
}

fs.mkdirSync(destDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;
type ProbeResult = { integrity: SqlRow[string] } & Record<string, unknown>;
type Kind = 'sessions' | 'usage';
interface PlanItem {
  kind: Kind; src: string; before?: ProbeResult; after?: ProbeResult;
  walBytes?: number; checkpoint?: SqlRow; sha256?: string; backupPath?: string; destPath?: string;
}
function row(db: DatabaseSync, sql: string): SqlRow {
  const result = db.prepare(sql).get();
  if (!result) throw new Error(`查询未返回结果：${sql}`);
  return result;
}
function groupRows(db: DatabaseSync, sql: string, key: string): Record<string, SqlRow[string]> {
  return Object.fromEntries(db.prepare(sql).all().map((r: SqlRow): [string, SqlRow[string]] => [String(r[key]), r.c]));
}

// 各库的关键断言：迁移前后必须完全一致。
const PROBES = {
  sessions: (db: DatabaseSync): Record<string, unknown> => ({
    session_routes: row(db, 'select count(*) c from session_routes').c,
    identity_migrations: row(db, 'select count(*) c from identity_migrations').c,
    by_backend: groupRows(db, 'select backend_name, count(*) c from session_routes group by 1', 'backend_name'),
  }),
  usage: (db: DatabaseSync): Record<string, unknown> => ({
    requests: row(db, 'select count(*) c from requests').c,
    max_id: row(db, 'select coalesce(max(id),0) m from requests').m,
    max_ts: row(db, 'select coalesce(max(ts),0) m from requests').m,
    by_subscription: groupRows(db, 'select subscription, count(*) c from requests group by 1', 'subscription'),
  }),
};

function probe(file: string, kind: Kind): ProbeResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = row(db, 'pragma integrity_check').integrity_check;
    return { integrity, ...PROBES[kind](db) };
  } finally { db.close(); }
}

function checkpoint(file: string): SqlRow {
  const db = new DatabaseSync(file);
  try {
    const result = row(db, 'pragma wal_checkpoint(TRUNCATE)');
    return result; // { busy, log, checkpointed }
  } finally { db.close(); }
}

function copyDurably(from: string, to: string): void {
  if (fs.existsSync(to)) throw new Error(`目标已存在，拒绝覆盖：${to}`);
  fs.copyFileSync(from, to);
  const fd = fs.openSync(to, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(to, 0o600);
}

const plan: PlanItem[] = [
  { kind: 'sessions', src: sessionsDb },
  { kind: 'usage', src: usageDb },
];
const report: { at: string; destDir: string; backupDir: string; databases: Record<string, unknown>; ok?: boolean } = { at: new Date().toISOString(), destDir, backupDir, databases: {} };

// 1) 源库预检 + WAL checkpoint
for (const item of plan) {
  if (!fs.existsSync(item.src)) throw new Error(`源库不存在：${item.src}`);
  item.before = probe(item.src, item.kind);
  if (item.before.integrity !== 'ok') throw new Error(`源库完整性检查失败：${item.src}`);
  item.walBytes = fs.existsSync(`${item.src}-wal`) ? fs.statSync(`${item.src}-wal`).size : 0;
  item.checkpoint = checkpoint(item.src);
  if (item.checkpoint.busy !== 0) throw new Error(`仍有连接持有 ${item.src} 的锁（busy=${item.checkpoint.busy}），确认服务已停止后再跑`);
  item.sha256 = sha256(item.src);
}

// 2) 复制到备份目录与新数据目录
for (const item of plan) {
  item.backupPath = path.join(backupDir, path.basename(item.src));
  copyDurably(item.src, item.backupPath);
  item.destPath = path.join(destDir, path.basename(item.src));
  copyDurably(item.src, item.destPath);
}

// 3) 校验：备份与目标都必须与源库逐项一致
for (const item of plan) {
  if (!item.destPath || !item.backupPath) throw new Error('复制路径未设置');
  item.after = probe(item.destPath, item.kind);
  const backupProbe = probe(item.backupPath, item.kind);
  if (item.after.integrity !== 'ok') throw new Error(`目标库完整性检查失败：${item.destPath}`);
  if (backupProbe.integrity !== 'ok') throw new Error(`备份库完整性检查失败：${item.backupPath}`);
  if (JSON.stringify(item.after) !== JSON.stringify(item.before)) {
    throw new Error(`目标库内容与源库不一致：${item.destPath}\n源=${JSON.stringify(item.before)}\n目标=${JSON.stringify(item.after)}`);
  }
  if (JSON.stringify(backupProbe) !== JSON.stringify(item.before)) {
    throw new Error(`备份库内容与源库不一致：${item.backupPath}`);
  }
  report.databases[item.kind] = {
    from: item.src,
    to: item.destPath,
    backup: item.backupPath,
    bytes: fs.statSync(item.destPath).size,
    sha256: item.sha256,
    walBytesBeforeCheckpoint: item.walBytes,
    counts: item.after,
  };
}

report.ok = true;
console.log(JSON.stringify(report, null, 2));
