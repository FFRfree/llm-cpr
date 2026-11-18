# Spec: policy 收敛为单 decide 钩子（正常路由 + 迁移目标同钩子）

**Status:** claimed
**日期:** 2026-11-18
**出处:** 用户讨论（本会话，接替 `.scratch/decide-split/spec.md`）。演进路径：初版「错误路径全收引擎、decide 不参与」→ 用户补拍板「迁移目标的选择仍归 policy」→ 定版：decide 在正常路由与迁移决策两个点都被问，单类型单钩子；原地重试等机械动作全收引擎；新增 CandidateView.recent 近期健康信号。用户明确取向：看到 walled 不主动切，等真撞墙由默认路径处理（逃生口定位为长会话解药，见指南例 3）。

## Problem Statement

decide-split spec 的双钩子给了错误路径完整表达力（attempt/tried/ladder），但代价是 footgun（接管 decideOnError 即接管长会话保缓存）、ctx 双类型、重试边界教育成本。用户重估：原地重试是引擎的机械动作，不该编程；但迁移决策点仍是「这次路由到哪」的一种，目标选择应归 policy。此外 policy 目前完全看不到后端的近期服务质量（5xx/超时/流断），选号是盲选。

## Solution

### 契约（lib/policy/contract.ts）——单钩子、单类型

```ts
export interface DecisionCtx {
  now: number;
  request: { model: string; chars: number; messages: number };
  session: { pin?: string };            // 上一次路由到的后端（钉死）；新会话 undefined
  candidates: CandidateView[];          // 已按模型支持过滤；walled 是标志位不是过滤
  error?: {                             // 仅迁移决策点出现：
    backend: string;                    //   刚吃 403/429 的后端（== session.pin）
    status: number;                     //   403 或 429 —— policy 可区分对待
    retryAfterMs: number | null;
  };
}

export type Decision = { backend: string; model?: string } | 'keep' | null;

export interface RouterPolicy {
  // ...声明区不变...
  decide?(ctx: DecisionCtx): Decision;  // 唯一钩子，两个决策点共用
}
```

与现状契约的差异：删除 `session.requests`/`session.degraded`（正常路径的占位假值；错误路径的账本真值改由引擎护栏自己消费，不再喂给 policy）。sticky-long 前置后，policy 在错误路径拿不到、也不需要长会话信号。

### CandidateView 增加 recent（后端近期健康）【本 spec 新增】

```ts
interface CandidateView {
  // ...现有 name/family/alias/priority/walled/snapshot 不变...
  recent?: {
    fails: number;         // 最近 10 分钟内失败笔数（全 identity 聚合，499 不计）
    lastStatus?: number;   // 最近一次失败的状态码
    lastErrorAt?: number;  // 最近一次失败的时间戳
  };                       // undefined = 窗口内没观察到失败（≠ 保证健康，观察盲区语义同 snapshot undefined）
}
```

- **数据源**：`record()` 记账路径顺手喂内存健康追踪器（每后端环形存最近 50 笔失败的时间戳+状态码），构造 ctx 时现算窗口计数。零查询、不碰账本、不加索引；重启后 recent 归 undefined（与快照未知语义一致）。
- **与 walled 的分工**：walled/snapshot = 额度账本（每账号）；recent = 服务质量（5xx/超时/流断/网络错误）。403/429 也计入 fails，policy 须结合 walled 解读（fails 高且全 429 → 额度问题；lastStatus 5xx → 服务问题）。
- 窗口 10 分钟先用常量写死，将来有需要再参数化。

### 引擎规则（lib/http/server.ts）

- **正常路由决策点**（每请求一次，现 server.ts:321）：decide 收无 `error` 字段的 ctx。返回非法/抛错 → 该次决定回落内置（现行为）。
- **迁移决策点**（403/429 原地短重试烧尽后，现 server.ts:426 位置）按序过两道护栏，再问 decide：
  1. 迁移冷却中 → 不问 policy，错误透传（现状不变）。
  2. **长会话 sticky-long → 不问 policy，keep 透传**（≥ `long_session_min_requests` 轮、账本读不出或 degraded；引擎自己查 audit）。这是本次新增的护栏化：现状 policy 理论上可覆写长会话保护，收紧为不可——固化用户拍板取向「缓存前缀连续性 > 池内调度」。
  3. 其余 → askPolicy（ctx 带 `error` 标记）：
     - `null` → 内置迁移（rankBackends 排除 active、过滤撞墙 → 逐个探活），行为同现状；
     - `'keep'` → 不迁，原错误透传，账本记 `policy:keep`；
     - `{backend}` → 迁到该订阅（resolvePolicyPick 校验 + 探活）；`backend === error.backend` 按 `'keep'` 处理；非法 → 告警回落内置。
