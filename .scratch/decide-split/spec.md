# Spec: decide 拆双钩子（decide / decideOnError 分阶段契约）

**Status:** superseded（2026-11-18 用户拍板改走单钩子形态，见 `.scratch/decide-simplify/spec.md`；本 spec 的 routing 三参数与「长会话 footgun」原则被新 spec 继承，decideOnError/attempt/tried/ladder 部分废弃）
**日期:** 2026-11-18
**出处:** 用户讨论（本会话）；承接 `references/selection-hook-design.md` 的「选人与迁移分开、各自独立回退」原则，落地为配置即代码时代的形态（hook_file/mtime 热更新机制已随 inline-policy 退役，不搬）。

## Problem Statement

现行契约只有一个 `decide(ctx)`，正常选路与 403/429 迁移决策共用，policy 靠 `ctx.error` 是否存在自己判断阶段；`session.requests/degraded` 在正常路径永远是占位假值（引擎不做每请求查库），类型上是一个大杂烩 union。两个决策点的语义本不相同——正常路径问「发给谁」，错误路径问「迁不迁、迁去谁」——合在一个方法里既容易误判阶段，也让正常路径的 ctx 携带了无意义字段。

## Solution

### 契约（lib/policy/contract.ts）

```ts
// 正常路径 ctx：每个 /v1/chat/completions 请求的选路决策点，必问一次。
// requests/degraded/error/active 移出正常路径（引擎正常路径不查库，它们本来就只是占位）。
export interface DecisionCtx {
  now: number;
  request: { model: string; chars: number; messages: number };
  session: { pin?: string };            // 新会话 undefined
  candidates: CandidateView[];          // 已按模型支持过滤；walled 是标志位不是过滤
}

// 错误路径 ctx：403/429 原地短重试烧尽、会话不在 1h 迁移冷却时，问一次。
export interface ErrorDecisionCtx {
  now: number;
  request: { model: string; chars: number; messages: number };
  session: { pin: string; requests: number | null; degraded: boolean };  // 真值（audit 查得）
  active: string;                       // 刚失败的后端 name（== session.pin，读排除逻辑用 active）
  candidates: CandidateView[];          // 全量候选，含 active 自己——排除刚失败者由 policy 自己做
  // attempt = 本条失败链上这是第几次失败（含本次；跨请求累计、audit 推导；账本读不出/降级按 1 处理）。
  // tried = 本条失败链上已失败过的后端 name（按时间序去重，含 active）。任何一笔 200 成功即断链重来。
  // 链与计数的语义见引擎规则「失败链」条。
  error: { status: number; retryAfterMs: number | null; attempt: number; tried: string[] };
}

export interface RouterPolicy {
  // ...声明区不变...
  decide?(ctx: DecisionCtx): Decision;               // 只在正常路径被问
  decideOnError?(ctx: ErrorDecisionCtx): Decision;   // 只在迁移决策点被问
}
```

`Decision` 三态沿用：`{backend, model?}` | `'keep'` | `null`。

### 引擎规则（lib/http/server.ts）

- **decide**：每个请求的选路点问一次（现 server.ts:321 位置），normal ctx 不再构造 `requests:null/degraded:false` 占位。返回非法/抛错 → 该次决定回落内置（现行为）。
- **decideOnError**：迁移决策点（现 server.ts:426 位置）调用。调用前提三条：403/429、原地短重试已烧尽（参数化见下）、会话不在迁移冷却内。返回语义：
  - `null` → 内置迁移逻辑（`builtinDecide`：sticky-long 长会话保缓存 → 备选 rankBackends → 逐个探活）；
  - `'keep'` → 不迁移，原错误透传（请求结束，agent 稍后重试），账本记 `policy:keep`；
  - `{backend}` → 迁到该订阅（走 resolvePolicyPick 校验 + 探活）；`backend === active` 按 `'keep'` 处理（沿现状 server.ts:438）；非法 → 告警回落内置。
