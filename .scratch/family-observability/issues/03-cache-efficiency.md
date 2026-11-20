# 03 缓存效率指标（理想消耗 / 实际消耗）

Status: ready-for-agent

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
  计费权重 rates（默认 `{ fresh: 1, write: 1.25, read: 0.1 }`，可覆盖）。
- 分组：refs[1] 线程键（与票 02 同一把钥匙）；每线程独立 first-seen 表。
- 理想消耗（分子）：线程内每条唯一消息首次出现付 `write`，此后每次出现付 `read`。
- 实际消耗（分母）：每轮 `fresh×1 + write×1.25 + read×0.1`；fresh = max(0, prompt − hit − write)；
  usage 缺失（cache_observed=false 或行缺）的轮按理想口径同权重的 fresh 保守估算？——**不做**：
  usage 缺失的轮从两个口径同时剔除（比例失衡比缺行更误导），剔除数随响应报告。
- 消息级 token 估算：`content.bytes × (turn.prompt_tokens / turn.bytes)`（每轮独立 scale，
  两侧同法分摊，误差大部分抵消）。
- 输出：`{ window, totals: { turns_used, turns_skipped_no_usage, corpus_tokens_est,
  actual_weighted, ideal_weighted, efficiency, waste_share, read_multiplier },
  threads: [{ key, label, turns, corpus_tokens_est, actual, ideal, efficiency, waste_share }],
  assumptions: {...}, hint }`。`read_multiplier` = Σcache_read / corpus_est（重读倍数 R）。

接线：

- `CaptureStore.cacheEfficiency(tenant, identity, limit, usageByCaptureId)`：取轮次 +
  content.bytes，组参调纯函数（CaptureStore 不看 data.db，usage 由 admin 层喂入）。
- admin.ts 新只读端点 `GET /api/capture/cache-efficiency?identity=&tenant=&limit=`：
  usage 来自 `audit.listRequests({ identity, tenant, limit })`（≤500，与轮次上限同宽），
  按 capture_id 建 Map；capture 未启用 404，缺 identity 400（对齐 cache-forensics 口径）。
- trajectory.html 会话头部加效率条（efficiency/waste/R），获取失败静默不挡轨迹。

## 验收

- [ ] 纯函数单测：完美 append-only 线程（每轮只增一条、账本 read=全部旧消息）→ efficiency=1.0
- [ ] 纯函数单测：中途丢缓存（账本 hit=0、write=全量重写）→ efficiency<1 且浪费集中在该轮
- [ ] 纯函数单测：两个交错线程各自独立 first-seen（共享 system 消息在两线程各计一次写）
- [ ] rates 可覆盖（read=1 时完美线程 efficiency=1.0 仍成立，R 恒等轮数−1）
- [ ] usage 缺失轮剔除且 `turns_skipped_no_usage` 报数
- [ ] 端点集成测：404（无 capture）/400（缺 identity）/正常响应形状
- [ ] node --test 全绿 + typecheck 过门

## Comments

- 2026-11-20：立项。前序调研：三家网关口径错例 + OpenAI 官方摊销例子 +
  Oracle BCHR 先例（会话内已核对，笔记在批次目录）。
