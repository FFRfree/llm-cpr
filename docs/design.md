# Coding-Plan-Router 设计文档（规划稿 v0.2，2026-11-16）

> 状态：**规划中，未动手**。本文记录需求、架构与所有已查证的事实底座；
> 每条带「已验证 / 待拍板 / 待验证」标注。实施前须用户逐项拍板。

## 1. 用户故事（原始需求）

1. 未来有**多个 OpenCode Go（OCG）和 CommandCode GOAT（CCG）订阅**，要求在过期前
   **均匀地用满**各订阅额度（不 Early Burn 单个，也不浪费到过期）。
2. 可选模型 = **有倍率的那几个**（高 allowance 模型白名单，现口径 ≥4x，见现有
   config.yaml providers 块注释）。
3. 接入的 harness 客户端：**hermes、pi-coding-agent、oh-my-pi**（未来可扩）。
4. **Hindsight** 的模型调用也走本网关。
5. 网关是 **agent-agnostic** 的：任何 OpenAI 兼容客户端都能接。三大能力：
   - **负载均衡**：多订阅间均匀分摊（按用量/过期时间/倍率评分）；
   - **审计**：每笔请求入档（谁、哪个订阅/账号、什么模型、token 用量、cache 命中），
     按 session 纬度检查 cache miss；
   - **看板**：每个订阅各维度限额（5h/周/月）与时间进度的柱状图。

## 1b. 定位与三层结构（2026-11-16 定调，未来开源到 GitHub）

名字 **coding-plan-router**：本质是「对一堆 coding-plan 订阅做负载均衡的 LLM 路由器」，
agent-agnostic，未来发布到 GitHub（开源约束见 §9）。

```
上层  接入层（per-harness 适配，薄）
      ├─ hermes     custom provider / model-provider 插件
      ├─ pi / omp   provider 配置（自定义会话头能力待验证，M4）
      └─ hindsight  直连 OpenAI 兼容 API（无头 → 指纹身份）
中层  路由器（本仓核心，纯 Node 零依赖）
      会话钉死 → 月度欠账评分 → 模型名/凭据/会话头翻译 → 审计账本 → 看板
下层  订阅后端（多账号、多家族，可扩展）
      ├─ ocg  ×N → 转交 ocg-proxy（已有，账号级评分/钉死/账本）
      ├─ ccg  ×N → 直连 api.commandcode.ai（本层管理多账号钉死）
      └─ codex ×N（未来）→ OAuth 订阅后端，参照 hindsight-codex-proxy 的翻译模式
```

- 分层规则：**上层只做"把各家 harness 的会话约定接到统一会话头"**，不带任何路由逻辑；
  **下层只做"把统一请求翻译成该家族的方言 + 报告用量"**，不做选择；选择只在中间层。
- 家族扩展点：新增订阅家族 = 新增一个下层适配模块（base_url、凭据、余量数据源、
  模型名翻译表），路由核零改动。
- 模型白名单 = 各家族"有倍率"模型的并集，统一命名，放中层配置。

## 2. 事实底座（全部现查验证过，2026-11-16）

### 2.1 CommandCode（CCG，GOAT 套餐）

| 事实 | 来源 |
|---|---|
| Provider API：`https://api.commandcode.ai/provider/v1/chat/completions`，OpenAI 兼容；key = Provider API key | 官方 docs + 实测 200 |
| 余量三接口（非文档 `/alpha`，同一把 key）：`/alpha/billing/credits`（月度剩余美元 + 5h/周窗口 used/cap/resetAt）、`/alpha/usage/summary`（本期已花 totalCost）、`/alpha/billing/subscriptions`（周期起止） | 实测本账号 |
| 窗口为美元口径：本号实测 5h cap $14、周 $35、月池 $70（= 文档百分比 20%/50%/100% 吻合）；**cap 必须读现值，不可写死** | 实测 |
| 扣费公式（受控实验三次拟合）：**单笔扣费 = 模型标价 × (70 ÷ 该模型月度上限)**；任意模型烧满各自上限都正好烧干共享池 | 实测 |
| 计费**异步落账 2~8 秒**；轮询余额需计入延迟 | 实测 |
| 缓存读按标价 ×0.7 扣；缓存生效有延迟（1.5s 内重发不命中；真实会话流量反推 ~89% 缓存占比） | 实测 |
| **无会话头**：缓存按「账号+前缀」自动键控；响应无 x-ratelimit/cost 头，只有 x-trace-id | 代码+抓包记录+实测 |
| `GET /provider/v1/models` 带每模型 `supported_endpoints`；Claude 系 12 个只走 `/messages`，glm/gemini/deepseek 全支持 `/chat/completions` | 实测 |
| `/alpha` 是内部接口可能变：**查询失败必须降级为「余量未知」，不许崩** | 设计约束 |

