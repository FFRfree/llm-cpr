# Policy 用户指南：怎么写自己的路由策略

> 本指南是 policy 编写的基准文档；契约正本 = `lib/policy/contract.ts`（类型以它为准）。
> 标注约定：**【现状】** = 已上线运行的行为；**【已定稿待实现】** = 已实现于工作树（2026-11-18，全量测试通过）、随下次 release 生效——当前生产 release 仍是旧契约（ctx 带 requests/degraded 占位字段、无 error 标记与 recent、无 routing 三参数）。

## 1. Policy 是什么

你的策略就是一个 TS 类，住在 `/root/ffr-projects/coding-plan-router/lib/policy/mine.ts`。它由两部分组成：

- **声明区**（backends/models/listen/routing…）：网关的静态配置，等价于旧 config.json。
- **策略区**：唯一一个钩子 `decide(ctx)`。引擎在每个请求的选路点调用它，它回答「这次发给谁」；它不回答的部分由**内置逻辑**兜底（月欠账评分选新会话 / 长会话保缓存不迁移 / 尊重钉死）。

配置即代码：**改策略 = 改代码 = 发 release**，没有热重载按钮。`backends[].name` 是身份键（钉死表和账本都存它），**绝不改 name**；`alias` 只是显示名，可随便改且可能撞名，凡需要唯一标识订阅的地方一律用 `name`。

**一个核心边界，全指南建立在这句话上**：decide 回答两个决策点——**正常路由**（每个请求一次）和**迁移决策**（撞墙、原地重试烧尽后问一次，ctx 带 `error` 标记）。但出错的**机械动作**（原地重试、长会话保缓存、迁移冷却）全部引擎自治，policy 碰不到。【契约形态已定稿待实现；现状是 ctx 里多 `requests`/`degraded` 占位字段、无 `error` 标记，落地后以本节为准】

## 2. decide 契约【ctx 字段形态已定稿待实现；决策语义为现状】

**调用时机**：每个 `/v1/chat/completions` 请求的选路点必问一次——新会话、老会话、被钉死的会话，都问。

```ts
decide?(ctx: {
  now: number;                                    // 本次决策时刻（毫秒时间戳）
  request: {
    model: string;                                // 客户端请求的模型 id（models[].id 口径）
    chars: number;                                // 整个请求体 JSON 的字节数（≈上下文大小，不是 token 数）
    messages: number;                             // messages 数组的条数（精确值，≈轮数×2+system）
  };
  session: { pin?: string };                      // 上一次路由到的后端（钉死订阅 name）；新会话 undefined
  candidates: CandidateView[];                    // 候选列表（已按「支持该模型」过滤）
  error?: {                                       // 【已定稿待实现】仅迁移决策点出现，正常路由时没有：
    backend: string;                              //   刚吃 403/429 的后端（== session.pin）
    status: number;                               //   403 或 429 —— 可区分对待
    retryAfterMs: number | null;
  };
}) : { backend: string; model?: string } | 'keep' | null;

interface CandidateView {
  name: string;                                   // 身份键
  family: 'ocg' | 'ccg';                          // 订阅家族
  alias?: string;                                 // 显示名，可能撞名，别当标识用
  priority: number;
  walled: boolean;                                // 5h/周窗口是否撞满（快照过期/未知不算撞满）
  snapshot?: QuotaSnapshot;                       // undefined = 额度未知（不是没额度！）
  recent?: {                                      // 【已定稿待实现】后端近期健康（内存态，重启归 undefined）
    fails: number;                                //   最近 10 分钟失败笔数（全 identity 聚合，499 不计）
    lastStatus?: number;                          //   最近一次失败的状态码
    lastErrorAt?: number;                         //   最近一次失败的时间戳
  };                                              //   undefined = 窗口内没观察到失败（≠ 保证健康）
}
```

字段解读的铁律：

