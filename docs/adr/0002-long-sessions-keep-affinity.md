# 长会话不做额度改绑，保上游 prompt cache

撞墙改绑会把会话换到另一个 backend，上游 prompt cache 全部作废；对请求轮数 ≥ `routing.long_session_min_requests`（默认 10，0 关闭）的会话，网关不改绑、原样透传错误（含 retry-after），由客户端稍后重试原 backend。用户拍板（2026-11-17）：**缓存前缀连续性 > 池内调度**——为省一份订阅的额度而烧掉整个会话的缓存，整体上是亏的。

没有上下文的人会以为这是 bug（「网关怎么见死不救」），所以记录在案：这是刻意的，且不提供 per-会话开关。护栏在引擎层前置（keep-affinity 命中时不问 policy），policy 无从覆写。

（2026-11-18 随 affinity/rebind 词汇改版更名，原文件名 0002-long-sessions-keep-pinned-backend.md。）
