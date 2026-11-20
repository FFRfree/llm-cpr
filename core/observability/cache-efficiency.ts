// 缓存效率指标（family-observability 票 03）：用户拍板口径——
//   缓存效率 = 理想消耗 / 实际消耗 ∈ (0,1]，浪费占比 = 1 − 效率 =「中间丢缓存多付的差值」。
// 理想消耗（分子）：线程内每条唯一消息首次出现付写价、之后每次出现付读价
//   （「每条 message 缓存起来、从不丢」的完美世界）。
// 实际消耗（分母）：账本三分量加权求和 fresh×1 + write×1.25 + read×0.1（输出两侧相同，不计入）。
// 为什么不用传统口径（Σread/Σprompt）：跨请求求和把同一段唯一前缀算 N 遍——100k 前缀重读
//   20 次记 2M 命中，掩盖「同一批内容被重复付费」的总量；此处唯一语料只计一次。
// 消息级 token 估算：content.bytes × (turn.prompt_tokens / turn.bytes)——每轮独立 scale，
//   两侧同法分摊，误差大部分抵消。消息级哈希是前缀缓存的**代理指标**（历史 append-only 时
//   等价；压缩改写两侧同时受损）；归因措辞一律「证据指向」，不下断言。
// usage 缺失的轮（账本行缺 / prompt_tokens 为 null / cache_observed=false）从两个口径同时
//   剔除并报数——单侧剔除会让比例失衡，比缺行更误导。

export interface EfficiencyRates {
  // 相对全价 input 的倍率：fresh=1 基准；write 首写溢价（Anthropic 1.25×/2×，OpenAI 1.25×）；
  // read 缓存命中折扣（主流 0.1×）。按 provider 形状可覆盖。
  fresh: number;
  write: number;
  read: number;
}

export interface EfficiencyTurn {
  capture_id: string;
  ts: number;
  // 本轮请求体字节数（分摊用分母；0 时该轮消息 token 全按 0 计）。
  bytes: number;
  // 本轮消息哈希列表（盐化 sha256，同哈希 ⟺ 同内容）。
  refs: string[];
}

export interface EfficiencyUsage {
  prompt_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_write_tokens: number | null;
  // 账本 cache_observed：false = 上游没报缓存分量（hit/write 语义不可信），该轮剔除。
  cache_observed: boolean | null;
}

export interface EfficiencyThreadReport {
  key: string;
  label: string | null;
  turns: number;
  corpus_tokens_est: number;
  actual_weighted: number;
  ideal_weighted: number;
  efficiency: number | null;
  waste_share: number | null;
}

export interface CacheEfficiencyReport {
  window: { turns: number; since: number | null; until: number | null };
  totals: {
    turns_used: number;
    turns_skipped_no_usage: number;
    corpus_tokens_est: number;
    actual_weighted: number;
    ideal_weighted: number;
    efficiency: number | null;
    waste_share: number | null;
    read_multiplier: number | null;
  };
  threads: EfficiencyThreadReport[];
  assumptions: {
    rates: EfficiencyRates;
    attribution: string;
  };
  hint: string;
}

export const DEFAULT_RATES: EfficiencyRates = { fresh: 1, write: 1, read: 0.1 };
// write 默认 = 1 的原因：OpenAI 系账本（prompt_tokens 含缓存、cached_tokens 单列）**不单列
// 首写量**，首付以 fresh 价进账——理想口径的首现价格必须与账本实际计价一致，完美线程才能
// 得 1.0。Anthropic 系账本（input_tokens 为 fresh-only，cache_creation 单列）的部署应把
// write 调成 1.25，让两侧都含首写溢价。

// 线程键与 capture.ts cacheChain 同一把钥匙：refs[1] = 首条 user 消息哈希
// （refs[0] 是 system，兄弟间相同）；不足两条回落 refs[0]，再回落 '(none)'。
// 孩子的 goal 消息全程留在上下文里，键在其生命周期恒定；压缩改写后变化——那正是线程分裂。
export function threadKeyOf(refs: string[]): string {
  if (refs.length >= 2) return refs[1];
  if (refs.length === 1) return refs[0];
  return '(none)';
}

