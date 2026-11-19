# 03 缓存取证：逐消息哈希对比，缓存断点定位到「哪条先变」

Status: completed
Blocked by: (resolved: 01)

## 验收

- [x] 相邻两轮捕获请求（同 identity+会话序）的引用列表逐位对比，输出：
      前缀公共长度（条数）、第一条分歧的位置与其角色（system/user/assistant/tool）。
- [x] 断点事件与既有事件账对齐：route.rebind（改绑换上游）、账本 chars 大跳，
      时间线并排展示——回答「这次缓存断裂是改绑、客户端改提示词、还是插消息造成」。
- [x] chars 增量比与哈希结论互相校验（增量比突增 ↔ 前缀公共长度骤降），不一致要能解释。
- [x] 读侧聚合报表/管理口端点，不加重热路径。

## 设计要点

- 内容寻址的引用列表本身就是逐条对比材料，本票大部分是 01 的白送能力——
  实现重点在「关联查询 + 归因」，不在新存储。
- 各家缓存线索不同：OpenAI 自动前缀缓存 + 文档出现的 `prompt_cache_breakpoint`；
  Anthropic `cache_control`（显式/顶层自动）；Gemini `cachedContent`/隐式缓存。
  第一版只按 chat-completions 做，缓存线索实体进 item 模型留位（票 01 已列四类实体）。
- 归因别过度自信：模型家族/快照过期等外部因素也会断缓存，报表措辞用「证据指向」
  而非「原因就是」。

## 开放问题

- keep-affinity 的价值量化输出形态：报告页 or 每月汇总事件（发 Telegram 的口径）？

## Comments

- commit 45e8626。落点：`core/store/capture.ts` cacheChain（相邻轮逐位哈希对比：
  common_prefix / first_diff_index / first_diff_role 借 content 反查角色 / chars_delta）+
  管理口 `/api/capture/cache-forensics?tenant=&identity=`（chain + 同窗口 route.rebind
  事件并排 + hint 字段写明 chars 与哈希不一致时以哈希为准的解释）。
- 互校说明（写进响应 hint）：chars_delta 与 common_prefix 不一致以哈希结论为准——
  chars 还受非消息字段影响；措辞统一「证据指向」。
- 验证：test/observability.test.ts 缓存取证用例（追加轮 common=2 分歧在 assistant 追加位、
  改 system 后 common=0 分歧位 0 角色 system）+ 全量 182/182。
- 没做的验证：keep-affinity 月度汇总事件形态（开放问题留给用户拍板后再做——报告页
  形态先以端点交付）；非 chat-completions 协议。
