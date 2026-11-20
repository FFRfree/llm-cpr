# llm-cpr

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

**Tenant（租户）**:
一类调用方的身份键（`tenants[]` 声明的 `name`）；Bearer 命中哪个租户的 key 就归谁记账、按谁的身份亲和。是记账与选路的维度，**不是额度隔离**（订阅额度是上游账号的物理属性，租户共享全池）。不声明 tenants 时走隐式 `default` 租户。
_Avoid_: user/account（各另有所指）, workspace, 项目（不是按项目分）

**热区 / 冷区（hot/cold zone）**:
policy 声明字段按「daemon 启动时是否定型」分两层。热区（`decide`、`routing.*` 除 `snapshot_interval_ms`、`identity_header`）每请求现读，改文件即生效；冷区（`backends`/`models`/`tenants`/`capture`/`db_file`/`listen` 等）启动时已拆进鉴权表/快照轮询器/capture 构造，热换会造成「文件说了 A、进程跑着 B」的裂缝，热加载遇冷区变更整份拒绝并提示重启。清单正本在 `core/policy/reload.ts` 的 `COLD_POLICY_FIELDS`。`identity_header` 属热区但慎改：换它就是换身份口径，存量全部身份在下一次请求按新口径重新判定（一次性重绑）。
_Avoid_: 热配置/热配置项（不是「热」的字面义）, 动态配置

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

### 观察层

**Capture（正文捕获）**:
租户级 opt-in 的请求正文落库：声明 `capture: true` 的租户把发往上游前的客户端原始请求体写入独立侧库 capture.db（与账本 data.db 分库，账本查询口径不被正文连累）；未 opt-in 的租户侧库文件都不落。只捕获请求侧，响应侧未实现（response_refs 预留）。
_Avoid_: 日志正文（日志不含正文）, body logging（含糊）

**Turn（轮）**:
capture.db `turns` 表一行 = 一轮请求的正文索引：消息哈希清单（refs）+ 租户/身份/模型/字节等元数据；账本 requests 行经 `capture_id` 锚定到它，capture_id 有值但查无 turn 即降级缺行（跳过/超限/写失败），不能宣称完整。
_Avoid_: request（另指账本行）

**Content addressing（内容寻址）**:
每条消息正文按盐化 sha256 只存一份（content 表），每轮重发的系统提示与历史不重复落盘；turns 只存哈希引用，TTL 清理判引用（仍被引用的正文不删）。
_Avoid_: 去重缓存、dedup cache

**Thread（线程）/ deleg 家族**:
Hermes 对 delegate subagent 的会话身份是全家族共享一个（父会话根 id；业界四家对标同阵营）——data.db 里一个 identity 的轮次可能交错来自多个并行孩子。线程键 = 每轮 refs[1]（首条 user 消息哈希；refs[0] 是 system，兄弟间相同），孩子的 goal 全程留上下文故键恒定；压缩改写历史后键变化 = 线程分裂（预期）。轨迹页与取证链都按线程键分组，断裂判定只在线程内做，跨线程边界（boundary='thread-switch'）是切孩子、不是前缀断裂。
_Avoid_: session=agent 假设（一个身份 ≠ 一个 agent）, 子会话 id（家族不发独立会话头）

**Cache efficiency（缓存效率）**:
理想消耗 / 实际消耗 ∈ (0,1]，浪费占比 = 1 − 效率 =「中间丢缓存多付的差值」。理想（分子）：线程内每条唯一消息首现付首现价、之后每次复用付读价；实际（分母）：账本三分量加权 fresh×1 + write×1 + read×0.1（Anthropic 形状部署把 write 调 1.25）。替代传统口径（Σread/Σprompt 跨请求求和把同一前缀算 N 遍）；`/api/capture/cache-efficiency`。
_Avoid_: 命中率（作为汇总头条——只留在单请求行）

### 交付与运行

**Release**:
从 git 干净快照（git archive）产出的发布副本，独立目录 + 软链切换；运行副本永不手改。
_Avoid_: build（本项目无构建）, deploy 目录

**Dashboard（看板）**:
管理口承载的多页静态后台（v2）：概览 / 请求 / 会话 / 轨迹 / 观测五页 + 共享资产，服务端分页排序；只读，唯一写操作是刷新快照。轨迹页按 `capture_id` 直达正文拼装视图。
_Avoid_: admin UI, console, 单页 dashboard（旧形态已删）
