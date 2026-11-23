import { DatabaseSync } from 'node:sqlite';
import { applyBaseline } from './migrate.ts';

// 数据库单文件：流量账 requests + 决策账 system_events 共库（2026-11-18 起，取代 sessions.db/usage.db 双文件）。
// 打开失败直接抛（fail fast）：记账是网关存在的理由之一，打不开库的进程不该跑路由；
// 运行中写入失败仍走各 store 的降级路径（不阻塞转发）。
// 基线结构（SCHEMA/补列/索引）在 migrate.ts 的 applyBaseline——版本机（user_version + 备份）由 server 启动时挂。

export function openDatabase(dbFile: string, { baseline = true }: { baseline?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(dbFile);
  // 旧双库防线：指向旧 sessions.db（有 session_routes/identity_migrations 但无 requests）
  // 或旧 usage.db（requests 带 routing_note 列）时拒绝启动——否则会在旧库里静默建空表、
  // 亲和与长会话历史全部归零。必须先跑 packages/cli/scripts/migrate-dbs.ts 合库。
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!tables.has('requests') && (tables.has('session_routes') || tables.has('identity_migrations'))) {
    db.close();
    throw new Error(`${dbFile} 是旧版会话库（含 session_routes/identity_migrations，无 requests 表）——请先运行 packages/cli/scripts/migrate-dbs.ts 合库为 data.db，不要把 CPR_DB_FILE 指向旧库`);
  }
  if (tables.has('requests')) {
    const columns = new Set((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((entry) => entry.name));
    if (columns.has('routing_note')) {
      db.close();
      throw new Error(`${dbFile} 是旧版用量库（requests 含 routing_note 列）——请先运行 packages/cli/scripts/migrate-dbs.ts 合库为 data.db，不要把 CPR_DB_FILE 指向旧 usage.db`);
    }
  }
  db.exec('PRAGMA journal_mode=WAL');
  // 基线结构（双表 + 补列 + 索引）收编进 migrate.ts 的 applyBaseline（工单 04）。
  // 默认仍在此处跑（直连入口：audit.ts 的 dbFile 路径与既有测试依赖此行为）；
  // server 启动路径传 baseline:false，让基线在迁移步骤 1 里跑——备份先于任何结构变更（review P2 修正）。
  if (baseline) applyBaseline(db);
  return db;
}
