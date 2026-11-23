// 缓存效率指标（family-observability 票 03）：用户拍板口径——
//   缓存效率 = 理想消耗 / 实际消耗 ∈ (0,1]，浪费占比 = 1 − 效率 =「中间丢缓存多付的差值」。
// 理想消耗（分子）：线程内每条唯一消息首次出现付首现价、之后每次出现付读价
//   （「每条 message 缓存起来、从不丢」的完美世界）。
// 实际消耗（分母）：账本三分量加权求和 fresh×1 + write×1 + read×0.1（输出两侧相同，不计入）。
// 为什么不用传统口径（Σread/Σprompt）：跨请求求和把同一段唯一前缀算 N 遍——100k 前缀重读
//   20 次记 2M 命中，掩盖「同一批内容被重复付费」的总量；此处唯一语料只计一次。
// 消息级 token 估算：content.bytes × (prompt / Σ本轮 content.bytes)——分母是**本轮全部消息的
//   内容字节和**（不是 turn.bytes，后者含 JSON 语法开销会把分摊压小）；分摊后 Σ消息 token 恰
//   等于 prompt，完美 append-only 线程两侧严格相等。消息级哈希是前缀缓存的**代理指标**
//   （历史 append-only 时等价；压缩改写两侧同时受损）；归因措辞一律「证据指向」，不下断言。
// 账本形状自适应（review P2-1）：tokenFields 落库不改列，inclusive/exclusive 两种真实形状并存
//   ——OpenAI 系 prompt_tokens **含**缓存（fresh = prompt − hit − write）；Anthropic 系
//   input_tokens 是 fresh-only（fresh = prompt，total = prompt + hit + write）。逐行探测：
//   usage_json 含 cache_read/cache_creation_input_tokens → exclusive；含 prompt_tokens/
//   input_tokens_details/cached_tokens → inclusive；无 usage_json 时启发式兜底
//   （write>0 或 hit>prompt ⇒ exclusive——OpenAI 行的 hit 是 prompt 子集，不可能超过 prompt）。
// 剔除口径（review P3-6）：usage 缺失的轮（账本行缺 / prompt null / cache_observed=false）与
//   内容缺失的轮（content 行被 TTL 清理/降级，无法归因）**分别计数剔除**——单侧剔除会让比例
//   失衡，比缺行更误导。

export interface EfficiencyRates {
  // 相对全价 input 的倍率：fresh=1 基准；write 首现价（OpenAI 系账本不单列首写、以 fresh 价
  // 进账 → 默认 1，完美线程才能得 1.0；Anthropic 系账本 cache_creation 单列 → 部署调 1.25
  // 让两侧都含首写溢价，经管理口 ?write= 传入）；read 缓存命中折扣（主流 0.1×）。
  fresh: number;
  write: number;
  read: number;
}

export interface EfficiencyTurn {
  capture_id: string;
  ts: number;
  // 本轮消息哈希列表（盐化 sha256，同哈希 ⟺ 同内容）。
  refs: string[];
}

export interface EfficiencyUsage {
  prompt_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_write_tokens: number | null;
  // 账本 cache_observed：false = 上游没报缓存分量（hit/write 语义不可信），该轮剔除。
  cache_observed: boolean | null;
  // 原始上游 usage JSON（形状探测用；缺省走启发式）。
  usage_json?: string | null;
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
    turns_skipped_no_content: number;
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
// 得 1.0。Anthropic 系账本（input_tokens 为 fresh-only，cache_creation 单列）的部署经管理口
// ?write=1.25 让两侧都含首写溢价。

// 线程键与 capture.ts cacheChain 同一把钥匙：refs[1] = 首条 user 消息哈希
// （refs[0] 是 system，兄弟间相同）；不足两条回落 refs[0]，再回落 '(none)'。
// 孩子的 goal 消息全程留在上下文里，键在其生命周期恒定；压缩改写后变化——那正是线程分裂。
export function threadKeyOf(refs: string[]): string {
  if (refs.length >= 2) return refs[1];
  if (refs.length === 1) return refs[0];
  return '(none)';
}

// 账本形状逐行探测（见头注「账本形状自适应」）。exclusive = prompt_tokens 是 fresh-only。
function isExclusiveShape(usage: EfficiencyUsage | undefined): boolean {
  if (!usage) return false;
  const json = usage.usage_json ?? '';
  if (json) {
    if (json.includes('cache_read_input_tokens') || json.includes('cache_creation_input_tokens')) return true;
    if (json.includes('prompt_tokens') || json.includes('input_tokens_details') || json.includes('cached_tokens')) return false;
  }
  const hit = usage.cache_hit_tokens ?? 0;
  const write = usage.cache_write_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;
  return write > 0 || hit > prompt;
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
  let actual = 0, ideal = 0, corpus = 0, sumHit = 0, used = 0, skippedNoUsage = 0, skippedNoContent = 0;
  let since = null as number | null, until = null as number | null;

  for (const turn of sorted) {
    const usage = usageByCaptureId.get(turn.capture_id);
    const prompt = usage && typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    // usage 缺失（无行 / prompt null / cache_observed=false）→ 两个口径同时剔除。
    if (prompt === null || prompt <= 0) { skippedNoUsage += 1; continue; }
    if (usage && usage.cache_observed === false) { skippedNoUsage += 1; continue; }
    const hit = usage && typeof usage.cache_hit_tokens === 'number' ? usage.cache_hit_tokens : 0;
    const write = usage && typeof usage.cache_write_tokens === 'number' ? usage.cache_write_tokens : 0;

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
    if (contentSum <= 0) { skippedNoContent += 1; continue; }
    // 分摊总量：inclusive = prompt（已含缓存）；exclusive = prompt + hit + write（prompt 只是
    // fresh 段，total input 还要加上缓存两分量）。
    const exclusive = isExclusiveShape(usage);
    const attributionTotal = exclusive ? prompt + hit + write : prompt;
    const scale = attributionTotal / contentSum;

    // 实际消耗按账本形状折算（见头注）：exclusive 的 prompt 就是 fresh；inclusive 的 fresh =
    // prompt − hit − write。写价按 rates.write（默认 1；Anthropic 部署调 1.25）。
    const fresh = exclusive ? prompt : Math.max(0, prompt - hit - write);
    const turnActual = fresh * rates.fresh + hit * rates.read + write * rates.write;

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
    thread.actual += turnActual;
    thread.turn_count += 1;
    thread.until = turn.ts;

    actual += turnActual;
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
      turns_skipped_no_usage: skippedNoUsage,
      turns_skipped_no_content: skippedNoContent,
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
      attribution: '消息级哈希是前缀缓存的代理指标（历史 append-only 时等价）；token 按 content.bytes × (prompt / Σ本轮 content.bytes) 分摊，Σ消息 token == prompt；理想口径 = 每条唯一消息一次首现价 + 每次复用读价；账本形状逐行探测（exclusive = Anthropic 系 prompt 为 fresh-only；inclusive = OpenAI 系 prompt 含缓存）',
    },
    hint: 'efficiency 是「现实离完美缓存世界有多远」：100% = 每条唯一消息只付一次首现价、之后全走读价；waste_share 是丢缓存多付的差值。usage 缺失与内容缺失的轮分别剔除（turns_skipped_no_usage / turns_skipped_no_content），两侧同剔防比例失衡。对订阅套餐租户这是额度效率代理，不是现金账单',
  };
}
