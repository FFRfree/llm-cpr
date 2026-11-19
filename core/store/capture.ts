// 正文捕获存储（observability 票 01，spec .scratch/observability/spec.md「已拍板的框架」）：
//   - 独立于 data.db 的侧库（capture.db，与 data.db 同目录）——账本查询口径不被正文连累。
//   - 内容寻址：每条消息按 sha256 存一份（content 表），每轮请求只存「本轮=哈希列表」引用
//     （turns 表），查看时拿哈希捞回拼装。系统提示/历史每轮重发只落一份正文。
//   - 租户级 opt-in（tenants 声明 capture: true，默认关）；未 opt-in 时本模块不被构建，
//     capture.db 连文件都不落（对外用户零感知）。
//   - TTL 保留期 + 超限跳过；清理判哈希引用（仍被引用的内容不删）。
//   - 写盘走异步队列、内存有界（对齐 usageCollector 有界丢弃纪律）；写失败降级锁存
//     （latch 不变，缺行不能宣称完整），绝不阻塞转发。
// 哈希加盐：正文哈希可被彩虹表反推短消息——盐在数据目录生成一次、只进哈希不落正文，
// 同盐内去重对比不受影响（同哈希 ⟺ 同内容）。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatCompletionsItems, type CaptureItem } from '../protocols/items.ts';
import { scanForLeaks } from '../observability/leaks.ts';
import type { LeakCategory, LeakHit } from '../observability/leaks.ts';
import type { Logger } from '../contracts.ts';

export interface CaptureTurnInput {
  tenant: string;
  identity: string | null;
  identityKind: string;
  model: string;
  // 已 JSON.parse 的客户端原始请求体（转发前捕获，非改写后的上游 body）。
  body: unknown;
  // 原始请求字节数（超限跳过按它判，阈值口径与 request.chars 一致）。
  rawBytes: number;
}

export interface CaptureTurnRow {
  id: number;
  capture_id: string;
  ts: number;
  tenant: string;
  identity: string | null;
  identity_kind: string;
  model: string | null;
  message_count: number;
  bytes: number;
  response_refs: string | null;
}

export type CaptureSkipReason = 'shape' | 'oversize';

export interface CaptureOutcome {
  // 捕获成功返回本轮锚点 id（随账本行落 capture_id 列，02-05 关联查询靠它）；
  // 跳过（形状不符/超限/队列满丢弃）返回 null——capture_id 存在但查无 turn 即降级缺行。
  captureId: string | null;
  skipped?: CaptureSkipReason | 'queue-full';
}

interface PendingTurn {
  captureId: string;
  ts: number;
  tenant: string;
  identity: string | null;
  identityKind: string;
  model: string;
  refs: string[];
  meta: string;
  bytes: number;
}

const CAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  tenant TEXT NOT NULL,
  identity TEXT,
  identity_kind TEXT NOT NULL,
  model TEXT,
  message_count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  refs TEXT NOT NULL,
  meta TEXT NOT NULL,
  response_refs TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_scope ON turns(tenant, identity, ts);