export function computeCacheEfficiency(
  turns: EfficiencyTurn[],
  usageByCaptureId: Map<string, EfficiencyUsage>,
  contentBytes: (hash: string) => number | null,
  rates: EfficiencyRates = DEFAULT_RATES,
  labels: Map<string, string> | null = null,
): CacheEfficiencyReport {
  const sorted = turns.slice().sort((a, b) => a.ts - b.ts);
  const threadAgg = new Map<string, { turn_count: number; corpus: number; actual: number; ideal: number; since: number; until: number }>();
  const seen = new Map<string, Set<string>>(); // threadKey → 已见消息哈希
  const bytesMemo = new Map<string, number | null>(); // contentBytes 回调的进程内去重
  let actual = 0, ideal = 0, corpus = 0, sumHit = 0, used = 0, skipped = 0, since = null as number | null, until = null as number | null;

  for (const turn of sorted) {
    const usage = usageByCaptureId.get(turn.capture_id);
    const prompt = usage && typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    // usage 缺失（无行 / prompt null / cache_observed=false）→ 两个口径同时剔除。
    if (prompt === null || prompt <= 0) { skipped += 1; continue; }
    if (usage && usage.cache_observed === false) { skipped += 1; continue; }
    const hit = usage && typeof usage.cache_hit_tokens === 'number' ? usage.cache_hit_tokens : 0;
    const write = usage && typeof usage.cache_write_tokens === 'number' ? usage.cache_write_tokens : 0;
    const fresh = Math.max(0, prompt - hit - write);

    const key = threadKeyOf(turn.refs);
    // token 分摊分母 = 本轮全部消息的 content.bytes 之和（不是 turn.bytes——后者含 JSON 语法
    // 开销，会把分摊压小、让理想口径系统性偏低）。分摊后 Σ消息 token 恰等于 prompt_tokens，
    // 完美 append-only 线程的两侧严格相等。内容行缺失（TTL 清理/降级）无法归因 → 同样剔除。
    let contentSum = 0;
    const perMessage = new Map<string, number>();
    for (const hash of turn.refs) {
      let b = bytesMemo.get(hash);
      if (b === undefined) { b = contentBytes(hash); bytesMemo.set(hash, b); }
      const bytes = b ?? 0;
      perMessage.set(hash, bytes);
      contentSum += bytes;
    }
    if (contentSum <= 0) { skipped += 1; continue; }
    const scale = prompt / contentSum;

    let thread = threadAgg.get(key);
    if (!thread) { thread = { turn_count: 0, corpus: 0, actual: 0, ideal: 0, since: turn.ts, until: turn.ts }; threadAgg.set(key, thread); }
    const seenInThread = seen.get(key) ?? seen.set(key, new Set()).get(key)!;

    let threadIdeal = 0, threadCorpusDelta = 0;
    for (const hash of turn.refs) {
      const tok = (perMessage.get(hash) ?? 0) * scale;
      if (seenInThread.has(hash)) threadIdeal += tok * rates.read;
      else { seenInThread.add(hash); threadIdeal += tok * rates.write; threadCorpusDelta += tok; }
    }
    thread.corpus += threadCorpusDelta;
    thread.ideal += threadIdeal;
    thread.actual += fresh * rates.fresh + write * rates.write + hit * rates.read;
    thread.turn_count += 1;
    thread.until = turn.ts;

    actual += fresh * rates.fresh + write * rates.write + hit * rates.read;
    ideal += threadIdeal;
    corpus += threadCorpusDelta;
    sumHit += hit;
    used += 1;
    if (since === null) since = turn.ts;
    until = turn.ts;
  }

  const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
  const effOf = (a: number, i: number): number | null => { const e = ratio(i, a); return e === null ? null : Math.min(1, e); };
  const wasteOf = (a: number, i: number): number | null => { const e = ratio(i, a); return e === null ? null : Math.max(0, 1 - e); };

  const threads: EfficiencyThreadReport[] = [...threadAgg.entries()]
    .map(([key, t]) => ({
      key,
      label: labels?.get(key) ?? null,
      turns: t.turn_count,
      corpus_tokens_est: t.corpus,
      actual_weighted: t.actual,
      ideal_weighted: t.ideal,
      efficiency: effOf(t.actual, t.ideal),
      waste_share: wasteOf(t.actual, t.ideal),
    }))
    .sort((a, b) => b.corpus_tokens_est - a.corpus_tokens_est || a.key.localeCompare(b.key));

  const efficiency = effOf(actual, ideal);
  return {
    window: { turns: turns.length, since, until },
    totals: {
      turns_used: used,
      turns_skipped_no_usage: skipped,
      corpus_tokens_est: corpus,
      actual_weighted: actual,
      ideal_weighted: ideal,
      efficiency,
      waste_share: wasteOf(actual, ideal),
      read_multiplier: ratio(sumHit, corpus),
    },
    threads,
    assumptions: {
      rates: { ...rates },
      attribution: '消息级哈希是前缀缓存的代理指标（历史 append-only 时等价）；token 按 content.bytes × (prompt_tokens/turn.bytes) 分摊；理想口径 = 每条唯一消息一次写价 + 每次复用读价',
    },
    hint: 'efficiency 是「现实离完美缓存世界有多远」：100% = 每条唯一消息只付一次写价、之后全走读价；waste_share 是丢缓存多付的差值。usage 缺失的轮两个口径同时剔除（turns_skipped_no_usage）。对订阅套餐租户这是额度效率代理，不是现金账单',
  };
}