- **失败链与 attempt 计数**（本 spec 新增的核心语义）：
  - 「失败链」= 该 identity 在账本里**连续的** 403/429 行（一笔 200 成功即断链）；链内按时间序去重的订阅序列即 `tried`，`active` 上的连续失败行数 + 1（本次在途失败）即 `attempt`。
  - 计数是**跨请求**的：policy 每次 `'keep'` 后请求以错误结束，agent 重试是新请求，但链不断、`attempt` 继续涨——这正是「出错 3 次以后迁到 b」的计数口径（agent 的重试节奏就是计数的时间轴）。
  - 数据源：audit 沿 `idx_requests_sess_group(identity, ts)` 从最新行往回走（封顶最近 ~50 行），499（客户端取消）不计入链。一次查询完成，无新列、无新表。
  - 账本读不出 / degraded 时按 `attempt=1, tried=[active]` 处理，注释说明与 sticky-long 同源的保守取舍：宁少迁不少算。
  - **同请求内最多一跳**：迁移成功即入冷却，同请求再撞墙只透传不问 policy。链式升级（a→b→c）的每一级间隔至少一次客户端请求——agent 重试天然提供这个间隔。
- **迁移冷却长度降为声明参数**：`routing.migration_cooldown_ms`（默认 `3_600_000`，行为与现状一致）。钩子仍不可越过冷却（护栏留在引擎），但其长度从写死变成 `routing` 块配置——链式升级要在「b 上攒 3 次失败」的尺度工作，1h 默认会把链的第二级钝化 1 小时，走 ladder 的用户需要把它调短（如 60s）。**此参数取舍须用户单独拍板**。
- **原地短重试参数化（同为声明参数，不做钩子）**：`routing.wall_retry_max_attempts`（默认 3，0 = 关闭原地重试，第一次撞墙直接进 decideOnError）+ `routing.wall_retry_max_after_ms`（默认 2000，retry-after 超过它的不原地等）。原地重试是纯数值调谐项，与 `snapshot_interval_ms`/`long_session_min_requests` 同类，放 `routing` 块与冷却参数对称；不做钩子的理由：热循环 + policy 在该点无额外信息 + 防打爆仍需硬上限（加了钩子又留护栏 = 双份复杂度）。「连续错几次再迁」的策略含量全部由 decideOnError 的 attempt/tried 承担。启动时 `validateConfig` 校验（负数/离谱值拒启动）。**与冷却参数一并须用户拍板。**
- **attempt 计数与重试参数正交**：原地重试不落账本（只有最终结果记一笔），故 attempt 口径不受这两个参数影响——重试调 0 时每次客户端失败即一行账，attempt 节奏不变。
- **缺省语义（契约变化点）**：`decideOnError` 未实现 → 错误路径**直接走内置**，decide 不再兼职收 errorCtx（今天 decide 会收到 errorCtx；mine.ts 恒返 null，行为等价，迁移无痛）。`decide` 未实现 → 正常路径全内置（现状）。
- **独立回退**：decide 抛错不影响 decideOnError 的可用性，反之亦然；各自 try/catch + 告警（限流记录，沿用 selection-hook-design 的原则）。
- **硬护栏不动**：迁移冷却机制本身（identity_migrations，引擎级；长度见上，成为 `routing` 声明参数）、流首字节后不重放、候选/模型校验、账本与 `routing_note` 前缀（`policy:keep` / `policy:migrate->X` / `policy:pick->X` 不变）。
- **builtinDecide 签名**：逻辑不动；sticky-long 只读 `session.requests/degraded`，仅错误分支消费，类型保持宽松即可。

### 长会话 footgun（契约注释必写）

