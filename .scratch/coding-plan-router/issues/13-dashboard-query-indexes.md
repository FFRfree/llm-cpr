# 13 — 账本看板查询索引（3 个月量级性能保障）+ e2e 夹具日期防腐烂

**Status:** completed

**目标：**让网关跑满 3 个月（约 9 万行请求账）后，管理端/看板查询依然不影响流式转发。实测依据（scratch 副本灌假数据、用生产同款 SQL）：9 万行时看板一轮查询无索引 356ms（每 5 秒断流 0.35 秒，用户担心的问题必然发生）；加两条索引后 63ms（无感），50 万行（约一年半）余量测试 264ms。决策：选「索引」而不是拆进程/worker/分页——分页治不了全表分组；worker 化违背零依赖原则且解决不了内存态共享；拆进程把 `/api/route/status`、`/api/snapshots` 依赖的路由进程内存态也牵进来，是大手术。汇总缓存（每分钟算一次而非每 5 秒）留作后手，触发条件是订阅聚合在几十万行级重新变慢。

## 范围与边界

- `lib/audit.ts` 构造函数加两条索引，`IF NOT EXISTS` 幂等，老库新库统一生效。
- 顺序硬约束：必须在列迁移（ALTER 补 `ttft_ms`/`stream_ms`）**之后**建——`idx_requests_sub_agg` 依赖这两列，放 SCHEMA（先于 ALTER 执行）会让老库开库直接降级（db=null、账本不可用）。第一版就踩了这个坑，被新增迁移测试当场抓住。
- 顺手修既有 e2e 定时炸弹（与本工单主线无关但同批验证发现）：夹具写死日期 + 网关真实时钟 = 到期当天测试集体爆。
- 生产数据库的手动建索引经用户逐次授权执行（2026-11-17），不停服。
- 不做：worker 线程、拆看板进程、汇总缓存（留作后手，见目标）。

## 验收

- [x] `lib/audit.ts`：`idx_requests_sess_group(identity, identity_kind, ts)`（会话 GROUP BY 走索引分组免排序）+ `idx_requests_sub_agg(subscription, status, total_tokens, completion_tokens, stream_ms, ttft_ms)`（订阅聚合覆盖索引）；均在列迁移后创建。
- [x] `test/audit.test.ts`：新增迁移测试——手工建无索引老库 → 开 `UsageAudit` → 断言三条索引齐备且老行保留。
- [x] `test/routing-score.test.ts` + `test/client-cancel.test.ts`：e2e 夹具日期全部改为相对真实时间动态生成（`isoFromNow`/以 now 为中心的对称账期）；冻结 `now` 的纯函数测试不动。效果：修好当天已爆的 OCG 直连 e2e（rolling `2026-11-17` 过期 → 快照未知 → 排序降级 priority 兜底 → 断言翻），并拆除 3 天后（weekly）与 12-01（periodEnd）共四颗同类炸弹。
- [x] `npm run typecheck` 通过；`node --test` 98/98 全绿（改动前 97/98，唯一失败为上述定时炸弹，stash 对照确认与本批改动无关）。
- [x] 生产库手动建索引已执行并验证：`PRAGMA index_list` 三条索引齐备（1036 行，瞬间完成），服务 active，管理口正常、账本持续写入。

## Comments

- 2026-11-17：性能结论的实测口径——scratch 副本复制生产库后按真实分布（~100 会话、2 订阅）灌行，用 `audit.ts` 原文 SQL 计时。9 万行：会话 GROUP BY 269.9ms→17.7ms、订阅聚合 72.2ms→27.4ms、一轮合计 356.4ms→63.3ms。50 万行 + 索引：合计 263.9ms（订阅聚合 139ms 为新瓶颈，届时上汇总缓存）。
- 2026-11-17：迁移测试的即时价值——首版把两条索引放进 SCHEMA，老库（缺 ttft/stream 列）开库即降级，新测试与既有列迁移测试双双失败，定位后移入构造函数列迁移之后，全绿。教训固化：**凡引用可选列的索引，创建时机必须在列迁移后**。
- 2026-11-17：定时炸弹根因链——夹具 rolling `resetsAt: 2026-11-17T00:00:00Z` 当天过期 → `snapshots.ts` 按设计标 `known:false, expired:true`（「过期标未知而非确定有额」是既定行为）→ 排序降级 priority 兜底 → foxmail(p0) 赢 gmail，断言期望 gmail 失败。纯函数测试自冻 `now` 不受影响，故只修 e2e。`client-cancel.test.ts` 的 2026-01-01 早已过期但单后端场景掩盖了问题，同批修掉。
- 2026-11-17：生产手动建索引经用户明确授权（clarify 逐次确认），连接设 `busy_timeout=5000` 防与在途 INSERT 撞写锁；执行后服务 active、`/api/audit/requests` 正常返回、账本持续落行。生产 `current` 仍为全 `.mjs` 版（无此代码），下次 `.ts` 上线时构造函数的 `IF NOT EXISTS` 会自然幂等通过，无需重复处理。
