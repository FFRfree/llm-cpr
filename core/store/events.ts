import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Identity } from '../contracts.ts';
import type { Logger } from '../contracts.ts';

// 系统事件账（data.db 的 system_events 表）：网关每次自主动作一行。
// 路由状态没有独立的状态表——当前亲和 = 该身份最新一条 bind/rebind 事件，
// 改绑次数 = rebind 事件计数，冷却 = 最新一条 rebind 的 ts（bind 不计入冷却，
// 否则新会话首绑会自带一小时改绑锁）。状态即查询，历史即全部事件。

export type EventKind = 'route.bind' | 'route.rebind' | 'route.hold' | 'policy.error' | 'privacy.hit';

// detail 的形状按 kind 分工：
// route.bind / route.rebind → { trigger, source, note? }（引擎事实 + 来源 + policy 的 reason 或内置短语）
// route.hold → { cause, status }（撞墙但不改绑的护栏归因）
// policy.error → { error }（decide 抛错/非法的现场）
// privacy.hit → { rule, item_hash, capture_id, message_index, role }（泄漏取证命中，票 04；
//   绝不落命中原文——借 item_hash 回查 capture.db 定位「哪一轮、哪个角色、哪条消息」）
export interface RouteEventDetail {
  trigger?: 'new-session' | 'stale-pin' | 'policy-override' | 'quota-wall';
  source?: 'policy' | 'builtin';
  note?: string;
  cause?: 'keep-affinity' | 'cooldown' | 'no-alternate' | 'policy-keep';
  status?: number;
  error?: string;
  legacy?: boolean;
  rule?: string;
  item_hash?: string;
  capture_id?: string;
  message_index?: number;
  role?: string | null;
}

export interface SystemEventInput {
  kind: EventKind;
  ts?: number;
  tenant?: string;        // 归属租户；缺省 'default'（无租户声明/非请求事件）
  identity?: Identity;      // 非路由事件（快照失败、服务启动等）可无身份
  backendName?: string;
  requestId?: number;       // 触发它的账本行（错误路径的失败笔与事件同事务成对）
  detail?: RouteEventDetail;
}

export interface RouteMapping {
  tenant: string;
  backend: string;
  identities: number;
}

export interface SystemEventRow {
  id: number;
  ts: number;
  tenant: string;
  kind: string;
  identity_kind: string | null;
  identity_hash: string | null;
  backend_name: string | null;
  request_id: number | null;
  detail: string | null;
}

const identityHash = (key: string): string => createHash('sha256').update(String(key)).digest('hex');
const backendOf = (row: Record<string, unknown> | undefined): string | undefined =>
  typeof row?.backend_name === 'string' ? row.backend_name : undefined;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createSystemEventStore(db: DatabaseSync, logger: Logger = console) {
  const insert = db.prepare(`INSERT INTO system_events (ts, tenant, kind, identity_kind, identity_hash, backend_name, request_id, detail) VALUES(?,?,?,?,?,?,?,?)`);
  // 归属与冷却按 (tenant, kind, key) 查询：租户间同 identity 不串粘（ADR-0007）。
  const affinityOf = db.prepare(`SELECT backend_name FROM system_events WHERE tenant = ? AND identity_kind = ? AND identity_hash = ?
    AND kind IN ('route.bind','route.rebind') ORDER BY id DESC LIMIT 1`);
  const lastRebind = db.prepare(`SELECT ts FROM system_events WHERE tenant = ? AND identity_kind = ? AND identity_hash = ?
    AND kind = 'route.rebind' ORDER BY id DESC LIMIT 1`);
  // 每身份最新一条 bind/rebind（SQLite 约定：聚合 MAX 所在行的裸列取自该行）再按租户+后端聚合。
  const overview = db.prepare(`SELECT tenant, backend_name AS backend, COUNT(*) AS identities FROM (
    SELECT tenant, identity_kind, identity_hash, backend_name, MAX(id) FROM system_events
    WHERE kind IN ('route.bind','route.rebind') AND identity_hash IS NOT NULL
    GROUP BY tenant, identity_kind, identity_hash
  ) GROUP BY tenant, backend_name ORDER BY tenant, backend_name`);

  return {
    append(input: SystemEventInput): number {
      const identity = input.identity;
      const info = insert.run(input.ts ?? Date.now(), input.tenant ?? 'default', input.kind,
        identity?.kind ?? null, identity ? identityHash(identity.key) : null,
        input.backendName ?? null, input.requestId ?? null,
        input.detail ? JSON.stringify(input.detail) : null);
      return Number(info.lastInsertRowid);
    },
    // 读路径不降级：读失败向上抛（unknown ≠ new identity——把读失败当新身份会静默重绑、
    // 作废上游 prompt cache，违反「宁保缓存」取向；请求报错由客户端重试，锁恢复即自愈）。
    // 该 (租户,身份) 当前亲和的订阅名；没有 bind/rebind 事件 = 新身份，undefined。
    affinity(tenant: string, kind: string, key: string): string | undefined {
      return backendOf(affinityOf.get(tenant, kind, identityHash(key)) as Record<string, unknown> | undefined);
    },
    // 冷却只认 rebind：bind 不触发冷却（新会话首绑不得自带改绑锁）。
    lastRebindAt(tenant: string, kind: string, key: string): number | undefined {
      const row = lastRebind.get(tenant, kind, identityHash(key)) as { ts?: unknown } | undefined;
      return typeof row?.ts === 'number' ? row.ts : undefined;
    },
    coolingDown(tenant: string, kind: string, key: string, now = Date.now(), cooldownMs = 3_600_000): boolean {
      const at = this.lastRebindAt(tenant, kind, key);
      return typeof at === 'number' && Number.isFinite(at) && now - at < cooldownMs;
    },
    mappingOverview(): RouteMapping[] {
      try {
        return (overview.all() as unknown as RouteMapping[]).map((row) => ({ tenant: String(row.tenant), backend: String(row.backend), identities: Number(row.identities) }));
      } catch (error) { logger.warn?.(`[events] degraded: overview read failed (${message(error)})`); return []; }
    },
    listEvents({ kind, tenant, limit = 100 }: { kind?: string; tenant?: string; limit?: number | string | null } = {}): SystemEventRow[] {
      const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
      const rows = kind === undefined && tenant === undefined
        ? db.prepare('SELECT * FROM system_events ORDER BY id DESC LIMIT ?').all(count)
        : kind !== undefined && tenant !== undefined
          ? db.prepare('SELECT * FROM system_events WHERE kind = ? AND tenant = ? ORDER BY id DESC LIMIT ?').all(kind, tenant, count)
          : kind !== undefined
            ? db.prepare('SELECT * FROM system_events WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, count)
            : db.prepare('SELECT * FROM system_events WHERE tenant = ? ORDER BY id DESC LIMIT ?').all(tenant!, count);
      return rows as unknown as SystemEventRow[];
    },
  };
}

export type SystemEventStore = ReturnType<typeof createSystemEventStore>;
