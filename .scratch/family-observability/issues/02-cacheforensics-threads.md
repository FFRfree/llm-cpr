# 02 cacheChain 线程化

Status: completed

## 背景

`CaptureStore.cacheChain`（core/store/capture.ts）按「同 (tenant, identity) 时间序相邻
两轮」对比 common_prefix。deleg 家族（多 subagent 共享身份）交错落库时，「上一轮」
经常是另一个孩子的轮次：实测 163 个相邻边界中 100 个只剩 system 一条相同且首条 user
消息也换了——这些假断裂把真断链（改绑/压缩/改提示词）淹没。

## 方案

线程键 = `refs[1]`（首条 user 消息哈希；refs[0] 是 system，兄弟间相同；refs 不足两条时
回落 refs[0]，再回落 '(none)'）。该键在孩子的整个生命周期恒定（goal 全程留上下文），
压缩改写后变化——那正是「线程分裂」，本来就该按新段对待。

`cacheChain` 每条 entry 新增字段（老字段全部保留，老消费者不破）：

- `thread_key`：本路线程键；
- `boundary`：`'first' | 'same-thread' | 'thread-switch'`（时间序上一轮的线程键不同 =
  switch）；
- `prev_in_thread_id` / `prev_in_thread_ts`：线程内上一轮；
- `common_prefix_in_thread` / `first_diff_in_thread_index` / `first_diff_in_thread_role`：
  线程内口径的前缀对比（口径与老的 common_prefix 相同，只是 previous 换成线程内上一轮）。

顶层新增 `threads` 汇总数组（按首轮时间升序）：

- `key` / `label`（refs[1] 消息正文截断 ~160 字符；内容缺失时 '(content unavailable)'）/
  `first_ts` / `last_ts` / `turn_count` / `bytes`。

响应 hint 文案更新：断裂判定以**线程内**前缀为准；`thread-switch` 边界是家族交错，
不是前缀断裂。归因措辞保持「证据指向」纪律。

`limit` 语义不变（时间序取最新 N 轮再恢复升序）；线程内对比可能因窗口截断缺上一轮
（`prev_in_thread_id: null`），不算错误。

## 验收

- [x] 交错 fixture（两个线程 A/B 轮流落轮）：切孩子边界 `boundary='thread-switch'`，
      线程内对比字段与线程内上一轮正确配对
- [x] `threads` 汇总数组正确（条数、label、轮数、时间范围、升序）
- [x] 单线程 fixture 行为与现状等价（boundary='same-thread'，线程内口径 = 老口径）
- [x] 老字段（common_prefix/first_diff_index/first_diff_role/chars_delta）值不回归
- [x] 窗口截断时线程内缺上一轮 → `prev_in_thread_id: null`，不抛错
- [x] node --test 全绿

## Comments

- 2026-11-20：立项。实测探针 probe6.mjs（批次目录）。
- 完成 commit：e6dca52（初版）+ review 修复批（本提交）。实现注记：boundary 判定
  **纯按时间序上一轮的线程键**（同键=same-thread / 异键=thread-switch / 无=first），
  线程内延续信息由 prev_in_thread_* 正交携带——测试中 b2（线程 B 第二轮但时间序邻居是
  A2）因此标 switch；threadKey 复用 cache-efficiency.ts 的 threadKeyOf（防双份实现漂移）。
- 验证：`node --test` 218/218（含新交错 fixture「cache forensics threads: interleaved…」、
  单线程等价、limit=3 窗口截断的 prev_in_thread_id null 断言）；老 cache-forensics 测试
  （common_prefix/first_diff/limit）原样通过；sessions.html 老消费方未被形状变化破坏
  （review 确认）。
- 没做的验证：生产真实家族数据上的链路走查（合成夹具覆盖）。
