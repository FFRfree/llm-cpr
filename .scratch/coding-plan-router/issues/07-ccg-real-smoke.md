# 07: CCG 家族真上游接入冒烟

**What to build:** 对真 CommandCode 的端到端冒烟：把本仓 `.env` 填入真 key（从现有凭据复制，chmod 600），假 ocg + 真 ccg 并存配置下走通：真 /alpha 三接口的字段映射单测化（monthlyCredits/windowLimits/subscriptions 全字段，含未来字段缺失的容错）；真请求经路由器落到 commandcode 且响应正常；真账本里能看到该笔记录。**不改任何生产配置**（Hermes 仍直连；本票只验证网关→真上游方向）。

**Blocked by:** 03、04、05（核心逻辑齐备）

**Status:** ready-for-agent

- [ ] /alpha 字段映射单测（真实样本 JSON 做夹具，含字段缺失/异常形态）
- [ ] 真上游冒烟：非流式+流式各一笔成功；账本可见；模型翻译正确（统一名 → org 前缀名）
- [ ] 冒烟结果（请求数、耗时、扣费观察）写进本票 Comments 区
- [ ] `node --test` 全绿；中文 commit；工作树干净
