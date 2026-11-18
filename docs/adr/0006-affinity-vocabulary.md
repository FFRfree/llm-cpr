# 术语改版：affinity / rebind 取代 pin / migration

背景：本仓早期的两个核心路由概念叫「会话钉死（pin）」和「错误迁移（migration）」。两者都不是业界标准词：pin 在开发者语感里首先是「固定依赖版本」，migration 带自造味且与 fallback/failover 拉扯不清。2026-11-18 用户拍板改版。

决定：**关系叫 Affinity（亲和），动作叫 bind / rebind（绑定 / 改绑）**。

- Affinity 承接 Pinning：身份↔订阅的持久归属。当初 GLOSSARY 避开 sticky/亲和 的理由是「软粘性」歧义——本定义用「持久归属、漂移只有三条路」把「永久」钉死；Linux CPU affinity 的先例也支持 affinity 表达明确的持久归属。
- Rebind 承接 Migration：改的是归属本身（永久换钉），不是 fallback 那种临时退路（下一请求回主路），也不是 failover 那种故障时临时切换。fallback/failover 都进 avoid 列表。
- 长会话护栏 sticky-long → keep-affinity。
- 公开契约同步：`migration_cooldown_ms` → `rebind_cooldown_ms`、`ctx.session.pin` → `ctx.session.affinity`（旧名各留一版兼容）；`Decision` 增加可选 `reason`——policy 用自己的话解释决定，随事件落库，取代引擎贴标签的 `decided_by` 概念（谁决定的没意义，为什么才有意义；来源只剩 `source: policy|builtin` 一个词，回答「是不是我的规则在生效」）。

后果与代价：账本历史行的旧注记（`builtin:migrate->` 等）原样保留、新旧并存，复盘时都要认得；外部用户（v0.1.0）的 policy/routing 旧键在过渡期继续可读。
