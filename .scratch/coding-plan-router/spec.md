# Spec: coding-plan-router（对多个 coding-plan 订阅做负载均衡的 LLM 路由网关）

**Status:** ready-for-agent
**日期:** 2026-11-16
**事实底座:** 仓库设计文档（docs/design.md，含全部已验证的上游接口事实与已拍板决策）

## Problem Statement

用户手上有多份 coding-plan 订阅（OpenCode Go、CommandCode GOAT，未来更多），每份
订阅都有按时间过期的额度（月池、5 小时/每周滚动窗）。今天的现实是：每家订阅各自
为政——Hermes 里每个 provider 直连一个订阅，OpenCode Go 的两个号有 ocg-proxy 管，
CommandCode 单号直连；选哪个模型就要手动选哪个 provider，没人盯着"谁的额度快过期
了该喂谁"。结果是：有的订阅烧到顶、有的订阅白白过期浪费，用户还要在多个客户端
（hermes / pi / oh-my-pi / hindsight）里分别配置、分别记账、分别看用量。

## Solution

一个 agent-agnostic 的本地 LLM 路由网关：所有客户端指向同一个 OpenAI 兼容端点，
用一份统一的模型白名单选模型；网关在"订阅"这一层做会话钉死的负载均衡——新会话按
月度欠账评分（月时间进度% − 月已花%）喂给最落后日历的订阅，会话期间钉死不换（保住
上游前缀缓存），配额类错误才一次性迁移。下层对接 OpenCode Go（转交现有 ocg-proxy）
和 CommandCode（直连官方 API）；网关自带每笔请求的审计账本（含按会话的 cache miss
口径）和一个看板（每个订阅 5h/周/月限额 vs 时间进度的柱状图）。

## User Stories

1. As a harness 用户（hermes/pi/oh-my-pi），I want 一份统一的模型白名单里选模型，so that 我不用关心这个模型背后是哪家订阅。
2. As a harness 用户，I want 会话期间请求始终落在同一个订阅上，so that 上游前缀缓存不失效、响应更快更便宜。
3. As a harness 用户，I want 新会话自动被喂给"再不用就要过期"的订阅，so that 每份订阅的钱都在过期前被用满。
4. As a harness 用户，I want 当前选中的订阅撞配额时自动换到另一个订阅重试，so that 我的对话不因单家订阅撞顶而中断。
5. As a harness 用户，I want 所有订阅都撞满时收到明确的报错而不是悄悄烧充值额度，so that 真金白银的消费永远由我显式决定。
6. As a hermes 用户，I want 只改一次 provider 配置就能把全部对话流量切到网关，so that 迁移成本是一次性的。
7. As a hindsight（后台模型调用），I want 直接把 OpenAI 兼容 base_url 指向网关就能用，so that 无会话头的后台调用也能被正确路由与记账。
8. As a 网关运维者，I want 每笔请求有账本记录（时间/身份/订阅/账号/模型/状态/token 用量/cache 命中），so that 我能回答"这个月谁烧了多少、哪笔丢了缓存"。
9. As a 网关运维者，I want 按会话维度看 cache miss 汇总和逐笔丢失事件，so that 我能定位"换订阅/换号/前缀变动"导致的缓存损失。
10. As a 网关运维者，I want 看板上一眼看到每个订阅 5h/周/月三个窗口的已用 vs 上限柱状图并叠加月时间进度参考线，so that 谁在浪费、谁被喂多了当场可见。
11. As a 网关运维者，I want 账本绝不落请求正文、审计写失败只丢行不挡转发，so that 隐私与可用性都不会被可观测性拖累。
12. As a 网关运维者，I want CommandCode 计费接口失败时网关降级为"余量未知"继续转发，so that 上游内部接口变动不会打断我的对话。
13. As a 网关运维者，I want 凭据只存在本机 .env、代码仓可开源，so that 未来发布 GitHub 不需要先做秘密大扫除。
14. As a 网关运维者，I want 新增一个订阅家族（如未来的 Codex）只需加一个下层适配模块，so that 路由核与上层接入不用改。
15. As a 网关运维者，I want OCG 家族继续复用现有 ocg-proxy 的账号评分/钉死/账本，so that 已验收的生产件不被重复造轮子。
16. As a 未来开源用户，I want 端口/家族/账号全部走配置文件，so that 我的部署跟作者的不一样也能跑。
17. As a harness 用户，I want 管理口只绑回环、流量口带 master key 鉴权，so that 网关挂上公网 SSO 之前不裸奔。

## Implementation Decisions

**架构分层（定调）**
- 三层：上层 per-harness 接入（薄，只负责把各家 harness 的会话约定接到统一会话头）→
  中层路由器（选择逻辑只允许住在这层）→ 下层订阅后端适配（只翻译方言 + 报告用量）。
- 新增订阅家族 = 新增下层适配模块（base_url、凭据、余量数据源、模型名翻译表），路由核零改动。

**路由核（三条，翻版 ocg-proxy 定案推广到订阅级）**
1. 路由身份三级兜底：统一会话头 → 对话指纹（system+首条 user 哈希，仅 chat/completions）→
   客户端地址。身份命中映射即钉死订阅，永不自动换。
