# 03: 额度快照轮询 + 月度欠账评分选订阅

**What to build:** 后台快照轮询器（约每分钟，可配）拉取每个订阅的余量数据：ccg 家族打假上游的 `/alpha/billing/credits`（monthlyCredits、fiveHour/weekly 的 used/cap/resetAt/exceeded）+ `/alpha/usage/summary` + `/alpha/billing/subscriptions`；ocg 家族打假 ocg-proxy 管理口 `/api/route/status`。快照带新鲜度与降级标记。新身份选订阅 = `月时间进度% − 月已花%`（百分比归一）最高者；候选先按"模型在订阅模型表内"过滤；5h/周窗 exceeded 的订阅跳过；全部候选窗满 → 客户端收到明确报错（已拍板：挡死，不做开关）；月度 ≥100% 的排最后、全员月度耗尽才放宽。/alpha 查询失败 → 该订阅降级为"余量未知"，选择退回 priority 顺序，不影响转发。

**Blocked by:** 02（新身份才需要选订阅）

**Status:** ready-for-agent

- [ ] 单测：评分函数（进度/已用组合的排序表）、窗口跳过、月度耗尽排最后与放宽、模型白名单过滤、余量未知降级
- [ ] e2e（两个假后端，可编程余量）：落后日历的被选中；窗满的被跳过；双窗满 → 明确报错；/alpha 500 → 降级继续转发
- [ ] 快照新鲜度：数据过期时行为可预期（沿用旧快照 + 日志标记，参照 ocg-proxy 用法）
- [ ] `node --test` 全绿；中文 commit；工作树干净
