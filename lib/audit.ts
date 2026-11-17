import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AuditEntry, AuditRow, AuditSummary, CacheLossEvent, ChatUsage, Logger, SessionSummary, SubscriptionSummary } from './contracts.ts';

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
  routing_note TEXT,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_identity_ts ON requests(identity, ts, id);
`;

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

// node:sqlite hands back untyped rows; the table shape is fixed by SCHEMA above.
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

  constructor({ dbFile, logger = console }: { dbFile?: string; logger?: Logger } = {}) {
    this.logger = logger;
    this.db = null;
    this.insert = null;
    try {
      if (typeof dbFile !== 'string' || !dbFile) throw new Error('usage ledger path is required');
      this.db = new DatabaseSync(dbFile);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(SCHEMA);
      // 旧库迁移：新增性能列（ttft/stream）与复盘注记列（routing_note），ALTER 对已存在的表逐列补齐
      const columns = new Set(this.db.prepare('PRAGMA table_info(requests)').all().map((entry) => String(entry.name)));
      for (const [name, ddl] of [['ttft_ms', 'INTEGER'], ['stream_ms', 'INTEGER'], ['routing_note', 'TEXT']] as const) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${ddl}`);
      }
      // 看板查询索引：必须在列迁移之后建（sub_agg 依赖 ttft_ms/stream_ms），老库新库统一走这里
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sess_group ON requests(identity, identity_kind, ts)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_sub_agg ON requests(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms)');
      this.insert = this.db.prepare(`INSERT INTO requests(ts,identity,identity_kind,subscription,account,model,translated_model,path,status,ms,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cache_write_tokens,total_tokens,cache_observed,cache_outcome,ttft_ms,stream_ms,routing_note,usage_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    } catch (error) {
      this.db = null;
      this.insert = null;
      this.logger.warn?.(`[audit] degraded: ledger unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  record(entry: AuditEntry, usage: ChatUsage | null | undefined): boolean {
    if (!this.db || !this.insert) return false;
    try {
      const tokens = tokenFields(usage);
      const outcome = !tokens.cache_observed ? null : tokens.cache_hit_tokens === 0 ? 'miss' : tokens.cache_miss_tokens === 0 ? 'hit' : 'partial';
      this.insert.run(entry.ts ?? Date.now(), entry.identity ?? null, entry.identity_kind ?? 'unknown', entry.subscription ?? null,
        entry.account ?? null, entry.model ?? null, entry.translated_model ?? null, entry.path ?? null, entry.status ?? null, entry.ms ?? null,
        tokens.prompt_tokens, tokens.completion_tokens, tokens.cache_hit_tokens, tokens.cache_miss_tokens, tokens.cache_write_tokens,
        tokens.total_tokens, tokens.cache_observed ? 1 : 0, outcome, ms(entry.ttft_ms), ms(entry.stream_ms),
        entry.routing_note ?? null,
        usage && typeof usage === 'object' ? JSON.stringify(usage) : null);
      return true;
    } catch (error) {
      this.#historyIncomplete = true;
      this.logger.warn?.(`[audit] degraded: record failed (${error instanceof Error ? error.message : String(error)})`);
      return false;
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

  listRequests({ limit = 100, identity }: { limit?: number | string | null; identity?: string } = {}): AuditRow[] {
    return this.#read<AuditRow[]>([], (db) => {
      const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
      const rows = identity === undefined
        ? db.prepare('SELECT * FROM requests ORDER BY ts DESC,id DESC LIMIT ?').all(count)
        : db.prepare('SELECT * FROM requests WHERE identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(identity, count);
      return rows.map(({ usage_json, ...row }) => asRow(row));
    });
  }

  listSessions({ limit = 100 }: { limit?: number | string | null } = {}): SessionSummary[] {
    return this.#read<SessionSummary[]>([], (db) => {
      const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
      const rows = db.prepare(`SELECT identity, identity_kind, COUNT(*) AS requests, MAX(ts) AS last_ts
        FROM requests WHERE identity IS NOT NULL GROUP BY identity, identity_kind ORDER BY last_ts DESC LIMIT ?`).all(count);
      return rows.map((session) => {
        const identity = String(session.identity);
        return { ...session, ...this.sessionSummary(identity) } as unknown as SessionSummary;
      });
    });
  }

  summary({ subscriptionNames }: { subscriptionNames?: string[] } = {}): AuditSummary {
    return this.#read<AuditSummary>({ requests: null, sessions: null, subscriptions: [], degraded: true }, (db) => {
      const requestsRow = db.prepare('SELECT COUNT(*) AS n FROM requests').get();
      const sessionsRow = db.prepare('SELECT COUNT(DISTINCT identity) AS n FROM requests WHERE identity IS NOT NULL').get();
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
        FROM requests GROUP BY subscription ORDER BY requests DESC`).all() as unknown as Aggregate[];
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

  sessionSummary(identity: string, { threshold = 0.6 }: { threshold?: number } = {}): SessionSummary {
    // Unknown history is not zero history. Routing callers must preserve the
    // current pin when degraded and long-session protection is enabled.
    const unknown: SessionSummary = { identity, requests: null, full_miss_rate: null, loss_events: [], degraded: true };
    if (this.#historyIncomplete) return unknown;
    return this.#read<SessionSummary>(unknown, (db) => {
      interface HistoryRow { ts: number; prompt_tokens: number | null; cache_hit_tokens: number | null; cache_observed: number; cache_outcome: string | null }
      const rows = db.prepare('SELECT ts, prompt_tokens, cache_hit_tokens, cache_observed, cache_outcome FROM requests WHERE identity=? ORDER BY ts,id').all(identity) as unknown as HistoryRow[];
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
