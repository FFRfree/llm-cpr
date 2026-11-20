# family-observability：deleg 家族视角的观测层改造

## 背景（2026-11-20 实测定案）

Hermes 对 delegate subagent 的会话身份是**全家族共享一个**：父对话的会话根 id
（`run_agent.py` `_conversation_root_id` 从 `_parent_session_id` 走血缘；fork 孩子拿不到
declared scope），同一父亲先后派的多批孩子共用一个 `x-session-id`。实测（双子代理实验 +
capture 正文核对）：两个并行孩子在 data.db 里是同一 identity 的两行请求。业界对标
（Claude Code / Codex / Gemini CLI / OpenCode，笔记 `/root/ffr-scratch/2026-11-20-llm-cpr-subagent-capture/harness-*.md`）
四家全部同阵营——兄弟共享父身份是共识，为的是上游 prompt cache（内容寻址缓存不需要共享身份，
路由键控缓存必须共享）。

后果（本 feature 要治的三件事）：

1. **轨迹页串台**：trajectory.html 按时间平铺一个身份的轮次，deleg 家族里多个孩子的轮次
   交错显示，看不出谁是谁。解法：轮次按「线程键」分组——每轮 refs（消息哈希列表）的
   `refs[1]`（首条 user 消息哈希；refs[0] 是 system，兄弟间相同）在孩子的整个生命周期里
   恒定（goal 消息全程留在上下文），按它分组即可无歧义拆分线程。已用真数据验证：
   164 轮 / 6 线程全部分开（`probe5.mjs`）。
2. **cacheChain 取证失真**：`capture.ts` 的 `cacheChain` 口径是「同 (tenant, identity)
   时间序相邻两轮对比」。家族交错时「上一轮」经常是另一个孩子的轮次，`common_prefix`
   只剩 system 1 条相同，61%（实测 163 边界中 100 个）的"前缀断裂"其实是切了孩子的假断裂，
   真断链（改绑/压缩）被淹没。解法：链上每条加线程归属，`common_prefix` 只在线程内算，
   跨线程边界单列 `boundary: 'thread-switch'` 不计入断裂。
3. **缓存命中率口径失真**：传统口径（Σcache_read / Σprompt）跨请求求和会把同一段唯一
   前缀算 N 遍。用户拍板的口径（2026-11-20）：**缓存效率 = 理想消耗 / 实际消耗**——
   - 理想消耗（分子）：线程内每条唯一消息首次出现付写价，之后每次出现付读价
     （"每条 message 缓存起来、从不丢"的完美世界）；
   - 实际消耗（分母）：账本三分量加权求和 fresh×1 + write×1（默认；Anthropic 形状部署调
     1.25）+ read×0.1（输出两侧相同，不计入）；消息级 token 按
     `content.bytes × (分摊总量 / Σ本轮 content.bytes)` 分摊（分摊总量 inclusive=prompt、
     exclusive=prompt+hit+write；实现为逐行形状自适应，review P2-1 后定稿）；
   - 浪费占比 = 1 − 效率，即"中间丢缓存多付的差值"。实测（probe7.mjs）：串行孩子
     效率 71.2%、并行孩子 92.6%，而传统口径两者都是 93–97%——区分度是本指标的价值。

数据全部现成（capture.db 的 turns.refs/content.bytes + data.db 的 usage 三分量），
纯读侧计算，不动存储、不动转发路径。

## 不变的约束

- capture 是租户级 opt-in；未开启租户的端点照旧 404。
- 管理口零应用层认证的既有纪律不变（127.0.0.1 绑定）；新端点只读。
- 正文经管理口可还原是既有能力（turnBody 已返回全文），线程 label 只是再截一段，无新暴露面。
- 零运行时依赖；`node --test` 全绿 + `npm run typecheck` 过门。
- 消息级哈希是前缀缓存的**代理指标**（历史 append-only 时等价；压缩改写两侧同时受损），
  归因措辞一律「证据指向」，不下断言（对齐票 03 既有措辞纪律）。

## 票

- 01 轨迹页树形：trajectory.html 中列从时间平铺改为「父会话 → 线程 → 轮次」树，
  树形数据来自 02 的 threads 输出；会话头部显示家族徽标（线程数/总轮数）。
- 02 cacheChain 线程化：链上每条加 thread_key / boundary / 线程内前缀对比字段，
  顶层加 threads 汇总；老字段（common_prefix 等时间序口径）保留不删。
- 03 缓存效率指标：core/observability/cache-efficiency.ts 纯函数 + 管理口
  `/api/capture/cache-efficiency` + trajectory 页会话头部效率条。

## 开放问题

- 会不会话级（非线程级）的效率聚合（全局看板按天聚合）——留待 03 落地后看需求，本期只做
  单身份（单家族）口径，避免大窗口慢查询进热路径。
- response_refs 未实现（响应侧正文），效率指标只覆盖请求侧——口径注记随响应给出。
