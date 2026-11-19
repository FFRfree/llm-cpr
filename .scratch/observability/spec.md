# 观测层（Observability）：正文落库 + 四类分析

2026-11-19 与用户对话中拍板方向（设计稿先文字过，想法期落稿，未实现）。
想法源稿：`/root/ffr-scratch/2026-11-19-cpr-analysis-layer/ideas.md`（本 spec 自包含，可独立阅读）。

## 动机

CPR 的正名是 router，价值全在「每个请求发给谁」——这是第一身份。但它站在 agent 与 LLM
中间，每个请求正文都要过手（本来就要 parse+stringify 改模型名），天然是全系统唯一的观察点。
2026-11-19 用户拍板：语义走向 **LLM gateway**——「gateway」在业界是类别词（位置+完整职责：
转发/记账/日志/审计），router 只是其中「决策」半边。完整定位：

> llm-cpr = 自托管 LLM gateway：订阅路由（发给谁/affinity/额度调度）+ 审计观测
> （记录/账本/看板/正文落库），两半共用同一条过路流量，互不附属。

记录 = **原料**。消费有两种：给人看（审计/展示，接看板）与给策略测（回放）。
存储按「原料」设计，别被看板需求牵着做歪。

类别先例：Langfuse/LangSmith/Helicone 纯观测产品靠 SDK/旁路接入，拿不到未经它的流量；
LiteLLM/Cloudflare AI Gateway 有流量但记录浅。CPR inline+零依赖+记录/路由同进程，
是类别里稀缺组合（对 v0.2.0 公开形态是卖点：本地观察自己 agent 流量，数据不出本机）。

## 已拍板的框架（实现前先读，别推翻）

- **默认不落库，opt-in 按租户**：接 tenants 模型（ADR-0007），租户声明里加开关。
  响应侧粒度（会话级白名单）是开放问题，见下。
- **正文不进 data.db**：独立存储（侧库或独立文件），别连累账本查询性能
  （看板口径 63ms/50 万行不能被正文库连累）。
- **内容寻址存储**：每条消息按哈希（如 sha256）存一份，请求只存「本轮=哈希 h1..hN」
  引用列表；查看时拿哈希捞回拼装，还原与完整落库相同。正文高度重复（系统提示+历史每轮
  重发），可砍 90%+ 体积；跨会话的 AGENTS.md/系统提示同样去重。代价：拼装查询 +
  TTL 清理要判哈希引用计数。50 轮会话普通存法 1275 条消息，引用法 50 条正文+50 行清单。
- **保留期 TTL**：默认短（如 14 天，跟 ffr-scratch 老化思路一致）；超限跳过
  （如 >N MB 的请求不落）。
- **第一版只落请求侧**。响应侧是已知坑：SSE 流不能无限攒内存
  （`usageCollector` 的有界丢弃线是既有纪律先例），有界缓冲的成本另票评估。
- **热路径预算**：请求侧已在 parse（~1.5ms/MB 实测口径），捕获≈免费；写盘走异步队列，
  内存有界。泄漏扫描（若做，见票 04）是唯一允许在线的正则类开销，控制在 parse 同量级。
- **协议归一化必做**：四家协议「一条消息」形状各异，需内部统一 item 模型 + 每协议一个
  转换器——与既有「客户端协议与订阅家族分别建模」方向顺路（协议模块式工作量）。
  第一版只做 **chat-completions**（`core/protocols/` 唯一在用协议），其余协议有订阅再补。
- **router 是第一身份**：路由核心职责、缓存连续性（keep-affinity）、订阅额度调度不许让位。
- 名字拍板（2026-11-19）：**llm-cpr 封箱，不再讨论换名**，名字不随语义演化。

## 四类分析（= 票 02-05，按用户点名的价值排序）

1. **策略回放测试**（票 02，最大单项收益，甚至大于分析本身）：真实正文攒起来后，
   decide 策略改动可离线回放——过去 N 天几千个真实请求灌给新 policy 跑，对比路由决策
   分布/改绑频率/撞墙处理。等于给路由层造「变更前沙盘」，替代假上游+脑测。
2. **缓存取证**（票 03）：相邻两轮请求逐条消息算哈希，前缀哪条先变 → 缓存断点根因
   （agent 改 system prompt / 客户端插消息 / 改绑换上游）。现行 chars 增量比只能猜。
   注意：内容寻址的引用列表本身就是逐条对比材料，此项大部分是 01 的白送能力。
