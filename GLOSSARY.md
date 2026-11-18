# Coding-Plan-Router

对多份 coding-plan 订阅做路由的 LLM 网关：把每个 agent 会话的推理请求发给当下最该用的那份订阅，并留下完整账本。

## Language

### 订阅与身份

**Backend**:
路由器里代表一份可路由订阅的档案；`name` 是它的唯一身份键，改 `name` 等于换身份证——历史亲和与账本都对不上。
_Avoid_: provider entry, 服务条目

**Family**:
上游服务的家族（ocg / ccg，未来 codex）；同家族订阅说同一种「方言」（会话头、余量接口、凭据来源）。
_Avoid_: provider（在 Hermes 侧另有所指）, 上游类型

**Subscription**:
用户买来的一份 coding-plan 额度；一个 backend 承载一份 subscription。
_Avoid_: account（单指账号时用 account）

**Identity（会话身份）**:
判定「这个请求属于哪个会话」的三级口径：统一会话头 → 对话指纹 → 客户端地址；身份命中亲和即粘住。
_Avoid_: session key, user

### 路由决策

**Affinity（亲和）**:
身份与订阅的持久归属：新会话首请求选定 backend 后建立（route.bind 事件），此后不随评分漂移；漂移只有三条路——亲和目标从声明下线自动改绑、撞墙改绑、policy 显式覆写。定义里钉死了「持久」，不是负载均衡语境那种带超时的软粘性（当初避开 sticky 的理由，见 ADR-0006）。
_Avoid_: pin（借走「固定依赖版本」歧义）, sticky / 会话粘性（软粘性歧义）, 钉死（旧词）

**Rebind（改绑）**:
403/429 且短重试用尽后，把会话的亲和改到另一可用 backend（route.rebind 事件）；或 policy 在健康路径显式覆写。有改绑冷却防抖（`routing.rebind_cooldown_ms`，旧键 `migration_cooldown_ms` 兼容）。长会话例外不改绑（见 ADR-0002）。
_Avoid_: migration / 迁移（旧词，且「搬家」带自造味）, failover（临时切换歧义）, fallback（临时代替歧义：改绑是永久换归属，不回主路）

**Keep-affinity（长会话保亲和）**:
请求轮数 ≥ 阈值的会话撞墙时不改绑，错误原样透传——换后端会作废上游 prompt cache（见 ADR-0002）。
_Avoid_: sticky-long（旧词）

**Monthly debit score（月欠账评分）**:
新身份的选路依据：月历进度% − 月已用%，谁落后于日历谁先获得新请求；效果是各订阅月额度均匀一起烧。
_Avoid_: least-used, 负载均衡（含义过泛）

**Quota wall（额度墙）**:
5h/周窗口撞满的状态；是候选上的标志位而非过滤条件——policy 允许选撞墙订阅（代价是透传 429/403），只有内置路径才过滤。
_Avoid_: exceeded（作过滤动词用时）

**System events（系统事件账）**:
`data.db` 里的 `system_events` 表：网关每次自主动作一行（route.bind / route.rebind / route.hold / policy.error，kind 开放枚举）。亲和状态没有独立的状态表——当前亲和 = 每身份最新一条 bind/rebind 事件，改绑次数与冷却都从事件流派生。
_Avoid_: 状态表、routing_note（已随双表模型退役）

**Policy**:
用户以代码形式提供的决策层：每个请求必答「发给谁、用什么模型、改不改绑」，答不上来交给内置兜底；想解释就带 `reason`（随事件落库）。
_Avoid_: config（配置文件形态已退役，见 ADR-0001）

**Snapshot（额度快照）**:
定期向各家上游拉取的余量读数；拉取失败或过期一律标「未知」，不假装有数。
_Avoid_: cache

### 交付与运行

**Release**:
从 git 干净快照（git archive）产出的发布副本，独立目录 + 软链切换；运行副本永不手改。
_Avoid_: build（本项目无构建）, deploy 目录

**Dashboard（看板）**:
管理口承载的单文件静态页：每订阅一行额度柱状图 + 账本查询；只读，唯一写操作是刷新快照。
_Avoid_: admin UI, console
