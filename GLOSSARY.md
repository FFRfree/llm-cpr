# Coding-Plan-Router

对多份 coding-plan 订阅做路由的 LLM 网关：把每个 agent 会话的推理请求发给当下最该用的那份订阅，并留下完整账本。

## Language

### 订阅与身份

**Backend**:
路由器里代表一份可路由订阅的档案；`name` 是它的唯一身份键，改 `name` 等于换身份证——历史钉死与账本都对不上。
_Avoid_: provider entry, 服务条目

**Family**:
上游服务的家族（ocg / ccg，未来 codex）；同家族订阅说同一种「方言」（会话头、余量接口、凭据来源）。
_Avoid_: provider（在 Hermes 侧另有所指）, 上游类型

**Subscription**:
用户买来的一份 coding-plan 额度；一个 backend 承载一份 subscription。
_Avoid_: account（单指账号时用 account）

**Identity（会话身份）**:
判定「这个请求属于哪个会话」的三级口径：统一会话头 → 对话指纹 → 客户端地址；身份命中映射即钉死。
_Avoid_: session key, user

### 路由决策

**Pinning（会话钉死）**:
新会话首请求选定 backend 后永久粘死，不随评分变化；唯一例外是被钉的订阅从声明中删除后自动重选。
_Avoid_: sticky, 亲和

**Monthly debit score（月欠账评分）**:
新身份的选路依据：月历进度% − 月已用%，谁落后于日历谁先获得新请求；效果是各订阅月额度均匀一起烧。
_Avoid_: least-used, 负载均衡（含义过泛）

**Quota wall（额度墙）**:
5h/周窗口撞满的状态；是候选上的标志位而非过滤条件——policy 允许选撞墙订阅（代价是透传 429/403），只有内置路径才过滤。
_Avoid_: exceeded（作过滤动词用时）

**Migration（错误迁移）**:
403/429 且短重试用尽后，把会话搬到另一可用 backend 并重钉；有冷却防抖。长会话例外不迁移（见 ADR-0002）。
_Avoid_: failover（含义过泛）

**Policy**:
用户以代码形式提供的决策层：每个请求必答「发给谁、用什么模型、迁不迁」，答不上来交给内置兜底。
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