- `chars` 是**字节不是 token**：代码/英文约 3.5~4 字符/token，中文约 1.5~2。300k token 的代码上下文 ≈ 1MB 请求体。
- `messages` 是本次请求里打包的消息条数（agent 每轮全量重发历史，所以它随会话线性涨，可当「聊到第几轮」的代理指标）。
- `snapshot === undefined` 是「未知」，不能当「没额度」用。
- `walled` 和 `recent` 各管一摊【recent 已定稿待实现】：`walled`/`snapshot` 回答「**额度**还有没有」（厂商账本，每账号一份）；`recent` 回答「**服务质量**行不行」（5xx/超时/流断/网络错误，全 identity 聚合）。403/429 也计入 `recent.fails`，读的时候要结合 `walled`：fails 高且全是 429 → 额度问题；lastStatus 是 502/504 → 这个号的服务真在出问题。
- `recent === undefined` 和 `snapshot === undefined` 同一个哲学：**观察不到 ≠ 事情没发生**——引擎刚重启、流量稀疏、失败在窗口外都会是 undefined，别当健康保证。
- `walled` 只是**标志位不是过滤器**：你可以故意选撞墙的订阅（代价是原样吃 429/403 透传），但返 null 走内置时，内置会过滤撞墙者。
- 正常路由时引擎不查库，ctx 里没有「上一笔耗时/上一笔状态码」这类历史信息；错几次、要不要迁，都归引擎的护栏管。迁移决策点你只能拿到 `error` 标记（刚失败的是谁、什么状态码）和候选们的 `recent`，别指望更多。

**返回值三态**（两个决策点通用，错误路径语义有差别）：

| 返回 | 正常路由 | 迁移决策（ctx.error 有值） |
|---|---|---|
| `null` | 内置兜底（月欠账/钉死/长会话护栏） | 迁移目标交内置（备选排序→探活） |
| `{ backend }` | 指定订阅/逐请求覆写 | **迁到该订阅**（引擎校验候选+探活）；等于刚失败的那个 = 按 keep 处理 |
| `{ backend, model }` | 连实际模型一起覆盖 | 同上，迁移时也可换模型 |
| `'keep'` | 维持钉死（新会话无效） | 不迁，原错误透传给 agent（请求结束，agent 重试形成下一次） |

## 3. 出错时引擎做什么（机械动作引擎自治，目标选择归 decide）【现状；数值参数化与 error 标记已定稿待实现】

上游回 403/429 时引擎按固定流程自治：

1. **原地短重试（policy 不可见）**：retry-after ≤ 2s【参数化后 `routing.wall_retry_max_after_ms`，默认 2000】时原地等、重试，最多 3 次【参数化后 `routing.wall_retry_max_attempts`，默认 3；0 = 关闭，第一次撞墙直接进下一步】。
2. **迁移决策点**：先过两道护栏，都不命中才问 decide（ctx 带 `error` 标记）——
   - **迁移冷却中**【参数化后 `routing.migration_cooldown_ms`，默认 1 小时】→ 不问 policy，错误透传；
   - **长会话 sticky-long**（累计 ≥10 轮【`routing.long_session_min_requests`】或账本读不出）→ 不问 policy，keep 透传——保上游 prompt cache，policy 无法覆写（这是护栏，不是策略）；
   - 都不命中 → 问 decide。返回 `'keep'` = 不迁；`{backend}` = 迁到指定订阅；`null` = 内置挑（按月欠账排序排除刚失败的、过滤撞墙的、逐个探活）。

**迁移频率的完整口径**：单请求内自动迁移 ≤1 次（迁移即入冷却）；冷却窗口内自动迁移 ≤1 次；长会话自动迁移 = 0；唯一不受窗口限制的是**正常路径 decide 的覆写**（见例 3），但每次覆写成功都会**刷新冷却计时**——那是逃生口，别写成高频动作。

## 4. 硬护栏（引擎级，policy 碰不到也绕不过）

1. **纯同步本地计算**：不许 `fetch`、不许查库、不许长循环。抛错或返回非法 → 该次决定作废、回落内置、日志告警，请求不受影响。
2. **候选/模型校验**：返回野名字或缺模型映射的目标一律判非法回落内置。
3. **同一次请求内最多一跳**：迁移后同请求再撞墙只透传，不重复决策。
4. **流首字节后不重放**：已经开始向客户端转发流式内容后，上游断流只能透传，不能悄悄重试（重放会导致内容重复/工具调用错乱）。403/429 都发生在首字节之前，所以迁移决策永远在安全窗口内。
5. **每次迁移/覆写成功都会刷新冷却计时**——频繁覆写等于反复重置防抖窗口。

