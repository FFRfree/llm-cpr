// v0.2.0 迁移三件套（工单 04）：user_version 只升不降、基线幂等、存量先备份、步骤事务化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../core/store/db.ts';
import { runMigrations, SCHEMA_VERSION } from '../core/store/migrate.ts';

const freshDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-migrate-'));
const userVersion = (db: DatabaseSync): number => Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);

// 手工搭一个「版本机出现之前」的旧库：requests/system_events 存在但缺 tenant/ttft/stream 列（ALTER 管），
// 其余列齐全（非 ALTER 管——baseline 的看板索引要引用），无 user_version。
function buildPreVersioningDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    identity TEXT, identity_kind TEXT NOT NULL, subscription TEXT, account TEXT,
    model TEXT, translated_model TEXT, path TEXT, status INTEGER, ms INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER,
    cache_hit_tokens INTEGER, cache_miss_tokens INTEGER, cache_write_tokens INTEGER,
    total_tokens INTEGER, cache_observed INTEGER NOT NULL DEFAULT 0, cache_outcome TEXT, usage_json TEXT
  )`);
  db.exec(`CREATE TABLE system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    kind TEXT NOT NULL, identity_kind TEXT, identity_hash TEXT, backend_name TEXT, request_id INTEGER, detail TEXT
  )`);
  db.exec("INSERT INTO requests (ts, identity, identity_kind, subscription, status, ms) VALUES (1, 'sess-a', 'session', 'sub-old', 200, 5)");
  db.close();
}

test('migrate：新库 → fresh 标 v1，无备份目录', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  const db = openDatabase(file);
  const result = runMigrations(db, { dbFile: file });
  assert.equal(result.status, 'fresh');
  assert.equal(result.to, SCHEMA_VERSION);
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.ok(fs.existsSync(path.join(dir, 'data.db')));
  assert.ok(!fs.existsSync(path.join(dir, 'backups'))); // 新库无物可失，不备份
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate：版本机之前的存量库 → 升级前自动备份、行保留 tenant=default、标 v1', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  buildPreVersioningDb(file);
  const db = openDatabase(file); // applyBaseline 幂等补齐列
  const result = runMigrations(db, { dbFile: file });
  assert.equal(result.status, 'upgraded');
  assert.equal(userVersion(db), 1);
  // 备份存在且是有效副本
  assert.ok(result.backupDir && fs.existsSync(result.backupDir));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'data.db')));
  // 旧行保留，tenant 落默认值
  const row = db.prepare('SELECT tenant, subscription FROM requests').get() as { tenant: string; subscription: string };
  assert.equal(row.tenant, 'default');
  assert.equal(row.subscription, 'sub-old');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate：已是当前版本 → current 零动作、不再备份', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  const db = openDatabase(file);
  runMigrations(db, { dbFile: file });
  const again = runMigrations(db, { dbFile: file });
  assert.equal(again.status, 'current');
  assert.equal(again.applied.length, 0);
  assert.equal(again.backupDir, undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate：库版本高于代码 → 拒启动（fail fast）', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  const db = openDatabase(file);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 41}`);
  assert.throws(() => runMigrations(db, { dbFile: file }), /高于代码支持/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate：步骤执行落版本号（targetVersion 接缝）', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  const db = openDatabase(file);
  runMigrations(db, { dbFile: file });
  const steps = [{
    name: '测试步骤：加 requests.demo 列',
    up: (target: DatabaseSync) => { target.exec('ALTER TABLE requests ADD COLUMN demo TEXT'); },
  }];
  const result = runMigrations(db, { dbFile: file, steps, targetVersion: 2 });
  assert.equal(result.status, 'upgraded');
  assert.deepEqual(result.applied, [steps[0].name]);
  assert.equal(userVersion(db), 2);
  const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
  assert.ok(columns.has('demo'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate：步骤失败 → 事务回滚、版本号不动、存量库备份已在、数据完好', () => {
  const dir = freshDir();
  const file = path.join(dir, 'data.db');
  buildPreVersioningDb(file);
  const db = openDatabase(file);
  runMigrations(db, { dbFile: file }); // 到 v1（留有升级备份）
  const failing = [{
    name: '故意失败步骤',
    up: () => { throw new Error('注入失败'); },
  }];
  assert.throws(() => runMigrations(db, { dbFile: file, steps: failing, targetVersion: 2 }), /注入失败.*已回滚/);
  assert.equal(userVersion(db), 1); // 版本号停在已完成步
  const row = db.prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number | bigint };
  assert.equal(Number(row.n), 1); // 数据完好
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
