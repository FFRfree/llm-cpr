import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import type { AuditEntry, AuditRow, AuditSummary, CacheLossEvent, ChatUsage, Logger, SessionSummary, SubscriptionSummary } from '../contracts.ts';

const token = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
const ms = token;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface TokenFields {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cache_observed: boolean;
}

export function tokenFields(usage: ChatUsage | null | undefined): TokenFields {
  const source = record(usage);
  const details = record(source.prompt_tokens_details ?? source.input_tokens_details);
  const prompt = token(source.prompt_tokens ?? source.input_tokens);
  const completion = token(source.completion_tokens ?? source.output_tokens);
  const hit = token(details.cached_tokens ?? details.cache_read_input_tokens ?? source.cache_read_input_tokens ?? source.cache_hit_tokens);
  const miss = token(details.cache_miss_tokens ?? source.cache_miss_tokens ?? (prompt !== null && hit !== null ? Math.max(0, prompt - hit) : null));
  const write = token(details.cache_creation_tokens ?? details.cache_write_tokens ?? source.cache_write_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, cache_hit_tokens: hit, cache_miss_tokens: miss,
    cache_write_tokens: write, total_tokens: token(source.total_tokens ?? (prompt !== null && completion !== null ? prompt + completion : null)),
    cache_observed: hit !== null || miss !== null || write !== null };
}

// node:sqlite hands back untyped rows; the table shape is fixed by SCHEMA in db.ts.
const asRow = (row: Record<string, unknown>): AuditRow => row as unknown as AuditRow;

export class UsageAudit {
  // A failed append leaves a permanent gap, even if later reads/writes succeed.
  // Conservatively distrust all session totals for this instance (bounded state).
  // This latch is memory-only: a failed ledger cannot reliably persist its own
  // failure marker. Restart cannot reconstruct gaps in previously dropped rows.
  #historyIncomplete = false;
  logger: Logger;
  db: DatabaseSync | null;
  insert: StatementSync | null;

  constructor({ dbFile, db, logger = console }: { dbFile?: string; db?: DatabaseSync; logger?: Logger } = {}) {
    this.logger = logger;
    this.db = null;
    this.insert = null;
    // 打开即 fail fast（声明在 db.ts）：合并库后「账本不可用」不再是可以静默跑路由的状态。
    // 打开与语句准备阶段的任何失败都直接抛，启动入口据此拒绝起服务；运行中写入失败才走降级。
    this.db = db ?? openDatabase(String(dbFile));
    // 列清单 23 个、占位符 23 个（capture_id 收官；改列后必须重数——手数必错，见 AGENTS 加列套路）。
    this.insert = this.db.prepare(`INSERT INTO requests(ts,tenant,identity,identity_kind,subscription,account,model,translated_model,path,status,ms,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cache_write_tokens,total_tokens,cache_observed,cache_outcome,ttft_ms,stream_ms,usage_json,capture_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  }

  // 无兜底写入：供「账本行 + 事件行同事务成对落地」的路径使用，任何一步抛错即整体回滚。
  insertRow(entry: AuditEntry, usage: ChatUsage | null | undefined): number {
    const stmt = this.insert;
    if (!stmt) throw new Error('usage ledger unavailable');
    const tokens = tokenFields(usage);
    const outcome = !tokens.cache_observed ? null : tokens.cache_hit_tokens === 0 ? 'miss' : tokens.cache_miss_tokens === 0 ? 'hit' : 'partial';
    const info = stmt.run(entry.ts ?? Date.now(), entry.tenant ?? 'default', entry.identity ?? null, entry.identity_kind ?? 'unknown', entry.subscription ?? null,
      entry.account ?? null, entry.model ?? null, entry.translated_model ?? null, entry.path ?? null, entry.status ?? null, entry.ms ?? null,
      tokens.prompt_tokens, tokens.completion_tokens, tokens.cache_hit_tokens, tokens.cache_miss_tokens, tokens.cache_write_tokens,
      tokens.total_tokens, tokens.cache_observed ? 1 : 0, outcome, ms(entry.ttft_ms), ms(entry.stream_ms),
      usage && typeof usage === 'object' ? JSON.stringify(usage) : null, entry.capture_id ?? null);
    return Number(info.lastInsertRowid);
  }

  // 同事务执行「账本写入 + 事件写入」等成对动作：任一步抛错整体回滚并锁存历史不完整标记。
  // 成功返回 fn 的结果；库不可用、BEGIN 拿不到写锁（另一连接持锁）或事务失败一律返回 null
  // 并锁存 degraded——调用方必须检查返回值，事务失败时不得继续依赖「已落库」的副作用。
  transaction<T>(fn: (db: DatabaseSync) => T): T | null {
    const db = this.db;
    if (!db) return null;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      // BEGIN 失败 = 没有事务被打开，无需 ROLLBACK；失败同样计入历史不完整。
      this.#historyIncomplete = true;
      this.logger.warn?.(`[audit] degraded: transaction begin failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 关闭中的库连 ROLLBACK 也会抛，忽略 */ }
      this.#historyIncomplete = true;
      this.logger.warn?.(`[audit] degraded: paired transaction failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  }

  record(entry: AuditEntry, usage: ChatUsage | null | undefined): number | null {
    try { return this.insertRow(entry, usage); }
    catch (error) {
      this.#historyIncomplete = true;
      this.logger.warn?.(`[audit] degraded: record failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  }

  #read<T>(fallback: T, query: (db: DatabaseSync) => T): T {
    const db = this.db;
    if (!db) return fallback;
    try { return query(db); }
    catch (error) {
      this.logger.warn?.(`[audit] degraded: query failed (${error instanceof Error ? error.message : String(error)})`);
      return fallback;
    }
  }

