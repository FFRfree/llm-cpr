# Spec: 账本看板查询索引 + e2e 夹具日期防腐烂

**Status:** completed
**日期:** 2026-11-17（原属 coding-plan-router 伞下工单 13；2026-11-18 拆出为独立 feature）

## Problem Statement

网关账本按每笔请求一行持续增长，管理口/看板查询是对 `requests` 表的全表分组聚合。三个月量级（约 9 万行）时看板一轮查询 356ms，而看板每 5 秒轮询一次——等于每轮断流 0.35 秒，可观测性反向拖垮流式转发。

## Solution

在 `lib/audit.ts` 构造函数加两条索引（会话分组 `idx_requests_sess_group` + 订阅聚合覆盖索引 `idx_requests_sub_agg`），`IF NOT EXISTS` 幂等，老库新库统一生效。硬约束：**引用可选列的索引必须建在列迁移（ALTER 补 `ttft_ms`/`stream_ms`）之后**——放 SCHEMA 会先于 ALTER 执行，老库开库直接降级 db=null。

方案取舍：不拆进程、不 worker 化、不分页（分页治不了全表分组，worker 违背零依赖，拆进程牵走路由内存态）；汇总内存缓存留作后手，触发条件是订阅聚合在几十万行级重新变慢（实测 50 万行时 ~139ms）。

顺手拆除 e2e 夹具的写死日期定时炸弹：resetsAt/periodEnd 全部相对真实时间动态生成，账期用以 now 为中心的对称窗口。

生产数据库的手动建索引已单独授权执行（2026-11-17，不停服）。完整实测口径与坑见 `issues/01-dashboard-query-indexes.md`。
