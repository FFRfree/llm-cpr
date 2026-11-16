import { DatabaseSync } from 'node:sqlite';

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
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_identity_ts ON requests(identity, ts, id);
`;

const token = (value) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

export function tokenFields(usage) {
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details ?? {};
  const prompt = token(usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = token(usage?.completion_tokens ?? usage?.output_tokens);
  const hit = token(details.cached_tokens ?? details.cache_read_input_tokens ?? usage?.cache_read_input_tokens ?? usage?.cache_hit_tokens);
  const miss = token(details.cache_miss_tokens ?? usage?.cache_miss_tokens ?? (prompt !== null && hit !== null ? Math.max(0, prompt - hit) : null));
  const write = token(details.cache_creation_tokens ?? details.cache_write_tokens ?? usage?.cache_write_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, cache_hit_tokens: hit, cache_miss_tokens: miss,
    cache_write_tokens: write, total_tokens: token(usage?.total_tokens ?? (prompt !== null && completion !== null ? prompt + completion : null)),
    cache_observed: hit !== null || miss !== null || write !== null };
}

export class UsageAudit {
  constructor({ dbFile, logger = console } = {}) {
    this.logger = logger;
    this.db = null;
    try {
      this.db = new DatabaseSync(dbFile);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(SCHEMA);
      this.insert = this.db.prepare(`INSERT INTO requests(ts,identity,identity_kind,subscription,account,model,translated_model,path,status,ms,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cache_write_tokens,total_tokens,cache_observed,cache_outcome,usage_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    } catch (error) {
      this.db = null;
      this.logger.warn(`[audit] degraded: ledger unavailable (${error.message})`);
    }
  }

  record(entry, usage) {
    if (!this.db) return false;
    try {
      const tokens = tokenFields(usage);
      const outcome = !tokens.cache_observed ? null : tokens.cache_hit_tokens === 0 ? 'miss' : tokens.cache_miss_tokens === 0 ? 'hit' : 'partial';
      this.insert.run(entry.ts ?? Date.now(), entry.identity ?? null, entry.identity_kind ?? 'unknown', entry.subscription ?? null,
        entry.account ?? null, entry.model ?? null, entry.translated_model ?? null, entry.path ?? null, entry.status ?? null, entry.ms ?? null,
        tokens.prompt_tokens, tokens.completion_tokens, tokens.cache_hit_tokens, tokens.cache_miss_tokens, tokens.cache_write_tokens,
        tokens.total_tokens, tokens.cache_observed ? 1 : 0, outcome, usage && typeof usage === 'object' ? JSON.stringify(usage) : null);
      return true;
    } catch (error) {
      this.logger.warn(`[audit] degraded: record failed (${error.message})`);
      return false;
    }
  }

  listRequests({ limit = 100, identity } = {}) {
    if (!this.db) return [];
    const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = identity === undefined
      ? this.db.prepare('SELECT * FROM requests ORDER BY ts DESC,id DESC LIMIT ?').all(count)
      : this.db.prepare('SELECT * FROM requests WHERE identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(identity, count);
    return rows.map(({ usage_json, ...row }) => row);
  }

  listSessions({ limit = 100 } = {}) {
    if (!this.db) return [];
    const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const identities = this.db.prepare(`SELECT identity, identity_kind, COUNT(*) AS requests, MAX(ts) AS last_ts
      FROM requests WHERE identity IS NOT NULL GROUP BY identity, identity_kind ORDER BY last_ts DESC LIMIT ?`).all(count);
    return identities.map((session) => ({ ...session, ...this.sessionSummary(session.identity) }));
  }

  summary() {
    if (!this.db) return { requests: 0, sessions: 0, subscriptions: [] };
    const requests = this.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
    const sessions = this.db.prepare('SELECT COUNT(DISTINCT identity) AS n FROM requests WHERE identity IS NOT NULL').get().n;
    const subscriptions = this.db.prepare(`SELECT subscription, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
      SUM(COALESCE(total_tokens,0)) AS total_tokens FROM requests GROUP BY subscription ORDER BY requests DESC`).all();
    return { requests, sessions, subscriptions };
  }

  sessionSummary(identity, { threshold = 0.6 } = {}) {
    if (!this.db) return { identity, requests: 0, full_miss_rate: null, loss_events: [] };
    const rows = this.db.prepare('SELECT ts, prompt_tokens, cache_hit_tokens, cache_observed, cache_outcome FROM requests WHERE identity=? ORDER BY ts,id').all(identity);
    const observed = rows.filter((row) => row.cache_observed);
    const misses = observed.filter((row) => row.cache_outcome === 'miss').length;
    const loss_events = [];
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1], current = rows[i];
      if (previous.prompt_tokens > 0 && current.cache_observed && current.cache_hit_tokens !== null && current.cache_hit_tokens < previous.prompt_tokens * threshold) {
        loss_events.push({ ts: current.ts, previous_prompt_tokens: previous.prompt_tokens, cache_hit_tokens: current.cache_hit_tokens });
      }
    }
    return { identity, requests: rows.length, full_misses: misses, cache_observed_requests: observed.length,
      full_miss_rate: observed.length ? misses / observed.length : null, loss_events };
  }

  close() { try { this.db?.close(); } catch {} this.db = null; }
}
