# 03 缓存效率指标（理想消耗 / 实际消耗）

Status: completed

## 背景

传统口径（Σcache_read / Σprompt_tokens）跨请求求和把同一段唯一前缀算 N 遍：
一个 100k 前缀重读 20 次记 2M 命中，掩盖了「同一批内容被重复付费」的总量。
用户拍板口径（2026-11-20）：**缓存效率 = 理想消耗 / 实际消耗**，浪费占比 = 1 − 效率
=「中间丢缓存多付的差值」。实测（批次目录 probe7.mjs）：串行孩子效率 71.2% /
并行孩子 92.6%，传统口径两者 93–97%——区分度即价值。

## 方案

新模块 `core/observability/cache-efficiency.ts`（纯函数，零运行时依赖，leaks.ts 同层）：

- 输入：线程化后的轮次（capture_id/ts/bytes/refs）+ 每消息字节数查询 + 每轮 usage
  （prompt/cache_hit/cache_write，按 capture_id 关联，来源 data.db requests）+
  计费权重 rates（默认 `{ fresh: 1, write: 1, read: 0.1 }`，可覆盖——write 默认 1 的原因：
  OpenAI 系账本不单列首写量、首付以 fresh 价进账，理想口径首现价必须与账本实际计价一致
  才能让完美线程得 1.0；Anthropic 系部署把 write 调 1.25 让两侧都含首写溢价）。
- 分组：refs[1] 线程键（与票 02 同一把钥匙）；每线程独立 first-seen 表。
- 理想消耗（分子）：线程内每条唯一消息首次出现付 `write`，此后每次出现付 `read`。
- 实际消耗（分母）：每轮 `fresh×1 + write×1（默认） + read×0.1`（账本形状逐行自适应：
  exclusive=Anthropic 系 fresh=prompt、inclusive=OpenAI 系 fresh=prompt−hit−write；
  write=1.25 供 Anthropic 部署经 ?write= 传入）；
  usage 缺失（cache_observed=false 或行缺）的轮按理想口径同权重的 fresh 保守估算？——**不做**：
  usage 缺失的轮从两个口径同时剔除（比例失衡比缺行更误导），剔除数随响应报告。
- 消息级 token 估算：`content.bytes × (分摊总量 / Σ本轮 content.bytes)`（分摊总量
  inclusive=prompt、exclusive=prompt+hit+write；不是 turn.bytes——后者含 JSON 开销）。
- 输出：`{ window, totals: { turns_used, turns_skipped_no_usage, turns_skipped_no_content,
  corpus_tokens_est, actual_weighted, ideal_weighted, efficiency, waste_share, read_multiplier },
  threads: [{ key, label, turns, corpus_tokens_est, actual, ideal, efficiency, waste_share }],
  assumptions: {...}, hint }`。`read_multiplier` = Σcache_read / corpus_est（重读倍数 R）。

接线：

- `CaptureStore.cacheEfficiency(tenant, identity, limit, usageByCaptureId)`：取轮次 +
  content.bytes，组参调纯函数（CaptureStore 不看 data.db，usage 由 admin 层喂入）。
- admin.ts 新只读端点 `GET /api/capture/cache-efficiency?identity=&tenant=&limit=&fresh=&write=&read=`：
  usage + 原始 usage_json 按 capture_id 精确直查（`audit.usageByCaptureIds`，按轮次锚点取数，
  不与「最新 N 行」窗口错位——review P3-6）；capture 未启用 404，缺 identity 400，rates
  越界/非数字 400（对齐 cache-forensics 口径）。
- trajectory.html 会话头部加效率条（efficiency/waste/R），获取失败静默不挡轨迹。

## 验收

- [x] 纯函数单测：完美 append-only 线程（每轮只增一条、账本 read=全部旧消息）→ efficiency=1.0
- [x] 纯函数单测：中途丢缓存（账本 hit=0、write=全量重写）→ efficiency<1 且浪费集中在该轮
- [x] 纯函数单测：两个交错线程各自独立 first-seen（共享 system 消息在两线程各计一次写）
- [x] rates 可覆盖（read=1 时完美线程 efficiency=1.0 仍成立；单测 + 端点 ?read=1 集成断言）
- [x] usage 缺失轮剔除且 `turns_skipped_no_usage` 报数（另有 `turns_skipped_no_content` 分列）
- [x] 端点集成测：404（无 capture）/400（缺 identity、rates 越界）/正常响应形状
- [x] node --test 全绿 + typecheck 过门

## Comments

- 2026-11-20：立项。前序调研：三家网关口径错例 + OpenAI 官方摊销例子 +
  Oracle BCHR 先例（会话内已核对，笔记在批次目录）。
- 完成 commit：e6dca52（初版）+ review 修复批（本提交）。独立 review（0 P1/1 P2/8 P3，
  findings 正本 `/root/ffr-scratch/2026-11-20-llm-cpr-subagent-capture/review-findings.md`）
  的 P2-1（Anthropic 形状 fresh 钳零）修法 = 账本形状逐行自适应（usage_json 探测 + 
  write>0/hit>prompt 启发式兜底；exclusive 的分摊总量 = prompt+hit+write）——用 review
  自己的探针（/root/.hermes/cache/scratch/rev-probe/probe-eff.mjs）复验：actual 350→450，
  不再漏计 fresh。P3 全修：分摊公式三处文档同步、rates 经 ?fresh=/?write=/?read= 覆盖、
  新增 test/cache-efficiency.test.ts 六个纯函数单测、UI「切线」标真实渲染、usage 窗口按
  锚点直查根除错位、threadKey 复用单实现 + label_hash 死字段移除、渲染 O(n²) 改序号传参。
- 验证：`node --test` 218/218（含 6 个新纯函数单测 + rates/400 集成断言）、
  `npm run typecheck` 过；UI 冒烟（真浏览器 CDP）13/13 含效率条断言；trajectory 效率条
  在单线程与家族会话均渲染（A3/A11b）。
- 没做的验证：会话级（非线程级）全局聚合未实现（spec 开放问题，留待真需求）；
  Anthropic 形状账本的真连接路验证（形状自适应由合成 exclusive 数据覆盖，CCG 真流量
  待生产观察）。
- 2026-11-20 补注：write 默认价定为 1（OpenAI 系账本不单列首写），毛刺与理由见
  core/observability/cache-efficiency.ts DEFAULT_RATES 注记；这推翻了本票初版的
  「write 默认 1.25」，spec 已同步。
