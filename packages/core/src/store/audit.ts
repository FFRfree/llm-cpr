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

  // family-observability 票 03：按 capture_id 精确取 usage 三分量 + 原始 usage_json（账本形状
  // 探测用）。「最新 N 行」窗口会与轮次窗口错位（无 capture_id 的行占位），按锚点直查根除缺口
  // （review P3-6）；查无行的轮 = 账本真缺行，由调用方双侧剔除如实报数。上限 500（轮次窗口同宽）。
  usageByCaptureIds(captureIds: string[]): Map<string, { prompt_tokens: number | null; cache_hit_tokens: number | null; cache_write_tokens: number | null; cache_observed: boolean | null; usage_json: string | null }> {
    const out = new Map<string, { prompt_tokens: number | null; cache_hit_tokens: number | null; cache_write_tokens: number | null; cache_observed: boolean | null; usage_json: string | null }>();
    const ids = [...new Set(captureIds)].slice(0, 500);
    if (ids.length === 0) return out;
    return this.#read(out, (db) => {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT capture_id, prompt_tokens, cache_hit_tokens, cache_write_tokens, cache_observed, usage_json FROM requests WHERE capture_id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (typeof row.capture_id !== 'string') continue;
        out.set(row.capture_id, {
          prompt_tokens: typeof row.prompt_tokens === 'number' ? row.prompt_tokens : null,
          cache_hit_tokens: typeof row.cache_hit_tokens === 'number' ? row.cache_hit_tokens : null,
          cache_write_tokens: typeof row.cache_write_tokens === 'number' ? row.cache_write_tokens : null,
          cache_observed: row.cache_observed === 1 ? true : row.cache_observed === 0 ? false : null,
          usage_json: typeof row.usage_json === 'string' ? row.usage_json : null,
        });
      }
      return out;
    });
  }

  // 管理口分页读（后台 v2）：页码/排序/筛选在服务端裁决，前端不再拉全量自排。
  // 排序列走白名单字典（排序键永不拼进 SQL 之外的东西）；days 按北京时间日切（用户在 UTC+8）。
  static readonly #REQUEST_SORT: Record<string, string> = {
    ts: 'ts', model: 'model', subscription: 'subscription', status: 'status', total_tokens: 'total_tokens', ms: 'ms',
  };
  #requestWhere({ tenant, identity, model, status, since }: { tenant?: string; identity?: string; model?: string; status?: number; since?: number }): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (tenant !== undefined) { parts.push('tenant=?'); args.push(tenant); }
    if (identity !== undefined) { parts.push('identity=?'); args.push(identity); }
    if (model !== undefined) { parts.push('model=?'); args.push(model); }
    if (status !== undefined) { parts.push('status=?'); args.push(status); }
    if (since !== undefined) { parts.push('ts>=?'); args.push(since); }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', args };
  }
  // 轨迹聚合（tree 接口）：按 capture_id 精确取状态/耗时（口径同 usageByCaptureIds 的锚点直查，
  // 不与「最新 N 行」窗口错位）。查无行 = 账本缺行，status/ms 以 null 呈现。
  statusByCaptureIds(captureIds: string[]): Map<string, { status: number | null; ms: number | null; ttft_ms: number | null }> {
    const out = new Map<string, { status: number | null; ms: number | null; ttft_ms: number | null }>();
    const ids = [...new Set(captureIds)].slice(0, 500);
    if (ids.length === 0) return out;
    return this.#read(out, (db) => {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT capture_id, status, ms, ttft_ms FROM requests WHERE capture_id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (typeof row.capture_id !== 'string') continue;
        out.set(row.capture_id, {
          status: typeof row.status === 'number' ? row.status : null,
          ms: typeof row.ms === 'number' ? row.ms : null,
          ttft_ms: typeof row.ttft_ms === 'number' ? row.ttft_ms : null,
        });
      }
      return out;
    });
  }

  listRequestsPaged({ page = 1, pageSize = 50, sort = 'ts', order = 'desc', tenant, identity, model, status, days, now = Date.now() }: {
    page?: number | string | null; pageSize?: number | string | null; sort?: string | null; order?: string | null;
    tenant?: string; identity?: string; model?: string; status?: number | string | null; days?: number | string | null; now?: number;
  } = {}): { requests: AuditRow[]; total: number; page: number; page_size: number } {
    return this.#read({ requests: [], total: 0, page: 1, page_size: 50 }, (db) => {
      const size = Math.max(10, Math.min(200, Math.trunc(Number(pageSize) || 50)));
      const current = Math.max(1, Math.trunc(Number(page) || 1));
      const column = UsageAudit.#REQUEST_SORT[String(sort)] ?? UsageAudit.#REQUEST_SORT.ts;
      const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const dayValue = Number(days);
      const since = Number.isFinite(dayValue) && dayValue > 0 ? now - Math.min(90, dayValue) * 86_400_000 : undefined;
      const statusNumber = status === undefined || status === null || status === '' ? undefined : Number(status);
      const { sql, args } = this.#requestWhere({ tenant, identity, model, status: statusNumber !== undefined && Number.isFinite(statusNumber) ? statusNumber : undefined, since });
      const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM requests${sql}`).get(...(args as never[])) as { n: unknown };
      const total = typeof totalRow?.n === 'number' ? totalRow.n : 0;
      const rows = db.prepare(`SELECT * FROM requests${sql} ORDER BY ${column} ${dir}, id ${dir} LIMIT ? OFFSET ?`)
        .all(...(args as never[]), size, (current - 1) * size) as unknown as Array<Record<string, unknown>>;
      return { requests: rows.map(({ usage_json, ...row }) => asRow(row)), total, page: current, page_size: size };
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

  // 会话分页读（后台 v2）：组数有界（≤500），每组的完整摘要本来就要算（N+1 同旧行为），
  // 排序在 JS 层做（full_miss_rate 需要 computed 后才能排），分页同样 JS 切片。
  listSessionsPaged({ page = 1, pageSize = 50, sort = 'last_ts', order = 'desc', tenant, days, now = Date.now() }: {
    page?: number | string | null; pageSize?: number | string | null; sort?: string | null; order?: string | null;
    tenant?: string; days?: number | string | null; now?: number;
  } = {}): { sessions: SessionSummary[]; total: number; page: number; page_size: number } {
    return this.#read({ sessions: [], total: 0, page: 1, page_size: 50 }, (db) => {
      const size = Math.max(10, Math.min(200, Math.trunc(Number(pageSize) || 50)));
      const current = Math.max(1, Math.trunc(Number(page) || 1));
      const dayValue = Number(days);
      const since = Number.isFinite(dayValue) && dayValue > 0 ? now - Math.min(90, dayValue) * 86_400_000 : undefined;
      const scope = tenant !== undefined ? ' AND tenant = ?' : '';
      const sinceSql = since !== undefined ? ' AND ts >= ?' : '';
      const args = tenant !== undefined ? [tenant] : [];
      const rows = db.prepare(`SELECT tenant, identity, identity_kind, COUNT(*) AS requests, MAX(ts) AS last_ts
        FROM requests WHERE identity IS NOT NULL${scope}${sinceSql} GROUP BY tenant, identity, identity_kind
        ORDER BY last_ts DESC LIMIT 500`).all(...(args as never[]), ...(since !== undefined ? [since] : [])) as unknown as Array<Record<string, unknown>>;
      const sessions = rows.map((session) => {
        const identity = String(session.identity);
        const sessionTenant = String(session.tenant);
        return { ...session, ...this.sessionSummary(identity, { tenant: sessionTenant }) } as unknown as SessionSummary;
      });
      const dir = String(order).toLowerCase() === 'asc' ? 1 : -1;
      const key = String(sort);
      sessions.sort((a, b) => {
        const av = a[key as keyof SessionSummary], bv = b[key as keyof SessionSummary];
        // null 排在末尾（与其排序方向无关）：「没有数据」不该冒充最大/最小
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return String(a.identity) < String(b.identity) ? -1 : 1;
      });
      const total = sessions.length;
      return { sessions: sessions.slice((current - 1) * size, current * size), total, page: current, page_size: size };
    });
  }

  // 订阅实际消耗聚合（后台 v2）：账本 requests 按订阅×北京时间日聚合。
  // 上游快照是「配额还剩多少」，这里是「这几天实际烧了多少」——两个口径互补，不互相替代。
  usageByDay({ days = 7, tenant, now = Date.now() }: { days?: number | string | null; tenant?: string; now?: number } = {}): {
    days: string[]; subscriptions: { subscription: string; by_day: Record<string, { requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number }>; total: { requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number } }[];
    day_boundary: string;
  } {
    return this.#read({ days: [] as string[], subscriptions: [], day_boundary: 'Asia/Shanghai (UTC+8)' }, (db) => {
      const window = Math.max(1, Math.min(90, Math.trunc(Number(days) || 7)));
      // 北京时间日切：桶边界 = ts + 8h 后取整天数；桶序号转回日期串时减回 8h。
      const BJT_OFFSET_MS = 8 * 3_600_000;
      const since = now - window * 86_400_000;
      const scope = tenant === undefined ? '' : ' AND tenant = ?';
      const args = tenant === undefined ? [] : [tenant];
      const rows = db.prepare(`SELECT subscription,
        CAST((ts + ${BJT_OFFSET_MS}) / 86400000 AS INTEGER) AS day_index,
        COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
        SUM(COALESCE(total_tokens,0)) AS total_tokens, SUM(COALESCE(cache_hit_tokens,0)) AS cache_hit_tokens,
        SUM(COALESCE(cache_miss_tokens,0)) AS cache_miss_tokens
        FROM requests WHERE ts >= ?${scope}
        GROUP BY subscription, day_index ORDER BY day_index DESC`).all(since, ...(args as never[])) as unknown as Array<{
        subscription: unknown; day_index: unknown; requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number;
      }>;
      const todayIndex = Math.floor((now + BJT_OFFSET_MS) / 86_400_000);
      const labels: string[] = [];
      for (let i = 0; i < window; i++) {
        labels.push(new Date((todayIndex - i) * 86_400_000 - BJT_OFFSET_MS).toISOString().slice(0, 10));
      }
      const labelOf = new Map(labels.map((label, i) => [todayIndex - i, label]));
      interface SubDay { subscription: string; by_day: Record<string, { requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number }>; total: { requests: number; errors: number; total_tokens: number; cache_hit_tokens: number; cache_miss_tokens: number } }
      const bySub = new Map<string, SubDay>();
      for (const row of rows) {
        const subscription = String(row.subscription ?? 'unknown');
        const label = labelOf.get(Number(row.day_index));
        if (!label) continue;
        const entry = bySub.get(subscription) ?? { subscription, by_day: {}, total: { requests: 0, errors: 0, total_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 } };
        const day = { requests: Number(row.requests) || 0, errors: Number(row.errors) || 0, total_tokens: Number(row.total_tokens) || 0, cache_hit_tokens: Number(row.cache_hit_tokens) || 0, cache_miss_tokens: Number(row.cache_miss_tokens) || 0 };
        entry.by_day[label] = day;
        for (const k of Object.keys(entry.total) as (keyof typeof day)[]) entry.total[k] += day[k];
        bySub.set(subscription, entry);
      }
      return { days: labels, subscriptions: [...bySub.values()], day_boundary: 'Asia/Shanghai (UTC+8)' };
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
