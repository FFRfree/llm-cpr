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
import { computeCacheEfficiency, DEFAULT_RATES, threadKeyOf } from '../observability/cache-efficiency.ts';
import type { EfficiencyRates, EfficiencyUsage } from '../observability/cache-efficiency.ts';
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
  // ---- 线程维度（family-observability 票 02）：deleg 家族共享身份，时间序「上一轮」可能
  // 是另一个孩子的轮次——断裂判定必须在线程内做，跨线程边界单列不算断裂。 ----
  // 线程键 = refs[1]（首条 user 消息哈希；refs[0] 是 system，兄弟间相同；不足两条回落）。
  thread_key: string;
  // 与时间序上一轮的关系：'first'（窗口内首轮）/ 'same-thread' / 'thread-switch'（切了孩子）。
  boundary: 'first' | 'same-thread' | 'thread-switch';
  // 线程内上一轮（窗口截断或缺行时为 null——不算错误，只缺对比基线）。
  prev_in_thread_id: number | null;
  prev_in_thread_ts: number | null;
  // 线程内口径的前缀对比（与 common_prefix 同算法，previous 换成线程内上一轮）。
  common_prefix_in_thread: number | null;
  first_diff_in_thread_index: number | null;
  first_diff_in_thread_role: string | null;
  // 本轮完整盐化哈希引用列表（轨迹页前端建前缀树用；与 turns/:id 的 refs 同源同义，无新增暴露面）。
  refs: string[];
}