实现 decideOnError 后，内置 sticky-long（`routing.long_session_min_requests`，默认 10 轮不迁）**不再自动生效**——长会话保缓存的责任移交 policy。内置当初的保守取舍要注释留底给钩子作者：误迁毁 prompt cache 前缀的代价远高于误保把会话钉在撞墙订阅上；policy 可改取别的取向，但得知道当初为什么保守。`long_session_min_requests` 降级为内置回退分支参数，不删。

### 生产影响

`mine.ts` 不改（decide 恒 null、无 decideOnError）→ 生产行为与切换前逐字节等价。属契约级改动：release 流程 + systemd restart，须用户逐次授权。

## 联动改动清单

- `lib/policy/contract.ts`：类型拆分 + 注释（含 footgun、attempt/tried 语义）。
- `lib/http/server.ts`：`askPolicy` 拆 `askDecide`/`askDecideOnError`；normal ctx 简化；错误路径 `decideOnError ?? builtin`；errorCtx 注入 `attempt`/`tried`；冷却长度改读 `routing.migration_cooldown_ms`（默认 1h）。
- `lib/store/audit.ts`：`sessionSummary` 旁加失败链推导（沿 `idx_requests_sess_group` 回走，封顶 ~50 行；不新加列/表/索引）。
- 测试重指：现有 decide-with-error 用例全部指到 decideOnError；新增——(a) 定义了 decideOnError 后 decide 不再被错误路径调用；(b) decideOnError 缺省 → 内置迁移与旧 decide-返-null 逐字节一致（回归）；(c) `{backend: active}` → keep 透传；(d) 双方法独立回退（decide 炸、decideOnError 照常生效，反向同理）；(e) decideOnError 返回非法目标 → 告警回落内置；(f) 决定迁移 → `identity_migrations` 写行 + 失败笔入账（既有断言沿用）；(g) attempt 跨请求累计：假上游连续 403 三次（agent 重试三次）→ 第三次 decideOnError 收到 attempt=3；(h) 成功一笔断链：中途插一笔 200 → attempt 回到 1；(i) tried 按序含 a、b（a→b 迁移后 b 再失败）；(j) 账本读不出 → attempt=1、tried=[active]；(k) ladder e2e：a 连续 3 错 → keep×2 + 迁 b；b 连续 3 错 → 迁 c；migration_cooldown_ms 调短后链式升级真实发生。

## 附录：policy 写法示例（mine.ts 形态）

见会话记录；示例即验收口径的素材来源：

1. 按模型钉死某订阅（decide 分支 `request.model`，`candidates.find` 摸底再返回）。
2. 大上下文专走某订阅（`request.chars` 阈值）。
3. 403 不迁、429 才迁（decideOnError 按 `error.status` 分流——403 是权限/耗尽信号，重试无意义）。
4. decideOnError 自实现长会话保缓存（`session.requests >= 10 || degraded || requests === null → 'keep'`）。
5. 正常路径逃生：pin 的订阅 `walled` 时覆写到没撞墙的候选（注意覆写成功会 migrate、刷新冷却表）。
6. 失败链阶梯：`attempt` 攒够才升级、`tried` 防回头（撞墙 3 次换一个号的完整形态）：

```ts
decideOnError(ctx) {
  const ladder: Record<string, string> = { 'ocg-foxmail': 'ocg-gmail', 'ocg-gmail': 'ccg-main' };
  // 本后端连续失败不足 3 次（含本次）——不迁，让 agent 重试再来
  if (ctx.error.attempt < 3) return 'keep';
  // 阶梯下一级：没试过、没撞墙才去
  const next = ladder[ctx.active];
  if (next && !ctx.error.tried.includes(next)) {
    const t = ctx.candidates.find((c) => c.name === next && !c.walled);
    if (t) return { backend: t.name };
  }
  // 阶梯走完：随便找一个链上没试过且没撞墙的兜底；没有就原地认
  const fresh = ctx.candidates.find((c) => !ctx.error.tried.includes(c.name) && !c.walled);
  return fresh ? { backend: fresh.name } : 'keep';
}
```
