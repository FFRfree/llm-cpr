# 租户：key 即调用方，记账/选路分维度而非额度隔离

背景：网关此前只有一个身份概念——所有带 master key 的请求算同一个人。同一台机上的多类调用方（人工 opencode 流量、Hermes Agent 的 cron/子代理流量）在账本里混住，亲和按 identity 全局查，决策全局一套。2026-11-18 用户拍板加租户维度。

决定：**单进程内声明 `tenants[]`，Bearer 命中哪个租户的 key_env 就归属哪个租户**；不声明时隐式 `default` 租户 + master key，v0.1.0 行为逐字节不变。

- 鉴权取舍：**声明了 tenants 就不再读 master_key_env**——每个能进门的调用方都必须有显式归属，避免「忘了把 main 写进 tenants 导致 master key 仍旁路进门、账本却分不出人」的半吊子状态；主用户把 key_env: 'CPR_MASTER_KEY' 写进 main 租户即可。
- 归属取舍：**租户是记账与选路的维度，不是额度的隔离**。订阅额度是上游账号的物理属性，租户共享全池（pooling 本来就是网关的存在理由）；「每租户每天最多烧 N token」类预算是另一件事，留作后续引擎护栏。
- 亲和/冷却按 (tenant, identity_kind, identity_hash) 查询：租户间同 identity 不串粘；租户 backends 子集收缩后，池外亲和按 stale-pin 重选（与订阅下线同语义）。
- 历史兼容：旧行经 `ALTER ... NOT NULL DEFAULT 'default'` 直接落 default 租户，无需回填；`'default'` 名字保留给隐式模式，声明里禁用。

否决的替代方案：给 Hermes 跑第二个网关实例——两个进程会对同一批订阅凭据各自刷快照（违反「凭据刷新唯一负责人」），且双库双看板。只有需要硬额度隔离（各用各的订阅池）时才值得，本场景不是。