## 5. 陷阱清单

- **`'keep'` 不是重试**：正常路径它是「维持钉死」；policy 层没有「sleep 后原地重试」这个动作——原地重试是引擎的事。
- **逃生口有节奏**：覆写成功即 migrate + 刷新冷却，写逻辑时要控制频率（比如只在 `walled` 明确为 true 时出手，别在快照边界抖动）。
- **长会话保缓存是内置自动的**：你不需要也不能在 decide 里替错误路径操心这件事；`long_session_min_requests` 参数在 `routing` 块调。
- **`alias` 不是标识**：两个订阅可能同 alias，路由规则、对账一律用 `name`。

## 6. 常见写法（mine.ts 形态）

**例 1：按模型钉死某订阅，其余交内置**（`candidates.find` 摸底防野名字）：

```ts
decide(ctx) {
  if (ctx.request.model === 'kimi-k2.7-code') {
    const t = ctx.candidates.find((c) => c.name === 'ccg-main');
    if (t) return { backend: t.name };
  }
  return null;
}
```

**例 2：大上下文专走指定订阅**：

```ts
decide(ctx) {
  if (ctx.request.chars > 200_000) {
    const t = ctx.candidates.find((c) => c.name === 'ocg-gmail');
    if (t) return { backend: t.name };
  }
  return null;
}
```

**例 3：逃生口——长会话被困在撞墙号上的解药**（decide 影响错误结果的唯一正规通道；覆写成功会刷新冷却）。注意定位：短会话/新会话**不需要**它——返 null 时「真撞墙→引擎原地重试→内置自动迁」会在同一请求内自动发生，而且滚动窗口经常自己清掉 walled，主动切反而可能在快照滞后/窗口自愈时白白废掉缓存。它的真实价值在**长会话**：sticky-long 护栏拒迁后，会话会被钉在撞墙号上每笔都失败、直到窗口自然清空（可能几小时），覆写逃生是用「缓存重建一次」换「立刻能用」：

```ts
decide(ctx) {
  const here = ctx.session.pin && ctx.candidates.find((c) => c.name === ctx.session.pin);
  if (here?.walled) {
    const alt = ctx.candidates.find((c) => !c.walled);
    if (alt) return { backend: alt.name };
  }
  return null;
}
```

**例 4：连实际模型一起换**（家族模型名不同，client 用统一 id）：

```ts
decide(ctx) {
  if (ctx.request.model === 'hy4') {
    const t = ctx.candidates.find((c) => c.name === 'ccg-main');
    if (t) return { backend: t.name, model: 'hy4' };  // models[].id 口径
  }
  return null;
}
```

**例 5：新会话自选、老会话不干预**：

```ts
decide(ctx) {
  if (!ctx.session.pin) {
    const best = ctx.candidates.find((c) => !c.walled && c.recent === undefined);
    if (best) return { backend: best.name };      // 额度没撞墙、最近也没在报错的号优先
  }
  return null;  // 已钉死的会话维持现状
}
```

**例 6：迁移时避开最近在报错的号**【依赖 recent 落地】：

```ts
decide(ctx) {
  if (!ctx.error) return null;                    // 正常路由交内置
  if (ctx.error.status === 403) return 'keep';    // 权限/耗尽，重试无意义
  // 429：迁到没撞墙、且最近没在报 5xx 的号；没有就交内置兜底
  const alt = ctx.candidates.find((c) =>
    c.name !== ctx.error!.backend && !c.walled && (c.recent === undefined || c.recent.lastStatus === undefined || c.recent.lastStatus < 500));
  return alt ? { backend: alt.name } : null;
}
```

## 7. 改动纪律

- 改 `mine.ts` 前先看 `git status`，别覆盖并行改动；改完在仓库根跑 `node --test` 与 `npm run typecheck`。
- 生产生效要走 release 部署流程（须用户逐次授权，停服会中断在途请求）；验证用 `scripts/xdg-deploy/smoke-release.ts` 的假上游冒烟，不烧真额度。
- 钉死模型 + 撞墙不迁 = 真·不回退（TCP 挂 → 503、撞墙 → 429 原样透传），这是诚实行为，引擎不会偷偷软化成「尽量固定」。