CREATE TABLE IF NOT EXISTS content (
  hash TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  body TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
`;

// 队列/刷盘参数：内存有界是硬纪律（磁盘卡住时丢轮不涨内存），数值内部钉死不进声明。
const QUEUE_BYTE_CAP = 32 * 1024 * 1024;
const FLUSH_DELAY_MS = 250;
const SWEEP_INTERVAL_MS = 15 * 60_000;

// 缓存取证链（票 03）：相邻轮次对比的读侧产物。
export interface CacheChainEntry {
  id: number;
  capture_id: string;
  ts: number;
  bytes: number;
  message_count: number;
  prev_id: number | null;
  prev_ts: number | null;
  // 与上一轮逐位同哈希的条数（前缀连续性的代理指标）。
  common_prefix: number;
  // 第一条分歧的位置（本轮该位置消息的角色随之给出）；本轮与前轮完全一致为 null。
  first_diff_index: number | null;
  first_diff_role: string | null;
  // 本轮 bytes − 上一轮 bytes（与哈希结论互校的 chars 口径）。
  chars_delta: number | null;
  prev_message_count: number | null;
}

// 工具/skill 分析（票 05）读侧产物：tokens_est 沿用 3.5 字符/token 折算口径。
export interface ToolStatsEntry {
  tool: string;
  calls: number;
  results: number;
  errors: number;
  error_rate: number | null;
  result_chars: number;
  result_tokens_est: number;
}
export interface ToolStatsReport {
  window: { since: number; until: number; days: number };
  turns_scanned: number;
  // 撞轮次上限时为 true：窗口内更旧轮次没扫，实际覆盖看 covered_since（review P2）。
  turns_truncated: boolean;
  covered_since: number | null;
  content_misses: number;
  tools: ToolStatsEntry[];
  // scope = day（by_day）或 identity（by_session）。
  by_day: Array<{ scope: string; tool: string; chars: number; tokens_est: number }>;
  by_session: Array<{ scope: string; tool: string; chars: number; tokens_est: number }>;
  // 卡住/死循环候选：同工具同参数哈希在相邻轮（≤1h 间隔）连续 ≥3 次出现；参数只留哈希+长度。
  loops: Array<{ identity: string; tool: string; args_hash: string; args_len: number; streak: number; last_ts: number }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CaptureStoreOptions {
  dbFile: string;
  ttlDays: number;
  maxBodyBytes: number;
  logger: Logger;
  // 测试注入：跳过启动清扫/定时器（清扫行为单独驱动）。
  scheduleSweep?: boolean;
  // 泄漏取证（observability 票 04）：增量扫描——只扫侧库没见过的消息（哈希判重），
  // 命中经白名单过滤后回调上报（server 接线落 privacy.hit 事件；本模块不碰 data.db）。
  // allow = 自带 key/租户 key/订阅 key 的真实值 + 用户前缀豁免；只在内存比对，绝不落日志。
  privacy?: {
    allow: string[];
    onHit: (hit: PrivacyHitContext) => void;
  };
}

// 命中上下文：给事件账与定位端点用。itemHash = 盐化消息哈希（= capture.db content 主键），
// 借它回查「哪一轮、哪个角色、哪条消息先出现」；不含任何命中原文。
export interface PrivacyHitContext {
  tenant: string;
  identity: string | null;
  identityKind: string;
  captureId: string;
  itemHash: string;
  messageIndex: number;
  role: string | null;
  rule: string;
  category: LeakCategory;
}

export class CaptureStore {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #salt: string;
  readonly #ttlMs: number;
  readonly #maxBodyBytes: number;
  #queue: PendingTurn[] = [];
  #pendingContent = new Map<string, string>();
  #pendingBytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  // 降级锁存：一次刷盘失败后置位，本实例不消失（对齐账本语义——缺的行无法宣称补齐）。
  #degraded = false;
  #dropped = 0;
  #privacy: { allow: string[]; onHit: (hit: PrivacyHitContext) => void } | null = null;
  // 已上报（rule, itemHash）进程内去重：同一条密钥随历史每轮重发只报一次。
  // 有界（FIFO 上限），重启后同命中可能再报一次——事件可重复读，宁多报不漏报。
  #reported = new Set<string>();
  #reportedOrder: string[] = [];
  #reportedCap = 4096;

  constructor({ dbFile, ttlDays, maxBodyBytes, logger, scheduleSweep = true, privacy }: CaptureStoreOptions) {
    this.#logger = logger;
    this.#ttlMs = Math.max(0, ttlDays) * 86_400_000;
    this.#maxBodyBytes = Math.max(0, maxBodyBytes);
    // 打开失败由调用方 fail fast（显式 opt-in 却打不开库 = 声明错误，启动即暴露）。
    this.#db = new DatabaseSync(dbFile);
    this.#db.exec('PRAGMA journal_mode=WAL');
    this.#db.exec(CAP_SCHEMA);
    this.#salt = this.#loadOrCreateSalt(path.join(path.dirname(dbFile), 'capture-salt.txt'));
    this.#privacy = privacy ?? null;
    if (scheduleSweep) {
      // 启动清一次旧账（上次运行遗留的过期轮），之后低频巡检。开库即刻，空库无成本。
      this.#sweep();
      this.#sweeper = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
      this.#sweeper.unref?.();
    }
  }

  // 盐文件与正文同目录、0600；CPR_CAPTURE_SALT 供测试钉死（也方便跨迁移搬库的人自带盐）。
  #loadOrCreateSalt(saltFile: string): string {
    const fromEnv = process.env.CPR_CAPTURE_SALT;
    if (fromEnv && /^[0-9a-fA-F]+$/.test(fromEnv)) return fromEnv;
    try {
      const existing = fs.readFileSync(saltFile, 'utf8').trim();
      if (/^[0-9a-fA-F]{16,}$/.test(existing)) return existing;
    } catch { /* 不存在：生成新的 */ }
    const salt = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(saltFile), { recursive: true });
    fs.writeFileSync(saltFile, `${salt}\n`, { mode: 0o600 });
    return salt;
  }

  // 请求侧热路径上的全部工作：形状归一化 + 逐消息哈希（parse 同量级开销）。写盘一律异步。
  capture(input: CaptureTurnInput): CaptureOutcome {
    const normalized = chatCompletionsItems(input.body as Record<string, unknown>);
    if (!normalized) return { captureId: null, skipped: 'shape' };
    if (this.#maxBodyBytes > 0 && input.rawBytes > this.#maxBodyBytes) return { captureId: null, skipped: 'oversize' };
    const captureId = randomUUID();
    const now = Date.now();
    const refs: string[] = [];
    let bytes = Buffer.byteLength(normalized.meta);
    const contents = new Map<string, string>();
    // 泄漏增量的判定要在「本轮内容挂进 pendingContent 之前」做——挂进去之后就无法区分
    // 「本轮新消息」和「上一轮就在队列里的消息」了。
    const freshItems: Array<{ item: CaptureItem; text: string; hash: string; index: number }> | null = this.#privacy ? [] : null;
    const exists = this.#privacy ? this.#db.prepare('SELECT 1 AS one FROM content WHERE hash = ?') : null;
    const seenThisTurn = new Set<string>();
    for (const item of normalized.items) {
      const text = JSON.stringify(item.raw);
      const hash = createHash('sha256').update(`${this.#salt}\n${text}`).digest('hex');
      refs.push(hash);
      bytes += Buffer.byteLength(text);
      if (freshItems && !seenThisTurn.has(hash)) {
        // 「侧库没见过」= 不在 content 表、不在挂起队列、本轮也还没出现过。
        if (!this.#pendingContent.has(hash) && exists!.get(hash) === undefined) {
          freshItems.push({ item, text, hash, index: refs.length - 1 });
        }
        seenThisTurn.add(hash);
      }
      // 同轮内重发/多份相同消息：只添引用不添正文。
      if (!contents.has(hash)) contents.set(hash, text);
    }
    // 内存有界在入队前判定：磁盘/刷盘跟不上时丢 newest（对齐 usageCollector 的有界丢弃
    // 纪律），不先塞再丢——塞了再丢会留下无主孤儿内容。
    if (this.#pendingBytes + bytes > QUEUE_BYTE_CAP) {
      this.#dropped += 1;
      this.#logger.warn?.(`[capture] queue cap ${QUEUE_BYTE_CAP} bytes exceeded; turn dropped (total dropped: ${this.#dropped})`);
      return { captureId: null, skipped: 'queue-full' };
    }
    for (const [hash, text] of contents) {
      // 跨轮去重：挂起队列里已挂同哈希只添引用不添正文。
      if (!this.#pendingContent.has(hash)) {
        this.#pendingContent.set(hash, text);
        this.#pendingBytes += Buffer.byteLength(text);
      }
    }
    const turn: PendingTurn = { captureId, ts: now, tenant: input.tenant, identity: input.identity, identityKind: input.identityKind, model: input.model, refs, meta: normalized.meta, bytes };
    this.#queue.push(turn);
    this.#pendingBytes += bytes;
    // 泄漏取证（票 04）：只扫本轮新消息（增量——历史每轮重发的大头天然免扫）。
    if (this.#privacy && freshItems) this.#scanPrivacy(input, captureId, freshItems);
    if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#timer = null; this.#flush(); }, FLUSH_DELAY_MS);
      this.#timer.unref?.();
    }
    return { captureId };
  }

  // 泄漏扫描（票 04）：增量消息逐条跑规则；命中经进程内（rule, itemHash) 去重后回调。
  // 命中不返回原文——扫描器与这里都不持有可外泄的命中片段。
  #scanPrivacy(input: CaptureTurnInput, captureId: string, fresh: Array<{ item: CaptureItem; text: string; hash: string; index: number }>): void {
    if (!this.#privacy) return;
    for (const { item, text, hash, index } of fresh) {
      let hits: LeakHit[];
      try { hits = scanForLeaks(text, { allow: this.#privacy.allow }); }
      catch (error) { this.#logger.warn?.(`[capture] leak scan failed: ${messageOf(error)}`); continue; }
      for (const hit of hits) {
        const dedupeKey = `${hit.rule}:${hash}`;
        if (this.#reported.has(dedupeKey)) continue;
        this.#reported.add(dedupeKey);
        this.#reportedOrder.push(dedupeKey);
        if (this.#reportedOrder.length > this.#reportedCap) this.#reported.delete(this.#reportedOrder.shift()!);
        try {
          this.#privacy.onHit({
            tenant: input.tenant, identity: input.identity, identityKind: input.identityKind, captureId,
            itemHash: hash, messageIndex: index, role: item.role, rule: hit.rule, category: hit.category,
          });
        } catch (error) {
          // 上报失败（事件账降级等）不影响转发与捕获本身；该命中下次同消息再扫时可能重复报。
          this.#logger.warn?.(`[capture] privacy hit report failed: ${messageOf(error)}`);
        }
      }
    }
  }

  #flush(): void {
    const queue = this.#queue;
    const content = this.#pendingContent;
    if (!queue.length && !content.size) return;
    this.#queue = [];
    this.#pendingContent = new Map();
    this.#pendingBytes = 0;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const putContent = this.#db.prepare('INSERT INTO content(hash,bytes,body,first_seen) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING');
        const putTurn = this.#db.prepare('INSERT INTO turns(capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,refs,meta,response_refs) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)');
        const firstSeen = Date.now();
        for (const [hash, text] of content) putContent.run(hash, Buffer.byteLength(text), text, firstSeen);
        for (const turn of queue) {
          putTurn.run(turn.captureId, turn.ts, turn.tenant, turn.identity, turn.identityKind, turn.model,
            turn.refs.length, turn.bytes, JSON.stringify(turn.refs), turn.meta);
        }
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      // 降级：本轮全部丢弃（不重试积压——积压重放会让内存跟着磁盘状态走），锁存不消失。
      this.#degraded = true;
      this.#dropped += queue.length;
      this.#logger.warn?.(`[capture] degraded: flush failed (${messageOf(error)}); ${queue.length} turn(s) dropped`);
    }
  }

  // TTL 清理 + 哈希引用判定：删过期 turns 后，扫引用列表仍被指着的 content 不删。
  // 扫描式判定（而非引用计数列）：turns+content 同事务写、清理也单语句，永远自洽，
  // 崩溃/降级都不会留下永远删不掉的孤儿或提前删掉还被引用的正文。
  #sweep(now = Date.now()): void {
    if (this.#ttlMs <= 0) return; // ttl_days: 0 = 保留期关闭（永不按龄清理）
    const cutoff = now - this.#ttlMs;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.prepare('DELETE FROM turns WHERE ts < ?').run(cutoff);
        this.#db.prepare(`DELETE FROM content WHERE hash NOT IN (
          SELECT DISTINCT value FROM turns, json_each(turns.refs)
        )`).run();
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.#logger.warn?.(`[capture] sweep failed: ${messageOf(error)}`);
    }
  }

  listTurns({ limit = 100, tenant, identity }: { limit?: number | string | null; tenant?: string; identity?: string } = {}): CaptureTurnRow[] {
    const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = tenant === undefined
      ? identity === undefined
        ? this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns ORDER BY ts DESC,id DESC LIMIT ?').all(count)
        : this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns WHERE identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(identity, count)
      : identity === undefined
        ? this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns WHERE tenant=? ORDER BY ts DESC,id DESC LIMIT ?').all(tenant, count)
        : this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns WHERE tenant=? AND identity=? ORDER BY ts DESC,id DESC LIMIT ?').all(tenant, identity, count);
    return rows as unknown as CaptureTurnRow[];
  }

  // 按引用列表拼装还原：meta（含 messages 占位空数组，键序同原 body）回填 messages。
  // 还原 JSON.stringify 与原始请求体逐字节一致（测试覆盖）；查无引用内容 = 降级缺行，返回 null。
  turnBody(id: number): { turn: CaptureTurnRow; body: Record<string, unknown> } | null {
    const turnRow = this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!turnRow) return null;
    const turn = turnRow as unknown as CaptureTurnRow;
    const refs = JSON.parse(String(this.#db.prepare('SELECT refs FROM turns WHERE id=?').get(id)!.refs)) as string[];
    const messages: unknown[] = [];
    const lookup = this.#db.prepare('SELECT body FROM content WHERE hash=?');
    for (const hash of refs) {
      const row = lookup.get(hash) as { body: string } | undefined;
      if (!row) { this.#logger.warn?.(`[capture] turn ${id}: content ${hash.slice(0, 12)}… missing (degraded)`); return null; }
      messages.push(JSON.parse(row.body));
    }
    const restored = JSON.parse(String((this.#db.prepare('SELECT meta FROM turns WHERE id=?').get(id) as { meta: string }).meta)) as Record<string, unknown>;
    restored.messages = messages;
    return { turn, body: restored };
  }

  status(): { turns: number; contents: number; bytes: number; dropped: number; degraded: boolean } {
    const turns = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number | bigint }).n);
    const agg = this.#db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS total FROM content').get() as { n: number | bigint; total: number | bigint };
    return { turns, contents: Number(agg.n), bytes: Number(agg.total), dropped: this.#dropped, degraded: this.#degraded };
  }

  // ---- 读侧分析（observability 票 03/04/05）：全部按需聚合，不占热路径 ----

  // 供 privacy 事件定位：按锚点 capture_id 查轮次。
  turnByCaptureId(captureId: string): CaptureTurnRow | null {
    const row = this.#db.prepare('SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs FROM turns WHERE capture_id=?').get(captureId) as Record<string, unknown> | undefined;
    return row ? (row as unknown as CaptureTurnRow) : null;
  }

  // 引用了某条内容哈希的轮次（升序 = 该内容第一次出现的轮，回答「哪一轮吸进来的」）。
  turnsContaining(tenant: string, hash: string, limit = 5): CaptureTurnRow[] {
    const rows = this.#db.prepare(`SELECT id,capture_id,ts,tenant,identity,identity_kind,model,message_count,bytes,response_refs
      FROM turns WHERE tenant=? AND EXISTS (SELECT 1 FROM json_each(turns.refs) WHERE value = ?) ORDER BY ts ASC, id ASC LIMIT ?`).all(tenant, hash, Math.max(1, Math.min(50, limit)));
    return rows as unknown as CaptureTurnRow[];
  }

  // 内容哈希对应消息的角色（角色在原始消息 JSON 里）。
  contentRole(hash: string): string | null {
    const row = this.#db.prepare('SELECT body FROM content WHERE hash=?').get(hash) as { body: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.body) as { role?: unknown };
      return typeof parsed.role === 'string' ? parsed.role : null;
    } catch { return null; }
  }

  // 缓存取证（票 03）：同 (tenant, identity) 轮序相邻对比。common_prefix = 与上一轮逐位
  // 同哈希的条数（prompt cache 前缀连续性的代理指标）；first_diff = 第一条分歧的位置与角色；
  // chars_delta 供与哈希结论互校。归因（改绑/压缩/改提示词）由端点层合并事件账做，措辞「证据指向」。
  // limit 在 SQL 层限行（review P1：长会话全量读取会拖住同进程转发），取最新 N 轮再逆序恢复升序。
  cacheChain(tenant: string, identity: string, limit = 100): CacheChainEntry[] {
    const count = Math.max(2, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = (this.#db.prepare('SELECT id,capture_id,ts,message_count,bytes,refs FROM turns WHERE tenant=? AND identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, identity, count) as unknown as Array<{ id: number; capture_id: string; ts: number; message_count: number; bytes: number; refs: string }>).reverse();
    const chain: CacheChainEntry[] = [];
    let previous: { id: number; ts: number; refs: string[]; message_count: number; bytes: number } | null = null;
    for (const row of rows) {
      const refs = JSON.parse(row.refs) as string[];
      const entry: CacheChainEntry = { id: row.id, capture_id: row.capture_id, ts: row.ts, bytes: row.bytes, message_count: row.message_count,
        prev_id: null, prev_ts: null, common_prefix: refs.length, first_diff_index: null, first_diff_role: null, chars_delta: null, prev_message_count: null };
      if (previous) {
        const bound = Math.min(previous.refs.length, refs.length);
        let i = 0;
        while (i < bound && previous.refs[i] === refs[i]) i += 1;
        entry.prev_id = previous.id;
        entry.prev_ts = previous.ts;
        entry.prev_message_count = previous.message_count;
        entry.common_prefix = i;
        entry.chars_delta = row.bytes - previous.bytes;
        if (i < bound || i < previous.refs.length || i < refs.length) {
          entry.first_diff_index = i;
          entry.first_diff_role = refs[i] !== undefined ? this.contentRole(refs[i]) : null; // 本轮在该位置的消息（i===refs.length 时本轮是删减）
        }
      }
      chain.push(entry);
      previous = { id: row.id, ts: row.ts, refs, message_count: row.message_count, bytes: row.bytes };
    }
    return chain;
  }

  // 工具/skill 分析（票 05）：窗口内逐轮解析正文聚合。读侧按需（默认 7 天 / 最多 500 轮），
  // 大窗口是刻意的慢查询，不进热路径。报错口径：工具结果内容以 Error: 前缀开头、
  // 或为 JSON 且顶层含 error 字段——下游重试在请求侧不可见，不在口径内。
  toolStats({ tenant, identity, days = 7, maxTurns = 500, now = Date.now() }: { tenant: string; identity?: string; days?: number; maxTurns?: number; now?: number }): ToolStatsReport {
    const since = now - Math.max(1, Math.min(90, days)) * 86_400_000;
    const cap = Math.max(10, Math.min(2000, Math.trunc(maxTurns)));
    // 取窗口内最新 cap 条再正序聚合（review P2：ASC+LIMIT 截断会把最新轮排掉，
    // 分析拿旧数据冒充全窗口）。截断状态与实际覆盖起点随报告给出。
    const rowsRaw = (identity === undefined
      ? this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE tenant=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, since, cap)
      : this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE tenant=? AND identity=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, identity, since, cap)) as unknown as Array<{ id: number; capture_id: string; ts: number; identity: string | null; refs: string }>;
    const rows = rowsRaw.reverse();
    const bodies = new Map<string, string | null>(); // 内容缓存：同哈希一轮内/跨轮只取一次
    const body = (hash: string): string | null => {
      if (bodies.has(hash)) return bodies.get(hash)!;
      const row = this.#db.prepare('SELECT body FROM content WHERE hash=?').get(hash) as { body: string } | undefined;
      const value = row ? row.body : null;
      bodies.set(hash, value);
      return value;
    };
    const tools = new Map<string, { tool: string; calls: number; results: number; errors: number; result_chars: number }>();
    const byDay = new Map<string, number>();
    const bySession = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string, chars: number): void => { map.set(key, (map.get(key) ?? 0) + chars); };
    // calls 只在 assistant 的 tool_call 上计（发起一次）；tool 消息只计结果/报错/灌入量。
    const recordCall = (tool: string): void => {
      const entry = tools.get(tool) ?? { tool, calls: 0, results: 0, errors: 0, result_chars: 0 };
      entry.calls += 1;
      tools.set(tool, entry);
    };
    const recordResult = (tool: string, day: string, sessionKey: string, chars: number, isError: boolean): void => {
      const entry = tools.get(tool) ?? { tool, calls: 0, results: 0, errors: 0, result_chars: 0 };
      entry.results += 1;
      entry.result_chars += chars;
      if (isError) entry.errors += 1;
      tools.set(tool, entry);
      bump(byDay, `${day}\u0000${tool}`, chars);
      bump(bySession, `${sessionKey}\u0000${tool}`, chars);
    };
    // 卡住/死循环原料（票 05 验收）：每轮记 (tool, args_hash) 集合，跨轮连续出现即连击。
    const streaks = new Map<string, { identity: string; tool: string; args_hash: string; args_len: number; streak: number; last_ts: number }>();
    let scansFailed = 0;
    for (const row of rows) {
      const refs = JSON.parse(row.refs) as string[];
      const day = new Date(row.ts).toISOString().slice(0, 10);
      const sessionKey = row.identity ?? String(row.id);
      const idToName = new Map<string, string>();
      // 先过 assistant tool_calls 建 id→name 映射，再归 tool 结果。
      for (const hash of refs) {
        const text = body(hash);
        if (text === null) { scansFailed += 1; continue; }
        let message: Record<string, unknown>;
        try { message = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
        if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
        for (const call of message.tool_calls) {
          const fn = call !== null && typeof call === 'object' ? (call as Record<string, unknown>).function : undefined;
          if (!fn || typeof fn !== 'object') continue;
          const name = typeof (fn as Record<string, unknown>).name === 'string' ? String((fn as Record<string, unknown>).name) : 'unknown';
          const callId = typeof (call as Record<string, unknown>).id === 'string' ? String((call as Record<string, unknown>).id) : null;
          if (callId) idToName.set(callId, name);
          const argsText = typeof (fn as Record<string, unknown>).arguments === 'string' ? String((fn as Record<string, unknown>).arguments) : JSON.stringify((fn as Record<string, unknown>).arguments ?? '');
          const argsHash = createHash('sha256').update(argsText).digest('hex').slice(0, 16);
          recordCall(name);
          // 连击：同 identity + 同工具 + 同参数（哈希）在相邻轮重复出现。
          const streakKey = `${sessionKey}\u0000${name}\u0000${argsHash}`;
          const prior = streaks.get(streakKey);
          const continuing = prior !== undefined && prior.last_ts < row.ts;
          streaks.set(streakKey, {
            identity: row.identity ?? 'unknown', tool: name, args_hash: argsHash, args_len: argsText.length,
            streak: continuing && row.ts - prior.last_ts <= 3_600_000 ? prior.streak + 1 : 1, last_ts: row.ts,
          });
        }
      }
      for (const hash of refs) {
        const text = body(hash);
        if (text === null) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
        if (message.role !== 'tool') continue;
        const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : null;
        const name = (callId !== null && idToName.get(callId)) || 'unknown';
        const content = message.content;
        const contentText = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        // 报错判定：内容是 JSON 且顶层 error 非空，或文本以 Error: 前缀开头（合成样例的约定形态）。
        let isError = false;
        try {
          const parsed = JSON.parse(contentText) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error !== undefined) isError = true;
        } catch { isError = /^Error:/i.test(contentText.trimStart()); }
        recordResult(name, day, sessionKey, Buffer.byteLength(contentText), isError);
      }
    }
    // 只留 streak≥3 的（死循环候选），同 key 取最大连击。
    const loops = [...streaks.values()].filter((entry) => entry.streak >= 3)
      .sort((a, b) => b.streak - a.streak).slice(0, 50);
    const toolRows = [...tools.values()].map((entry) => ({ ...entry, error_rate: entry.calls > 0 ? entry.errors / entry.calls : null, result_tokens_est: Math.round(entry.result_chars / 3.5) }))
      .sort((a, b) => b.result_chars - a.result_chars);
    const split = (map: Map<string, number>) => [...map.entries()].map(([key, chars]) => {
      const [scope, tool] = key.split('\u0000');
      return { scope, tool, chars, tokens_est: Math.round(chars / 3.5) };
    }).sort((a, b) => b.chars - a.chars).slice(0, 200);
    return {
      window: { since, until: now, days },
      turns_scanned: rows.length,
      turns_truncated: rowsRaw.length >= cap, // 撞上限 = 窗口内还有更旧轮次没扫
      covered_since: rows.length ? rows[0].ts : null, // 实际覆盖起点（截断时 ≠ window.since）
      content_misses: scansFailed,
      tools: toolRows, by_day: split(byDay), by_session: split(bySession), loops,
    };
  }

  // 供测试/运维手动触发清理；也把挂起队列落盘（清扫前先见旧账）。
  sweepNow(): void {
    this.#flush();
    this.#sweep();
  }

  #closed = false;

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#sweeper) { clearInterval(this.#sweeper); this.#sweeper = null; }
    this.#flush();
    try { this.#db.close(); } catch { /* 已关闭 */ }
  }
}

export type { CaptureItem };
