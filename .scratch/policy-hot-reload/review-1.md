# Review 1：policy-hot-reload（独立 review，2026-11-20，子代理 findings-only）

> 探针正本：`/root/ffr-scratch/2026-11-20-cpr-policy-hot-reload/review-probes/`（批次目录会老化；探针结论以本文件为准）。基线：`node --test` 198/198、`npm run typecheck` 0 错。处置见各 finding 的「处置」行，修复 commit 见票 Comments。

## Findings

**P2-1｜inflight 合流下审计事件按合流调用者翻倍（成功与失败都翻）**
- `core/http/server.ts:418-437`（applyReload 的事件落账在 await 之后，每个合流调用者各执行一遍）
- 复现：`review-probes/probe2-concurrency.ts`——慢 import（TLA 800ms）期间 3 请求 + 1 手动 reload 并发到达 → 1 次重载落了 4 条 `policy.reload` 事件（reloads 计数正确=1，账本 4 行同 detail）；失败路径同样 4 条。违反「成功必落事件」的单次语义，账本可对账性受损（生产常态：import 窗口内几乎总有并发请求）。
- 修法：applyReload 只在「本次调用是 inflight 创建者」时落事件/日志（server 层自有 inflight 标记）。
- 处置：已修（server 层 inflight 合流，创建者独占事件落账）。

**P2-2｜冷区拒绝被去重后 reason 漂移成 load-failed，CLI 的 y/N 重启流程失效**
- `core/policy/reload.ts:150-152`（去重分支硬编码 `reason:'load-failed'`，且丢 `coldChanged`）
- 复现：`review-probes/probe1-reloader-edges.ts`（A 场景）+ `probe3-cli-deduped-coldzone.ts`——请求入口懒检查抢先触发失败后，用户再跑 `cpr reload`，管理口返回 `{kind:'kept', reason:'load-failed', deduped:true}`，CLI 走「热更新失败」分支：不打印字段清单、不提供 y/N 代跑重启，还叫用户「修好文件」——实际药方是重启。
- 修法：失败记录连 kind 一起存，去重返回时保留首次失败的 reason/coldChanged。
- 处置：已修（lastReason/lastColdChanged 随去重返回；CLI y/N 流程在去重路径恢复）。

**P3-1｜同内容 mtime 变化（touch/编辑器回存）触发完整重载：每次落 1 条 `from_hash==to_hash` 的事件 + 1 份备份**
- 修法：读文件后先比对内容哈希，与当前 sha256 相同 → 视为 unchanged（更新 loadedSig 后返回）。
- 处置：已修。

**P3-2｜成功重载后 `lastColdChanged`/`lastError` 不清**
- 修法：reloaded 成功路径把两者清 null（状态端点语义 =「当前健康度」，历史在事件账）。
- 处置：已修。

**P3-3｜慢/挂死的 import 拖死整个网关，无超时**
- 修法：import 套 10s 超时，超时按 load-failed 保旧（dangling import 不引用即弃，无副作用）。
- 处置：已修。

**P3-4｜备份落点与文档不符**（`dirname(dbPath)/backups/policy` vs 文档 `~/.llm-cpr/backups/policy/`；unit 的 CPR_DB_FILE 指 data/ 子目录）
- 修法：backupDir 锚到 `dataDir(env)`（CPR_DATA_DIR 接缝正主），与文档一致；测试 env 显式钉 CPR_DATA_DIR。
- 处置：已修。

**P3-5｜`lastTrigger` 语义含混**（每请求入口覆盖成 file-change，合流时可能与事件 trigger 不一致）
- 修法：只在 outcome 为 reloaded 时更新，语义 = 最近一次实际生效换新的 trigger。
- 处置：已修。

**P3-6｜CLI 小口径**：非 200 响应也报「管理口不可达」（500 时误导）；builtin 部署跑 reload 答「声明文件未变化」而实际没有外置文件。另 GLOSSARY 热区词条补一句：`identity_header` 热换会更换身份口径，全部身份将按新口径重新判定亲和（一次性重绑）。
- 处置：已修（CLI 区分「不可达 / HTTP 错误」两种文案；unchanged 文案覆盖 builtin 部署；GLOSSARY 补句）。

## 核对过没问题的探针点

SQLite 8 列 8 占位符未动 ✓；EVENT_KINDS ↔ EventKind 同步、/api/events?kind= 过滤可用 ✓；test/ 内无 type-tests ✓；cpr.ts 零新依赖、CPR_* 接缝照常生效 ✓；reload 测试跑 fixture 拷贝、reload 路径无 spawnSync 残留 ✓；启动行正则兼容（:567/:580）✓；main.ts 坏文件 exit 1 语义原样（保旧只在运行中 reload）✓；每请求路径全读 reloader.current()、定型物仍构造时捕获 ✓；maybeReload 合流无竞态、reload 期间后到请求序列化等待不绕过 ✓；builtin 零行为（不 stat、不建备份目录、无事件）✓；新端点只在 127.0.0.1 的 adminServer、无暴露面扩大 ✓；错误摘要截断 400 字符不含文件全文 ✓；备份成功才拷、内容哈希==to_hash、备份失败不拦换新 ✓；COLD_POLICY_FIELDS ↔ 文档冷热分区一致 ✓。