- **原地重试对 policy 不可见**：引擎自治（参数化见下），不落账本、不问钩子。
- **迁移频率口径（写进契约注释）**：单请求内自动迁移 ≤1 次（迁移即入冷却，同请求再撞墙只透传）；冷却窗口内自动迁移 ≤1 次；**policy 正常路径覆写不受冷却前置检查限制**（覆写成功即 migrate 并刷新冷却时间戳）——刻意保留的逃生口，指南标注「别写成高频动作」；长会话自动迁移 = 0（护栏）。
- **routing 声明参数**：`migration_cooldown_ms`（默认 3_600_000）、`wall_retry_max_attempts`（默认 3，0 = 关闭原地重试）、`wall_retry_max_after_ms`（默认 2000）。启动 `validateConfig` 校验；**三个默认值须用户拍板后才实现**。
- 硬护栏不动：候选/模型校验、流首字节后不重放、迁移冷却机制、账本与 `routing_note` 前缀。
- attempt/tried 失败链计数**不做**（decideOnError 的配套，随其退役）；错误路径可观测性走账本与看板（迁移成功时失败笔入账的既有工单不变）。

### 被放弃的能力（记录在案）

- 失败链 ladder（a 错 3 次迁 b、b 错 3 次迁 c）——policy 拿不到 attempt/tried，做不了跨请求计数。将来真需要时从 `.scratch/decide-split/spec.md` 重启（decideOnError 形态）。
- 保留的能力：403/429 区分对待（`error.status`）、迁移目标自定义（`{backend}`）、长会话保缓存（升级为引擎护栏）、后端近期健康可见（`recent`，新增）。

### 生产影响

ctx 瘦身 + sticky-long 前置 + recent 注入 + 参数化；`mine.ts` 不改 → 除「长会话时 policy 不再被问」外生产行为与现状一致（mine.ts 恒返 null，该差异不可观测）。release 流程 + systemd restart，须用户逐次授权。

## 联动改动清单

- `lib/policy/contract.ts`：DecisionCtx 收缩 + `error` 标记注释 + CandidateView.recent。
- `lib/http/server.ts`：normal ctx 去掉 requests/degraded 占位；错误路径 sticky-long 前置；内存健康追踪器（record 挂钩，candidateView 注入 recent）；routing 三参数接入原地重试与冷却。
- `lib/policy/builtin-decide.ts`：不动（sticky-long 逻辑保留作 decide 返 null 的兜底；护栏前置只影响「问不问」）。
- `lib/policy/config.ts`（validateConfig）：三个 routing 参数校验。
- 测试：现有 decide-with-error 用例改为断言「sticky-long 命中时不调 decide、未命中时 ctx 带 error 标记」；新增 recent 注入与窗口计算、`wall_retry_max_attempts=0` 直达迁移决策、`migration_cooldown_ms` 生效、403/429 经 ctx.error.status 可区分；全量 `node --test` + `npm run typecheck`。
- `docs/policy-guide.md`：同步（已按本契约重写，recent 语义见 CandidateView 节与例 6）。

## 测试清单（本机假上游）

- decide 缺省/恒 null → 全链路与现状逐字节一致（回归）。
- 迁移决策点：非长会话 → decide 收到 `error={backend,status,retryAfterMs}`；返回 `{backend: X}` → 迁移成功、`identity_migrations` 写行、失败笔入账、账本记 `policy:migrate->X`；返回 `'keep'` → 透传；返回非法 → 告警回落内置。
- sticky-long 护栏：长会话撞墙 → decide 不被调用（spy）、keep 透传（现状行为等价）。
- recent：假上游制造 502 → 该后端 candidates.recent.fails 计数、lastStatus=502；重启进程 → recent undefined；499 不计入。
- `wall_retry_max_attempts=0` → 第一次撞墙直接进迁移决策点。
- `migration_cooldown_ms` 调短 → 冷却窗口按参数生效。
- 正常路径 ctx 无 `error` 字段；覆写逃生（walled）既有测试沿用。

## 实现记录（2026-11-18）

- 工作树已实现（未提交、未部署）：`contract.ts`（单 decide 双决策点 + error 标记 + CandidateView.recent）、`server.ts`（ctx 瘦身、sticky-long 前置护栏、内存健康追踪器挂 record、routing 三参数）、`builtin-decide.ts`（sticky-long 数据源移到 options.sessionUsage）、`config.ts`（routing 数值参数启动校验）、`contracts.ts`（RoutingConfig 三字段）。
- 测试：`node --test` 124/124 通过（含新增 sticky-long 护栏 / recent 注入 / wall_retry_max_attempts=0 / routing 参数校验四类），`npm run typecheck` 干净。
- 默认值按用户「按这个实现」拍板：三个参数默认与现状一致（1h / 3 / 2000），生产行为除「长会话时 policy 不再被问」（mine.ts 恒 null 下不可观测）外零变化。
- 上线须走 release 流程，单独征得用户授权。
