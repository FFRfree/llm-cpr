# spec: perf 打点（转发路径分段计时）

## 动机

对标调研（scratch 批次 2026-11-20-gateway-best-practices）已确认业界做法，但「我们的实现到底吃掉多少转发时间」没有本机数据。账本已有 ttft_ms/stream_ms/ms 三个数，但它们都从 `startedAt`（选路完成后）起算——**选路前的开销（读包、解析、亲和查询、policy decide、TCP 探活、改写 body）完全不可见**，而这正是「我们的代码是否拖慢转发」的问题所在。本 feature 给转发路径加分段计时，每请求落一行结构化日志，跑一段真实流量后可聚合出各段分布。

## 设计

- **一段一行**：每个客户端请求在响应 close 时输出一行 `[perf] {json}`（systemd journal 可 grep）。不落库（先轻后重：聚合用 journal 即可，若将来要看板再升 schema）。
- **段位**（ms，Date.now 粒度不足的段用 `performance.now`，保留 1 位小数）：
  - `read` 读请求体；`parse` JSON.parse+模型查表；`identity` 身份解析+亲和查询（含 sha256）；`snapshot` 无快照时的阻塞刷新（0=未发生）；`route` 选路块（policy+builtin，含探活）；`probe` 其中 TCP 探活累计（分析时 route−probe=纯决策）；`prepare` 协议改写+JSON.stringify；`capture` 正文捕获（opt-in 租户）；`pre` 到达→startedAt 总额（完整性互校：≈各段之和）。
  - `forward`: `{ttft, stream, attempts}`（startedAt 起，与账本同口径，attempts=上游尝试次数）。
  - `meta`: `{status, bytes, model, tenant}`。**不含 identity/会话 id/正文**（perf 日志过 journal，按账本 identity_hash 同纪律不落身份明文）。
- **发射点**：`res.on('close')` 幂等发射一次（writableFinished=false 标 `aborted:true`——499 与半截流都有行）。401/404/本地 400 类不设 span（不是转发路径）。
- **开销自限**：span 本身是几个属性赋值；`performance.now` 每段两次。目标自开销 <0.1ms/请求。

## 配套（同 feature 交付）

- `scripts/perf-overhead.ts`：本机假上游离线基准——直接打假上游 vs 经网关各跑 N 轮（10KB/1MB/3.4MB 三档 body），解析 `[perf]` 行聚合各段 p50，输出「经网关−直连」差值；同时统计假上游收到的连接数（验证 Node globalAgent keepAlive 复用）。不打真实上游、不烧订阅额度。

## 非目标

- 不改路由行为、不落库、不进看板；探活改异步/连接池调优等**优化项**是本 feature 的后手（数据出来再立项），不在本批做。

## 开放问题

- 无。