  listRequests({ limit = 100, identity, tenant }: { limit?: number | string | null; identity?: string; tenant?: string } = {}): AuditRow[] {
    return this.#read<AuditRow[]>([], (db) => {
      const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
      // tenant 过滤语义：undefined = 不过滤（全租户合计）；旧行经 ALTER 默认值已落 'default'。
      const rows = tenant === undefined
        ? identity === undefined
          ? db.prepare('SELECT * FROM requests ORDER BY ts DESC,id DESC LIMIT ?').all(count)
          : db.prepare('SELECT * FROM requests WHERE identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(identity, count)
        : identity === undefined
          ? db.prepare('SELECT * FROM requests WHERE tenant=? ORDER BY ts DESC,id DESC LIMIT ?').all(tenant, count)
          : db.prepare('SELECT * FROM requests WHERE tenant=? AND identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(tenant, identity, count);
      return rows.map(({ usage_json, ...row }) => asRow(row));
    });
  }

  listSessions({ limit = 100, tenant }: { limit?: number | string | null; tenant?: string } = {}): SessionSummary[] {
    return this.#read<SessionSummary[]>([], (db) => {
      const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
      // 同一 identity 可存在于多个租户（租户隔离），GROUP BY 带上 tenant 才是完整会话清单。
      const rows = tenant === undefined
        ? db.prepare(`SELECT tenant, identity, identity_kind, COUNT(*) AS requests, MAX(ts) AS last_ts
          FROM requests WHERE identity IS NOT NULL GROUP BY tenant, identity, identity_kind ORDER BY last_ts DESC LIMIT ?`).all(count)
        : db.prepare(`SELECT tenant, identity, identity_kind, COUNT(*) AS requests, MAX(ts) AS last_ts
          FROM requests WHERE identity IS NOT NULL AND tenant = ? GROUP BY tenant, identity, identity_kind ORDER BY last_ts DESC LIMIT ?`).all(tenant, count);
      return rows.map((session) => {
        const identity = String(session.identity);
        const sessionTenant = String(session.tenant);
        return { ...session, ...this.sessionSummary(identity, { tenant: sessionTenant }) } as unknown as SessionSummary;
      });
    });
  }

  summary({ subscriptionNames, tenant }: { subscriptionNames?: string[]; tenant?: string } = {}): AuditSummary {
    return this.#read<AuditSummary>({ requests: null, sessions: null, subscriptions: [], degraded: true }, (db) => {
      // tenant = undefined 时不过滤（看板默认全租户合计，与旧行为一致）。
      const scope = tenant === undefined ? '' : ' WHERE tenant = ?';
      const scopeArgs = tenant === undefined ? [] : [tenant];
      const requestsRow = db.prepare(`SELECT COUNT(*) AS n FROM requests${scope}`).get(...scopeArgs);
      // 会话数按 (tenant, identity) 去重：同一 identity 在多个租户是多个会话（租户隔离），
      // 与 listSessions 的 GROUP BY tenant, identity 同口径；无租户时代全为 default，与旧行为等价。
      const sessionsRow = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT identity FROM requests WHERE identity IS NOT NULL${scope ? scope.replace(' WHERE', ' AND') : ''} GROUP BY tenant, identity)`).get(...scopeArgs);
      const requests = typeof requestsRow?.n === 'number' ? requestsRow.n : null;
      const sessions = typeof sessionsRow?.n === 'number' ? sessionsRow.n : null;
      // subscriptionNames 传入当前配置的内部名集合：只展示还在配置里的订阅，已下线的留在库里不上板
      const configured = subscriptionNames ? new Set(subscriptionNames) : null;
      type Aggregate = SubscriptionSummary & { sum_completion: number; sum_stream_ms: number };
      const rows = db.prepare(`SELECT subscription, COUNT(*) AS requests,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
        SUM(COALESCE(total_tokens,0)) AS total_tokens,
        AVG(CASE WHEN status < 400 AND ttft_ms IS NOT NULL THEN ttft_ms END) AS avg_ttft_ms,
        SUM(CASE WHEN status < 400 THEN COALESCE(completion_tokens,0) END) AS sum_completion,
        SUM(CASE WHEN status < 400 THEN COALESCE(stream_ms,0) END) AS sum_stream_ms
        FROM requests${scope} GROUP BY subscription ORDER BY requests DESC`).all(...scopeArgs) as unknown as Aggregate[];
      const subscriptions: SubscriptionSummary[] = rows
        .map(({ sum_completion, sum_stream_ms, ...row }) => ({
          ...row,
          // TPS 按流式时长加权：Σtokens / Σstream_ms，比逐条平均更能代表真实吐字速度
          tps: sum_stream_ms > 0 ? sum_completion * 1000 / sum_stream_ms : null,
        }))
        .filter((row) => !configured || configured.has(row.subscription));
      return { requests, sessions, subscriptions };
    });
  }

  sessionSummary(identity: string, { tenant, threshold = 0.6 }: { tenant?: string; threshold?: number } = {}): SessionSummary {
    // Unknown history is not zero history. Routing callers must preserve the
    // current affinity when degraded and long-session protection is enabled.
    // tenant 显式传入（路由长会话判定、listSessions 行自带 tenant、看板明细）→ 按 (tenant, identity) 查；
    // 省略 → 不过滤租户（管理口 summary?identity= 不带 tenant 时与同响应的 requests 明细同范围，两侧不打架；
    // 无租户声明的部署里全部行都是 default，省略与显式 'default' 结果相同）。
    const unknown: SessionSummary = { identity, requests: null, full_miss_rate: null, loss_events: [], degraded: true };
    if (this.#historyIncomplete) return unknown;
    return this.#read<SessionSummary>(unknown, (db) => {
      interface HistoryRow { ts: number; prompt_tokens: number | null; cache_hit_tokens: number | null; cache_observed: number; cache_outcome: string | null }
      const rows = tenant === undefined
        ? db.prepare('SELECT ts, prompt_tokens, cache_hit_tokens, cache_observed, cache_outcome FROM requests WHERE identity=? ORDER BY ts,id').all(identity) as unknown as HistoryRow[]
        : db.prepare('SELECT ts, prompt_tokens, cache_hit_tokens, cache_observed, cache_outcome FROM requests WHERE identity=? AND tenant=? ORDER BY ts,id').all(identity, tenant) as unknown as HistoryRow[];
      const observed = rows.filter((row) => row.cache_observed);
      const misses = observed.filter((row) => row.cache_outcome === 'miss').length;
      const loss_events: CacheLossEvent[] = [];
      for (let i = 1; i < rows.length; i++) {
        const previous = rows[i - 1], current = rows[i];
        const previousPrompt = previous.prompt_tokens;
        if (previousPrompt !== null && previousPrompt > 0 && current.cache_observed && current.cache_hit_tokens !== null && current.cache_hit_tokens < previousPrompt * threshold) {
          loss_events.push({ ts: current.ts, previous_prompt_tokens: previousPrompt, cache_hit_tokens: current.cache_hit_tokens });
        }
      }
      return { identity, requests: rows.length, full_misses: misses, cache_observed_requests: observed.length,
        full_miss_rate: observed.length ? misses / observed.length : null, loss_events };
    });
  }

  close(): void { try { this.db?.close(); } catch {} this.db = null; this.insert = null; }
}