### 2.2 OpenCode Go（OCG）

| 事实 | 来源 |
|---|---|
| 已有生产代理 `services/ocg-proxy`（端口 8731 转发 / 8742 管理，两号 fill_first，月度欠账评分，会话钉死，usage.db 账本）——**设计文档拍板过它不做通用多账号网关，路由核不动** | ocg-proxy docs/design.md |
| 官方每号 `/usage` 只有三窗口已用**百分比**+重置时间，无绝对美元 | ocg-proxy design.md |
| ocg-proxy 管理口有 `/api/route/status`、`/api/audit/*` 可编程查询 | ocg-proxy server.mjs |
| ocg 账本的 allowance_usd（上游 usage.opencode 块）可把 OCG 花费换算成美元 | llm-api-integration skill |

### 2.3 Hermes 侧（客户端约定）

| 事实 | 来源 |
|---|---|
| custom provider 是**纯配置**，零代码：`providers:` 条目支持 `transport`(=api_mode)、`models` 白名单、`key_env`、`session_affinity_header`、`extra_headers`、`context_length`、`capabilities` 等 | config_providers.py 已逐行验证 |
| `session_affinity_header` 是一等公民字段：按 base_url 匹配条目，Hermes 在所有 api_mode 的统一出口处自动带上会话 key（与 opencode 链路同源 `resolve_affinity_key`） | chat_completion_helpers.py:1488, opencode_affinity.py |
| **坑**：provider 换成 `custom:<路由器>` 后 `is_opencode_target()` 认不出，`x-opencode-session` 会消失——必须靠 `session_affinity_header` 配置补回 | opencode_affinity.py:97 |
| transport 是条目级的；custom provider 无 per-model 线协议；混线需两个条目（不同 base_url 前缀）。内置 provider 才有 per-model 线（ProviderProfile.api_mode_for_model） | runtime_provider.py 已验证 |
| 内置 provider 全是插件：`plugins/model-providers/<name>/`；用户插件放 `$HERMES_HOME/plugins/model-providers/<name>/` 可覆盖内置、升级不丢——**混线需求出现时的升级路径** | providers/__init__.py, plugins/model-providers/commandcode/ |

## 3. 架构总览

```
hermes ─┐
pi ─────┼─→ Sub-Router (新, 纯 Node 零依赖) ─→ 评分/钉死/翻译 ─┬→ ocg-proxy(8731, 不动) → OCG 账号池
oh-my-pi┤                                                    └→ api.commandcode.ai/provider/v1 → CCG 账号(先 1 个)
hindsight┘                                                            │
                      管理口(回环): /api/* + 看板 ←──── usage.db 账本 + 额度快照轮询(ccg /alpha + ocg admin API)
```

- 对客户端：**一个 OpenAI 兼容端点**（`POST /v1/chat/completions` 必须、`GET /v1/models`
  可选本地返回白名单）；管理口只绑回环，对外挂 SSO 与 ocg-proxy 同法。
- 对上游：改写三件套 = 模型名翻译 + Authorization 替换 + 选 CCG 时剥会话头；
  选 OCG 时网关把统一头 `x-session-id` **重写**为下游要求的 `x-opencode-session`（一个会话身份两层各用各的映射，opencode 耦合被封在网关内部）。
- 流式错误边界：**首字节前**可换订阅重试；SSE 已开始只报错（不做无声重试）。

## 4. 路由核（翻版 ocg-proxy 三条规则，推广到订阅级）【待拍板】

1. **路由身份**：统一会话头（默认 `x-session-id`）→ 对话指纹（复用 ocg-proxy fingerprint.mjs）→ 客户端地址。
   身份命中映射即钉死订阅，永不自动换（缓存优先）；换订阅 = 上游前缀缓存全烧。
2. **新身份评分**：月度欠账 `月时间进度% − 月已花%`，谁落后日历喂谁。
   - CCG：美元口径直读（剩余/已花/周期起止来自 /alpha）；
   - OCG：经 ocg-proxy admin API 取两号的进度/已用%，账本 allowance_usd 校准成美元。
   - 硬规则：候选先按「该模型是否在订阅模型表内」过滤；5h/周窗 exceeded 的订阅本轮跳过；
     全员超限时放宽（同 ocg 规则）。