3. **泄漏取证**（票 04）：agent 天天读代码库，.env/token 会被吸进上下文发给订阅上游，
   全系统只有 CPR 这个中间人能查。扫描可以、落内容不行：命中只在 system_events 落
   `privacy.hit` 事件（类型+位置哈希+轮次），绝不落原文。有正文后从「报警」升级为
   「定位」（哪一轮、读哪个文件吸进来的），误报可复核。
4. **工具/skill 分析**（票 05）：assistant 的 tool_use/tool_calls 在正文里，可精确统计
   每个 skill/工具的调用次数、报错率、**灌 token 排行**（工具结果是上下文大头）。
   不再需要 Hermes 加标记头。

## 协议调查要点（决定解析器形状，2026-11-19 官方文档现查）

CPR 现状：`core/protocols/` 只有 `chat-completions.ts`（OpenAI 兼容），CCG/OCG 均为此方言。

1. **OpenAI Chat Completions**（`/v1/chat/completions`，行业普通话，覆盖率最大）：
   `messages[]` 一轮一条，role: developer/system、user、assistant、tool（工具结果独立成条，
   带 `tool_call_id` 回指）。content 为字符串或 parts 数组（text/image_url/input_audio/file）。
   工具调用在 assistant 的 `tool_calls`。文档出现 `prompt_cache_breakpoint`（可显式标
   缓存断点）——缓存分析可用线索。来源 `developers.openai.com/api/reference/resources/chat`。
2. **OpenAI Responses**（`/v1/responses`，有状态）：input 可为完整 item 列表或
   「新话+previous_response_id」（历史在服务端）。item 类型 message/function_call/
   function_call_output/reasoning（store:false 时仅 `encrypted_content`，拿不到明文）。
   **刺头：body 可能几乎不含历史，轨迹拼装必须配响应捕获**。
   来源 `developers.openai.com/api/reference/resources/responses/methods/create`。
3. **Anthropic Messages**（`/v1/messages`）：system 是 body 顶层字段（非消息）、max_tokens
   必填、user/assistant 严格交替。content 块 text/image/document(PDF)/tool_use/tool_result/
   thinking(+signature 须原样回传)。缓存线索最富：`cache_control` 显式标块或顶层自动。
   来源 `platform.claude.com/docs/en/api/messages` + prompt-caching 指南。
4. **Google Gemini**（`models/{model}:generateContent`）：contents[] role 仅 user/model，
   parts：text/inlineData（base64 裸媒体，单 part 上限 256MB——落库体积头号怪物）/
   fileData(URI)/functionCall/functionResponse/thought。系统提示在顶层 `systemInstruction`。
   来源 `ai.google.dev/api/generate-content`。

两条硬结论：① 协议归一化层必做（见已拍板框架）；② 有状态协议破坏「body 含全史」假设
→ 响应侧捕获早晚要做。

## 隐私残余风险（用户知情项，需用户点头才默认开）

数据在用户自己 VPS 上，但落盘=多了可被翻的磁盘面（备份、磁盘到手、未来误公开）。
对策：opt-in 默认关 + 短 TTL + 超限跳过。**默认值是什么（尤其对外发布版本）要用户拍板。**

## 开放问题（实现前找用户拍板或自行探索后给方案）

1. opt-in 粒度：租户级够不够？要不要会话级（按 x-session-id 白名单）？
2. 响应侧落不落、怎么落（有界缓冲的成本 vs Responses 协议轨迹拼不全的代价）？
3. 回放测试形态：独立 CLI（`cpr replay`？）还是管理口功能？
4. 泄漏规则库：对齐 gitleaks 那套格式还是自维护最小集？
5. 内部 item 模型粒度：统一 消息/工具调用/工具结果/缓存线索 四类实体够不够？
6. 观测层要不要走「配置即代码」声明（开哪些分析、阈值写在 policy/mine.ts）？倾向要。

## 交付面（粗粒度，实现 agent 自行细化）

- `core/` 新增观测存储模块（侧库建库/内容寻址写入/TTL 清理/异步队列）；
  存储布局迁移遵循「加法迁移」纪律与 `core/store/migrate.ts` 套路。
- `core/protocols/` 归一化层：统一 item 模型 + chat-completions 转换器。
- 管理口报表端点 + 看板页面（读侧聚合，按需报表，不加重热路径）。
- 测试：本机假上游覆盖捕获/去重/TTL/超限跳过；泄漏扫描的误报/白名单用例；
  回放 harness 用录制的假流量。e2e 不做常驻套件（用户拍板过的纪律）。
- 部署属生产改动，逐次授权；发布按 npm 形态纪律（tag → npm pack 冒烟 → publish）。
