# spec: http 模块拆分（server.ts 944 行 → 职责各归其位）

## 动机

perf 打点加进来后 server.ts 到 944 行，混了五种职责（转发管道、健康观察、打点、管理口 API、路由编排）。按 codebase-design 的词汇切深模块：每个职责一个模块、接口保持小、行为零变化。

## 拆分

全部落在 core/http/ 同层（import.meta.url 相对深度不变——STATIC_ROOT/package.json 的 '..','..' 解析不受影响）：

- `respond.ts` — json 错误响应 + messageOf/statusOf（转发口/管理口/管道共用）。
- `perf.ts` — createPerfSpan（spec .scratch/perf-instrumentation/spec.md）。
- `health.ts` — healthyBackend（TCP 探活，含「只证明端口可连」边界注记）+ createHealthTracker（10 分钟失败环）。
- `forward.ts` — 转发管道：forwardAttempt/sleep/retryAfterMs/passthroughError + ForwardTimings/QuotaResult 类型。职责边界写在文件头：只管管道与错误时序，选路/重试语义归路由环。
- `admin.ts` — 管理口整个 HTTP 面：静态分发、EVENT_KINDS 白名单、npm 版本缓存、20+ 端点。接口 = createAdminServer(deps)，deps 是网关运行时只读视图（policy/tenants 视图/snapshots/audit/events/capture）；鉴权不在此模块（隔离靠 127.0.0.1 绑定 + SSO 反代，既有约定）。
- `server.ts` — 只剩路由编排：鉴权/租户解析（keyEnv 不出本模块）、建库迁移、捕获接线、转发路由环。

## 非目标

不改任何行为（本地假上游基准三档数字拆分前后一致：≈7/23/62ms）；不再往下切（路由环本身是内聚的决策流程，为切而切会碎）。

## 开放问题

- 无。
