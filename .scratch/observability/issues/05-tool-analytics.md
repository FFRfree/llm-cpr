# 05 工具/skill 分析：调用次数、报错率、灌 token 排行

Status: completed
Blocked by: (resolved: 01)

## 验收

- [x] 从 item 模型的工具实体聚合：(tenant, identity, 时间范围) 维度的
      每工具调用次数、成功/报错率（按下游 finish/error 口径，先定义清楚「报错」
      指工具结果里的 error 形态还是下游重试，别猜）。
- [x] **灌 token 排行**：每工具累计往上下文里注入的字符量/token 估算
      （3.5 字符/token 折算口径沿用现有注记），按会话与按天两种粒度。
- [x] 死循环/卡住检测的原料就位：同工具同参数哈希连续多轮重复的会话标记出来。
- [x] 管理口端点 + 看板页面（读侧聚合，按需查询）。

## 设计要点

- 工具结果（tool 角色消息 / tool_result 块）是上下文大头，「哪个工具最费上下文」
  对用户调 agent 行为最有直接指导意义——排行是本票的核心交付，不是附带。
- 工具名归属：chat-completions 里 tool 消息带 tool_call_id 回指 assistant 的
  tool_calls[].function.name——归一化 item 模型已保留这个关联，聚合按 name。
- 技能级统计别指望正文（skill 展开成工具调用发生在客户端）——本票精确到工具粒度，
  skill 粒度若要精确仍走标记头（Hermes 侧生产改动，单独授权，暂不做）。

## 开放问题

- 参数哈希要不要保留原始参数片段供排查（隐私权衡，倾向只留哈希+长度）。

## Comments

- commit 45e8626。落点：`core/store/capture.ts` toolStats（读侧逐轮解析：assistant
  tool_calls 建 id→name 映射后归 tool 结果；calls 只在 tool_call 上计、results/errors/
  result_chars 在 tool 消息上计——初版把结果也计了 calls，测试抓出）+
  `/api/capture/tools`（days/max_turns/identity 参数，默认 7 天 500 轮上限，大窗口是
  刻意的慢查询不进热路径）+ 看板「观测 · 正文捕获」面板（状态 + 工具排行 + 卡住候选 +
  泄漏命中）。
- 报错口径（写死在代码注释与响应）：工具结果内容为 JSON 且顶层含 error 字段、或文本
  以 Error: 前缀开头；下游重试在请求侧不可见，不在口径内。
- 卡住检测：同 identity + 同工具 + 同参数哈希（只留 sha256 前 16 hex + 长度，不留原始
  参数——开放问题答案取隐私侧）相邻轮（间隔 ≤1h）连续 ≥3 次即候选，loops 输出。
- 验证：test/observability.test.ts 工具分析用例（calls=3/results=3/errors=2/error_rate、
  search_web 灌 3500 字符 ≈1000 token 居排行首、连击 streak≥3、by_session 粒度）+
  全量 182/182。
- 没做的验证：真实 agent 流量上的排行观察（生产开启后积累）；skill 粒度（标记头方案，
  单独授权，暂不做）。
- 独立 review 出 P2（toolStats ASC+LIMIT 截断保留最旧轮、报告冒充全窗口）→ 已修：
  取最新 cap 条再正序聚合，报告加 turns_truncated/covered_since，回归测试配齐
  （commit 1d36294，findings 正本 ../review-1.md）。
