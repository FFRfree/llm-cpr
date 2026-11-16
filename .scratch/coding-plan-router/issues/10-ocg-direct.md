# 10 — OCG 直连后端（多号直连，摆脱 ocg-proxy 桥接）

**What to build:** 把 ocg 家族从「家族级 backend 转交 ocg-proxy」改造成「每号一个 backend 直连 opencode.ai」。配置侧：`backends` 支持多个 ocg 家族条目（`ocg-foxmail` / `ocg-gmail`，各自 `key_env` 指自己的账号 key，`base_url: https://opencode.ai/zen/go/v1`）。快照侧：ocg 家族余量改打直连 `GET {base_url}/usage`——账号 key 鉴权 + **浏览器 UA**（默认 UA 被 Cloudflare 1010 拦，ocg-proxy lib/usage.mjs 有现成 UA 常量），解析 `usage.{rolling,weekly,monthly}.{percent,resetsAt}`（ISO 字符串，Date.parse）；`month_progress` 本层自算：`1 − (monthly_resets_at − now)/monthlyPeriodMs`（30 天，参照 ocg-proxy lib/routing.mjs:41）。翻译侧：ocg 家族统一头 → `x-opencode-session` 重写沿用现实现，钉死映射沿用本层 sqlite（身份→backend 名已按 backend 粒度，多号自然分流）。过渡兼容：`admin_url`/`admin_key_env` 的旧桥接解析保留不删（回滚路径），但不再作为 ocg 家族默认路径——直连条目与桥接条目可共存（桥接条目 family 仍 ocg 会参与评分，由配置取舍决定用哪边）。

**Blocked by:** 无（01-09 已完成；ocg /usage 接口已用真 key 实测通）

**Status:** ready-for-agent

**验收 checkbox:**
- [x] 夹具测试：真 `/usage` 返回形状（rolling/weekly/monthly percent+resetsAt ISO）解析正确；缺字段/HTTP 失败降级为余量未知
- [x] month_progress 30 天自算单测（固定 now/resets_at 断言）
- [x] 假上游 e2e：两个 ocg backend（假 OpenCode），同身份钉死、跨身份评分分流（月已用% 差异显著时）
- [x] 真上游冒烟：直连 foxmail 号非流式+流式各一笔经网关成功；快照 known=true 且与 ocg-proxy /api/route/status 同号数据对得上
- [x] 浏览器 UA 缺失场景在夹具中显式覆盖（防 Cloudflare 回归）
- [x] `node --test` 全绿；中文 commit；工作树干净
- [x] 本票 Comments 记录真冒烟结果与对账数据

## Comments

- 事实底座：OCG 直连 `/usage` 已实测（2026-11-16，foxmail 号真 key）：返回 `{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"..."},...}}`；UA 必须浏览器形。
- 生产切换（backends 换直连）属生产配置变更，实施时须用户逐次点头；本票只落代码与真冒烟（临时端口+临时配置）。
- 实现取舍：使用显式 `direct: true` 而非按 `base_url` 自动识别。这样同为 `family: ocg` 的直连条目与 legacy admin 桥接条目可共存/回滚，不会因改 URL 意外改变快照来源；未标记的 ocg 条目维持原 admin/status 路径。
- 真上游冒烟（临时配置/随机回环端口，生产 backends 未改）：foxmail、gmail 两个直连快照均 `known=true`；monthly_percent 分别为 8%、42%，与只读 `ocg-proxy:8742/api/route/status` 同号数据分别为 8%、42%，差值均 0 个百分点。30 天周期自算 month_progress 分别约 28.26%、62.06%。网关非流式与流式请求各一笔均 HTTP 200；审计均记录到 `ocg-foxmail`（当次评分选中，gmail 快照也已对账）。
- 路径兼容：当 backend base URL 已以 `/v1` 结尾时，转发追加 `/chat/completions` 而非重复 `/v1`；假上游 e2e 覆盖 `/zen/go/v1/chat/completions`。

- 2026-11-16 迁移第②步完成（用户批准）：生产 config.json backends 从 ocg-main(桥接) 换为 ocg-foxmail/ocg-gmail(直连)+ccg-main；.env 追加两号 key。重启后三 backend 快照全 known（foxmail 8%/进度28.3%、gmail 42%/62.1%、ccg 2.7%），真请求落 ocg-foxmail 200。**切换前补了关键代码**：旧身份钉在被移除的后端名上原本 503 硬挡，改为走 migrate 自动迁移重钉（pin 保持不可变语义），实测钉在 ocg-main 的旧会话身份切后 HTTP 200。ocg-proxy 未停（回滚：config.json 换回桥接条目重启即可）。