// 线程汇总（票 02）：一个 identity（deleg 家族）内按首条 user 消息拆出的并行孩子清单。
export interface CacheThreadSummary {
  key: string;
  // refs[1] 消息正文截断（goal 开场白）；内容缺失（TTL 清理/降级）时为占位文案。
  label: string;
  first_ts: number;
  last_ts: number;
  turn_count: number;
  bytes: number;
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
  // refs 一并返回（盐化 sha256 的消息哈希，按消息序）：轨迹页用「与上一轮哈希重合」精确标出
  // 每条消息的重复/新增（后台 v2）。
  turnBody(id: number): { turn: CaptureTurnRow; body: Record<string, unknown>; refs: string[] } | null {
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
    return { turn, body: restored, refs };
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

  /* ---- 轨迹聚合（trajectory 页）：树 + 新增段分页（.scratch/trajectory-gitgraph/tree-aggregation-api.md）----
     树判定与前端旧 buildForest 同口径：时间序逐轮，取「refs 最长已见前缀」所属节点为父，
     refs 全等的轮并进同节点（×N 重试）。refs 哈希数组不出网——前端只拿 parent 指针与新增段元数据。 */
  #treeCore(tenant: string | undefined, identity: string, limit = 500) {
    const count = Math.max(2, Math.min(500, Math.trunc(Number(limit) || 500)));
    const rawRows = tenant === undefined
      ? this.#db.prepare('SELECT id,capture_id,ts,model,message_count,bytes,refs FROM turns WHERE identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(identity, count)
      : this.#db.prepare('SELECT id,capture_id,ts,model,message_count,bytes,refs FROM turns WHERE tenant=? AND identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, identity, count);
    const rows = (rawRows as unknown as Array<{ id: number; capture_id: string; ts: number; model: string | null; message_count: number; bytes: number; refs: string }>).reverse();
    const parsedRefs: Array<string[]> = [];
    type TNode = { idx: number; parentIdx: number | null; parentLen: number; refsLen: number; threadKey: string; turnIdx: number[]; children: number[] };
    const nodes: TNode[] = [];
    const trie = new Map<string, TNode>();
    rows.forEach((row, ti) => {
      let refs: string[] = [];
      try { refs = JSON.parse(row.refs) as string[]; } catch { refs = []; }
      parsedRefs.push(refs);
      if (!refs.length) return;
      let parent: TNode | null = null;
      for (let l = refs.length - 1; l >= 1; l--) {
        const hit = trie.get(refs.slice(0, l).join('\u0000'));
        if (hit) { parent = hit; break; }
      }
      const key = refs.join('\u0000');
      let node = trie.get(key);
      if (!node) {
        const created: TNode = { idx: nodes.length, parentIdx: parent ? parent.idx : null, parentLen: parent ? parent.refsLen : 0, refsLen: refs.length, threadKey: threadKeyOf(refs), turnIdx: [], children: [] };
        nodes.push(created); trie.set(key, created);
        if (parent) nodes[parent.idx].children.push(created.idx);
        node = created;
      }
      node.turnIdx.push(ti);
    });
    const oldest = rows[0] ?? null;
    let outOfWindow = 0;
    if (oldest) { // 窗口外精确计数：比窗口最老轮更早的（ts,id）都有谁
      const cond: string[] = ['identity=?']; const args: Array<string | number> = [identity];
      if (tenant !== undefined) { cond.push('tenant=?'); args.push(tenant); }
      cond.push('(ts<? OR (ts=? AND id<?))'); args.push(oldest.ts, oldest.ts, oldest.id);
      outOfWindow = Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE ${cond.join(' AND ')}`).get(...args) as { n: number | bigint }).n);
    }
    const threadLabels = new Map<string, string>();
    for (const node of nodes) {
      if (threadLabels.has(node.threadKey)) continue;
      threadLabels.set(node.threadKey, node.threadKey === '(none)' ? '(no messages)' : this.contentText(node.threadKey, 160));
    }
    return { rows, parsedRefs, nodes, oldest, outOfWindow, threadLabels };
  }

  // 批量 content 元数据（IN 分块，node:sqlite 变量上限内）：角色要解析正文，字节数走列不解析。
  #contentRoles(hashes: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = this.#db.prepare(`SELECT hash, body FROM content WHERE hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ hash: string; body: string }>;
      for (const row of rows) {
        try { const parsed = JSON.parse(row.body) as { role?: unknown }; if (typeof parsed.role === 'string') out.set(row.hash, parsed.role); } catch { /* 缺陷正文不给 role */ }
      }
    }
    return out;
  }

  #contentBytes(hashes: Set<string>): Map<string, number> {
    const out = new Map<string, number>();
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = this.#db.prepare(`SELECT hash, bytes FROM content WHERE hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ hash: string; bytes: number }>;
      for (const row of rows) out.set(row.hash, Number(row.bytes));
    }
    return out;
  }

  #contentBodies(hashes: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    const list = [...hashes];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const rows = this.#db.prepare(`SELECT hash, body FROM content WHERE hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ hash: string; body: string }>;
      for (const row of rows) out.set(row.hash, row.body);
    }
    return out;
  }

  // 树 DTO：parent 指针 + 每轮新增段元数据（added_count/bytes/前 4 条 role）。refs 不出网。
  buildTree(tenant: string | undefined, identity: string, limit = 500) {
    const { rows, parsedRefs, nodes, oldest, outOfWindow, threadLabels } = this.#treeCore(tenant, identity, limit);
    const roleHashes = new Set<string>();
    const byteHashes = new Set<string>();
    const perNode: Array<string[]> = [];
    for (const node of nodes) {
      const added = parsedRefs[node.turnIdx[0]].slice(node.parentLen); // 同节点各轮 refs 全等，取任一轮
      perNode.push(added);
      for (const h of added.slice(0, 4)) roleHashes.add(h);
      for (const h of added) byteHashes.add(h);
    }
    const roles = this.#contentRoles(roleHashes);
    const sizes = this.#contentBytes(byteHashes);
    return {
      nodes: nodes.map((node, i) => {
        const added = perNode[i];
        let addedBytes = 0, missing = false;
        for (const h of added) { const b = sizes.get(h); if (b == null) { missing = true; continue; } addedBytes += b; }
        return {
          id: node.idx,
          turns: node.turnIdx.map((ti) => ({ turn_id: rows[ti].id, capture_id: rows[ti].capture_id, ts: rows[ti].ts, model: rows[ti].model, message_count: rows[ti].message_count, bytes: rows[ti].bytes, status: null as number | null, ms: null as number | null, ttft_ms: null as number | null })),
          parent: node.parentIdx,
          parent_len: node.parentLen,
          added_count: added.length,
          added_bytes: missing ? null : addedBytes, // null = 新增段里有正文被 TTL 清理（半截降级）
          thread_key: node.threadKey,
          added_roles: added.slice(0, 4).map((h) => roles.get(h) ?? null),
        };
      }),
      roots: nodes.filter((n) => n.parentIdx == null).map((n) => n.idx),
      thread_labels: Object.fromEntries(threadLabels),
      out_of_window: outOfWindow,
      window: oldest ? { since_ts: oldest.ts, since_id: oldest.id, upto_ts: rows[rows.length - 1].ts } : { since_ts: 0, since_id: 0, upto_ts: 0 },
      window_turns: rows.length,
    };
  }

  // 新增段正文分页：keyset 游标 (ts,id) 全局单调（树序不单调，不能用 turn_id 当游标）；
  // upto/since 锁客户端树快照窗口。单页 limit_turns 轮且 byteCap 字节先到即停；
  // 孤轮豁免：首个候选独超 byteCap 也放行（否则客户端永远拿不到它，空转）。
  treeDiffs(tenant: string | undefined, identity: string, opts: { afterTs?: number; afterId?: number; sinceTs?: number; sinceId?: number; uptoTs?: number; limitTurns?: number; byteCap?: number } = {}) {
    const { rows, parsedRefs, nodes } = this.#treeCore(tenant, identity, 500);
    const parentLenByTurn = new Map<number, number>();
    for (const node of nodes) for (const ti of node.turnIdx) parentLenByTurn.set(rows[ti].id, node.parentLen);
    const limitTurns = Math.max(1, Math.min(200, Math.trunc(Number(opts.limitTurns) || 60)));
    const byteCap = Math.max(64 * 1024, Math.trunc(Number(opts.byteCap) || 2 * 1024 * 1024));
    const afterTs = Math.max(0, Math.trunc(Number(opts.afterTs) || 0));
    const afterId = Math.max(0, Math.trunc(Number(opts.afterId) || 0));
    const sinceTs = Math.max(0, Math.trunc(Number(opts.sinceTs) || 0));
    const sinceId = Math.max(0, Math.trunc(Number(opts.sinceId) || 0));
    const uptoTs = Number.isFinite(Number(opts.uptoTs)) ? Math.trunc(Number(opts.uptoTs)) : Number.MAX_SAFE_INTEGER;
    const cond: string[] = ['identity=?']; const args: Array<string | number> = [identity];
    if (tenant !== undefined) { cond.push('tenant=?'); args.push(tenant); }
    cond.push('ts<=?'); args.push(uptoTs);
    if (sinceTs > 0 || sinceId > 0) { cond.push('(ts>? OR (ts=? AND id>=?))'); args.push(sinceTs, sinceTs, sinceId); } // since 含边界（窗口最老轮本身）；after 游标排他（=上一页末轮）
    if (afterTs > 0 || afterId > 0) { cond.push('(ts>? OR (ts=? AND id>?))'); args.push(afterTs, afterTs, afterId); }
    const remaining = this.#db.prepare(`SELECT id,ts,refs FROM turns WHERE ${cond.join(' AND ')} ORDER BY ts ASC, id ASC`).all(...args) as unknown as Array<{ id: number; ts: number; refs: string }>;
    const candidates: Array<{ turnId: number; ts: number; start: number; hashes: string[] }> = [];
    for (const row of remaining) {
      if (candidates.length >= limitTurns) break;
      let refs: string[] = [];
      try { refs = JSON.parse(row.refs) as string[]; } catch { refs = []; }
      const start = Math.min(parentLenByTurn.get(row.id) ?? 0, refs.length); // 不在树里的轮（窗口错位）兜底 parent_len=0，宁可多传不传错
      candidates.push({ turnId: row.id, ts: row.ts, start, hashes: refs.slice(start) });
    }
    const candHashes = new Set<string>();
    for (const c of candidates) for (const h of c.hashes) candHashes.add(h);
    const sizeById = this.#contentBytes(candHashes);
    let kept = 0, acc = 0;
    while (kept < candidates.length) {
      let turnBytes = 0;
      for (const h of candidates[kept].hashes) turnBytes += sizeById.get(h) ?? 0;
      if (kept > 0 && acc + turnBytes > byteCap) break;
      acc += turnBytes; kept += 1;
    }
    const keptHashes = new Set<string>();
    for (const c of candidates.slice(0, kept)) for (const h of c.hashes) keptHashes.add(h);
    const bodies = this.#contentBodies(keptHashes);
    const items = candidates.slice(0, kept).map((c) => ({
      turn_id: c.turnId,
      start: c.start,
      messages: c.hashes.map((h) => { const b = bodies.get(h); return b == null ? null : JSON.parse(b) as unknown; }), // null = 正文被 TTL 清理（半截降级）
    }));
    const last = candidates[kept - 1];
    return { items, next_after: last ? { ts: last.ts, id: last.turnId } : null, done: kept >= remaining.length };
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

  // 缓存取证（observability 票 03 + family-observability 票 02）：同 (tenant, identity)
  // 轮序相邻对比 + 线程内对比。common_prefix = 与上一轮逐位同哈希的条数（prompt cache
  // 前缀连续性的代理指标）；first_diff = 第一条分歧的位置与角色；chars_delta 供与哈希结论
  // 互校。deleg 家族（多 subagent 共享一个会话身份）交错落库时时间序「上一轮」可能是另一个
  // 孩子的轮次——那时 common_prefix 只剩 system 一条是**假断裂**，所以另给线程内口径
  // （thread_key = refs[1]，首条 user 消息哈希；孩子的 goal 全程留上下文，键恒定），
  // 断裂判定看 common_prefix_in_thread，跨线程边界单列 boundary='thread-switch'。
  // 归因（改绑/压缩/改提示词）由端点层合并事件账做，措辞「证据指向」。
  // limit 在 SQL 层限行（review P1：长会话全量读取会拖住同进程转发），取最新 N 轮再逆序恢复升序。
  cacheChain(tenant: string | undefined, identity: string, limit = 100): { chain: CacheChainEntry[]; threads: CacheThreadSummary[] } {
    const count = Math.max(2, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rawRows = tenant === undefined
      ? this.#db.prepare('SELECT id,capture_id,ts,message_count,bytes,refs FROM turns WHERE identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(identity, count)
      : this.#db.prepare('SELECT id,capture_id,ts,message_count,bytes,refs FROM turns WHERE tenant=? AND identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, identity, count);
    const rows = (rawRows as unknown as Array<{ id: number; capture_id: string; ts: number; message_count: number; bytes: number; refs: string }>).reverse();
    const chain: CacheChainEntry[] = [];
    const threadMeta = new Map<string, { first_ts: number; last_ts: number; turn_count: number; bytes: number }>();
    const lastInThread = new Map<string, { id: number; ts: number; refs: string[] }>();
    let previous: { id: number; ts: number; refs: string[]; message_count: number; bytes: number; thread_key: string } | null = null;
    for (const row of rows) {
      const refs = JSON.parse(row.refs) as string[];
      // 线程键：refs[1] = 首条 user 消息（refs[0] 是 system，兄弟间相同）；不足两条回落——
      // 与 cache-efficiency.ts 的 threadKeyOf 是同一把钥匙（直接复用，防两份实现漂移）。
      const threadKey = threadKeyOf(refs);
      const entry: CacheChainEntry = { id: row.id, capture_id: row.capture_id, ts: row.ts, bytes: row.bytes, message_count: row.message_count,
        prev_id: null, prev_ts: null, common_prefix: refs.length, first_diff_index: null, first_diff_role: null, chars_delta: null, prev_message_count: null,
        thread_key: threadKey, boundary: 'first', prev_in_thread_id: null, prev_in_thread_ts: null,
        common_prefix_in_thread: null, first_diff_in_thread_index: null, first_diff_in_thread_role: null, refs };
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
      // boundary 按**时间序上一轮**的线程键判定（票 02 定义）：无上一轮=first；同键=same-thread；
      // 异键=thread-switch（切了孩子，不算断裂——哪怕本线程在线程内已有过轮次，见 b2 场景）。
      // 线程内延续信息由 prev_in_thread_* 携带，与 boundary 正交。
      const prevInThread = lastInThread.get(threadKey) ?? null;
      if (previous) {
        if (previous.thread_key === threadKey) entry.boundary = 'same-thread';
        else entry.boundary = 'thread-switch';
      }
      if (prevInThread) {
        entry.prev_in_thread_id = prevInThread.id;
        entry.prev_in_thread_ts = prevInThread.ts;
        const bound = Math.min(prevInThread.refs.length, refs.length);
        let i = 0;
        while (i < bound && prevInThread.refs[i] === refs[i]) i += 1;
        entry.common_prefix_in_thread = i;
        if (i < bound || i < prevInThread.refs.length || i < refs.length) {
          entry.first_diff_in_thread_index = i;
          entry.first_diff_in_thread_role = refs[i] !== undefined ? this.contentRole(refs[i]) : null;
        }
      }
      lastInThread.set(threadKey, { id: row.id, ts: row.ts, refs });
      const meta = threadMeta.get(threadKey);
      if (meta) {
        meta.last_ts = row.ts;
        meta.turn_count += 1;
        meta.bytes += row.bytes;
      } else {
        threadMeta.set(threadKey, { first_ts: row.ts, last_ts: row.ts, turn_count: 1, bytes: row.bytes });
      }
      chain.push(entry);
      previous = { id: row.id, ts: row.ts, refs, message_count: row.message_count, bytes: row.bytes, thread_key: threadKey };
    }
    const threads: CacheThreadSummary[] = [...threadMeta.entries()]
      .map(([key, meta]) => ({
        key,
        label: key === '(none)' ? '(no messages)' : this.contentText(key, 160),
        first_ts: meta.first_ts, last_ts: meta.last_ts, turn_count: meta.turn_count, bytes: meta.bytes,
      }))
      .sort((a, b) => a.first_ts - b.first_ts || a.key.localeCompare(b.key));
    return { chain, threads };
  }

  // 内容哈希对应消息的正文文本（线程 label 用）：字符串 content 原样截断；结构化 content
  // 拼接 text part（多模态 part 的 JSON 串对 label 是噪声，截断后只剩 '……' 看不出话题）。
  contentText(hash: string, clip = 160): string {
    const row = this.#db.prepare('SELECT body FROM content WHERE hash=?').get(hash) as { body: string } | undefined;
    if (!row) return '(content unavailable)';
    try {
      const parsed = JSON.parse(row.body) as { content?: unknown };
      let text: string;
      if (typeof parsed.content === 'string') text = parsed.content;
      else if (Array.isArray(parsed.content)) {
        const parts = parsed.content
          .filter((p): p is { type?: string; text?: string } => typeof p === 'object' && p !== null)
          .map((p) => (p.type === 'text' || typeof p.text === 'string' ? String(p.text) : `[${p.type ?? 'part'}]`));
        text = parts.join(' ／ ') || JSON.stringify(parsed.content);
      } else text = JSON.stringify(parsed.content ?? parsed);
      text = text.replace(/\s+/g, ' ').trim();
      return text.length > clip ? `${text.slice(0, clip)}…` : text;
    } catch { return '(content unavailable)'; }
  }

  // 缓存效率（family-observability 票 03）：理想消耗/实际消耗。CaptureStore 只出侧库数据
  // （轮次 + content.bytes + 线程 label），usage 三分量 + 原始 usage_json 来自 data.db，
  // 由 admin 层按 capture_id 精确喂入（audit.usageByCaptureIds）——本库不碰账本连接，
  // 且窗口按轮次锚点取 usage，不会与「最新 N 行」错位（review P3-6）。rates 可覆盖。
  turnRefsWindow(tenant: string | undefined, identity: string, limit = 100): Array<{ capture_id: string; ts: number; refs: string[] }> {
    const count = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rawRows = tenant === undefined
      ? this.#db.prepare('SELECT capture_id,ts,refs FROM turns WHERE identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(identity, count)
      : this.#db.prepare('SELECT capture_id,ts,refs FROM turns WHERE tenant=? AND identity=? ORDER BY ts DESC, id DESC LIMIT ?').all(tenant, identity, count);
    return (rawRows as unknown as Array<{ capture_id: string; ts: number; refs: string }>).reverse()
      .map((row) => ({ capture_id: row.capture_id, ts: row.ts, refs: JSON.parse(row.refs) as string[] }));
  }

  cacheEfficiency(turns: Array<{ capture_id: string; ts: number; refs: string[] }>,
    usageByCaptureId: Map<string, EfficiencyUsage>,
    rates: EfficiencyRates = DEFAULT_RATES): ReturnType<typeof computeCacheEfficiency> {
    const bytesCache = new Map<string, number | null>();
    const labels = new Map<string, string>();
    for (const turn of turns) {
      for (const hash of turn.refs) if (!bytesCache.has(hash)) bytesCache.set(hash, this.contentBytes(hash));
      const key = threadKeyOf(turn.refs);
      if (!labels.has(key) && key !== '(none)') labels.set(key, this.contentText(key, 160));
    }
    return computeCacheEfficiency(turns, usageByCaptureId, (hash) => bytesCache.get(hash) ?? null, rates, labels);
  }

  // 内容哈希对应消息的字节数（token 分摊用）。
  contentBytes(hash: string): number | null {
    const row = this.#db.prepare('SELECT bytes FROM content WHERE hash=?').get(hash) as { bytes: number } | undefined;
    return row ? Number(row.bytes) : null;
  }

  // 工具/skill 分析（票 05）：窗口内逐轮解析正文聚合。读侧按需（默认 7 天 / 最多 500 轮），
  // 大窗口是刻意的慢查询，不进热路径。报错口径：工具结果内容以 Error: 前缀开头、
  // 或为 JSON 且顶层含 error 字段——下游重试在请求侧不可见，不在口径内。
  toolStats({ tenant, identity, days = 7, maxTurns = 500, now = Date.now() }: { tenant?: string; identity?: string; days?: number; maxTurns?: number; now?: number }): ToolStatsReport {
    const since = now - Math.max(1, Math.min(90, days)) * 86_400_000;
    const cap = Math.max(10, Math.min(2000, Math.trunc(maxTurns)));
    // 取窗口内最新 cap 条再正序聚合（review P2：ASC+LIMIT 截断会把最新轮排掉，
    // 分析拿旧数据冒充全窗口）。截断状态与实际覆盖起点随报告给出。
    const query = tenant === undefined
      ? (identity === undefined
        ? this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE ts>=? ORDER BY ts DESC, id DESC LIMIT ?')
        : this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE identity=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?'))
      : (identity === undefined
        ? this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE tenant=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?')
        : this.#db.prepare('SELECT id,capture_id,ts,identity,refs FROM turns WHERE tenant=? AND identity=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?'));
    const args = tenant === undefined ? (identity === undefined ? [since, cap] : [identity, since, cap]) : (identity === undefined ? [tenant, since, cap] : [tenant, identity, since, cap]);
    const rowsRaw = query.all(...(args as never[])) as unknown as Array<{ id: number; capture_id: string; ts: number; identity: string | null; refs: string }>;
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