2. 新身份按月度欠账评分选订阅：`月时间进度% − 月已花%`，百分比归一（已拍板）。候选先按
   "该模型在订阅模型表内"过滤；5h/周窗已满的订阅跳过；全员超限时放宽（唯一硬规则是
   月度耗尽的排最后，全员耗尽才用最佳者）。
3. 配额类错误（429 重试穷尽 / 403）一次性迁移换订阅 + 重钉 + 每身份 1 小时冷却。
   迁移硬边界：首字节前可换订阅重试；SSE 已开始只报错，不做无声重试。

**兜底（已拍板）**：所有订阅都满 → 直接报错挡住，不自动烧 CCG 充值额度 / OCG Extra usage，不做开关。

**客户端契约**
- 暴露 `POST /v1/chat/completions`（标准 OpenAI Chat Completions 方言，支持流式）与
  `GET /v1/models`（本地返回统一白名单目录，不透传上游）。
- 请求改写三件套：模型名翻译（统一名 → 家族本地名，如 commandcode 的 org 前缀写法）、
  Authorization 替换为所选后端凭据、选 CCG 时剥掉统一会话头、选 OCG 时原样透传
  `x-opencode-session`（一个头两层各用各的映射：中层钉订阅、ocg-proxy 钉账号）。
- 鉴权：流量口 master key（`Authorization: Bearer`）；管理口只绑回环。

**额度数据源（家族适配）**
- CCG：轮询 `/alpha/billing/credits`（月度剩余美元 + 5h/周窗口 used/cap/resetAt）、
  `/alpha/usage/summary`（本期已花）、`/alpha/billing/subscriptions`（周期起止）。
  已验证事实：窗口为美元口径且 cap 必须读现值；扣费 = 模型标价 × (池总额 ÷ 该模型月上限)；
  计费异步落账 2~8 秒，快照必须带新鲜度标记；/alpha 失败 → 余量未知态，只按错误回退路由。
- OCG：经 ocg-proxy 管理口 API 取每号进度/已用百分比与账本美元换算；凭据不复制。
- 快照轮询约每分钟一次，带新鲜度与降级标记。

**审计账本**
- node:sqlite，每笔推理请求一行：ts / identity / identity_kind / subscription / account /
  model(原始+翻译后) / path / status / 耗时 / token 四件套 / cache 观测字段 / 上游 usage 原文。
- cache miss 口径沿用已拍板口径：a) 会话汇总全 miss 率；b) 逐笔"本笔命中 < 上笔 prompt × 0.6"。
- 绝不落请求正文；审计写失败丢行不挡转发（有测试的不变式）。

**看板**
- 极简单页零框架，管理口承载；核心视图 = 每订阅一行，柱状图 5h/周/月已用 vs 上限 +
  月时间进度参考线；次级视图 = 会话列表 / 会话详情（丢失事件高亮）/ 每订阅烧钱速度。
- 本机部署可选经现有 SSO 网关挂出（作为部署文档章节，非代码）。

**工程形态**
- 纯 Node 零第三方依赖（node:sqlite 内置），Node ≥ 22；进程双端口：流量 8741、管理 8740（已拍板）。
- 配置文件：家族/账号/端口/白名单可配；真 key 只在 `.env`（chmod 600，不进 git）。
- 目标开源：仓内通用化，个人路径与域名不进 git。

## Testing Decisions

**好测试的标准**：只测外部可见行为（HTTP 响应、落库行、路由选择结果），不测内部
实现细节；任何重构不应改测试。

**Seam 1（主力，HTTP 边界）**：对路由器的流量口发真实 HTTP 请求，上游全部用假件——
假 ocg-proxy（可编程 SSE/错误/usage）+ 假 commandcode（可编程 /provider/v1 与
/alpha 计费响应）。断言全部从客户端视角：路由落点、模型名翻译、会话头透传/剥除、
SSE 完整性、错误迁移、全员撞满时挡住。先例：ocg-proxy 的假上游 e2e 冒烟。

**Seam 2（纯函数）**：月度欠账评分、模型名翻译、身份解析做成无副作用纯模块，
`node --test` 直测。继承 ocg-proxy 的规矩：评分与它的只读 preview 同源判断，
改评分必须同批改测试。

**不变式测试**：审计写失败丢行不挡转发；正文永不落账本；/alpha 降级路径。

**人工验收**：真 hermes 穿链路（真凭据）作为工单 acceptance criterion，不进自动化测试。

## Out of Scope

- pi / oh-my-pi 的接入验证与自定义会话头能力确认（独立后续工单）。
- 多 CCG 账号的账号级钉死规则（首版 CCG 单账号直连；多账号另立工单批）。
- Codex 订阅家族下层适配（未来）。
- CCG Claude 系模型的 anthropic_messages 线（另开 provider 条目的扩展点，首版不做）。
- Hermes config.yaml 切换到网关（生产变更，实施时单独征得用户同意，不属于本 spec 的代码范围）。
- Home 数据源接入看板（可选后续）。

## Further Notes

- 上游接口的全部实测数字（字段名、cap 现值、扣费公式、异步落账延迟、缓存行为）以仓库
  设计文档为准，本 spec 只收录影响施工的结论。
- 生产边界规矩与 ocg-proxy 同源：不碰生产端口、端口覆盖 + 假上游冒烟、正式改动单独
  中文 git commit。