3. **错误迁移**：配额类错误（429 重试穷尽 / 403）一次性迁移换订阅 + 重钉 + 每身份 1h 冷却。

**已拍板（2026-11-16）**：
- [x] 双双撞满后的兜底：**直接报错挡住**，不自动烧 CCG 充值额度 / OCG Extra usage，不做开关。
- [x] 评分口径：**百分比归一**（`月时间进度% − 月已花%`，OCG 侧本就只有百分比）。

## 5. 会话身份与各客户端接入

| 客户端 | 会话头 | 接入方式 | 状态 |
|---|---|---|---|
| hermes | `x-session-id`（config 里 `session_affinity_header` 声明；业界通用名——OpenRouter sticky routing、opencode 对非 opencode provider 的缓存亲和 PR、AWS AgentCore 均用此名；头名中立不耦合 opencode） | custom provider 条目指路由器 | 已验证可行性，配置级 |
| pi-coding-agent | 待验证（pi 对 opencode 目标原生带头；对自定义 OpenAI 兼容 provider 是否支持自定义头待查） | provider 配置指路由器 | 待验证 |
| oh-my-pi | 同 pi | 同 pi | 待验证 |
| hindsight | 无头 → 指纹身份兜底（后台一次性调用，指纹够用） | OpenAI 兼容 base_url 指路由器 | 方案级可行 |

## 6. 审计账本（照抄 ocg-proxy 模式）

- node:sqlite `usage.db`，每笔推理请求一行：
  `ts / identity / identity_kind / subscription / account / model(原始+翻译后) / path / status / ms / token四件套 / cache_observed / cache_outcome / usage_json`。
- **绝不落请求正文**；审计写失败丢行不挡转发（不变式 + 测试）。
- cache miss 口径沿用 ocg 拍板：a) 会话汇总全 miss 率；b) 逐笔「本笔命中 < 上笔 prompt × 0.6」。
- 额度快照表：每分钟拉 CCG /alpha（credits+subscriptions）与 ocg-proxy /api/route/status，
  含新鲜度与降级标记（/alpha 失败 → 余量未知态，只按错误回退路由）。

## 7. 看板

- 极简单页零框架（沿用 ocg-proxy static/dashboard.html 模式），管理口承载。
- 核心视图：**每订阅一行**，柱状图 = 5h / 周 / 月已用 vs 上限，叠加月时间进度参考线
  （「落后日历 = 该喂它」一眼可见）；CCG 显示美元余量，OCG 显示百分比+美元换算。
- 次级视图：会话列表 / 会话详情（cache 丢失事件高亮）/ 每订阅烧钱速度。

## 8. 实施阶段（每阶段独立验收，生产切换需用户点头）

- **M0 规划**（本文档；拍板未定项）
- **M1 空壳打通**：固定选一个后端的最小转发（测试端口 + 假上游冒烟），hermes 真实对话
  穿全链路，验收 = `gwk_` 头穿透到 ocg-proxy、SSE 正常、`/v1/models` 白名单可见。
- **M2 路由核**：评分 + 钉死 + 错误迁移 + 双订阅真跑（含 5h 窗跳过逻辑），node --test 全绿。
- **M3 审计 + 看板**：usage.db、快照轮询、看板三视图，Home 数据源可选接入。
- **M4 扩展**：多 CCG 账号钉死规则、pi / oh-my-pi / hindsight 接入验证、（可选）CCG Claude
  的 anthropic 线条目。

## 9. 资源与约定

- 代码目录：`/root/workspace/services/coding-plan-router/`（本仓）；纯 Node 零第三方依赖，Node ≥ 22。
- **开源意图**：未来发 GitHub。仓内保持通用（README 面向外部用户、目录/端口/家族可配），
  个人路径、真实 key、私有域名一律只放 `.env` / 本机 systemd，不进 git；看板 SSO 挂接
  作为本机部署的可选文档章节。
- 端口【已拍板 2026-11-16】：流量 **8741**、管理 **8740**（连号段紧邻 ocg-proxy 的
  8731/8742；8700-8799 无著名服务占用，已查 /etc/services 与当前监听）。
- 凭据：CCG key 放本仓 `.env`（chmod 600，不进 git）；OCG 凭据仍在 ocg-proxy，不复制。
- 开发期端口覆盖 + 假上游 e2e 冒烟，**不碰生产 8731**；正式改动单独中文 git commit。
- Hermes 侧切换（config.yaml 改 provider 指路由器）属于生产配置变更，**实施时逐次征得同意**。
