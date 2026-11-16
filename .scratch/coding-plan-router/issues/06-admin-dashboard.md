# 06: 管理口 API + 看板

**What to build:** 回环管理口（RESTful 风格沿用 ocg-proxy 口径）：`/api/route/status`（订阅列表+当前映射概览）、`/api/audit/requests`、`/api/audit/sessions`、`/api/audit/summary`（复用 05 号的查询）；看板为极简单页零框架：核心视图每订阅一行——5h/周/月三窗口已用 vs 上限柱状图 + 月时间进度参考线（"谁在浪费一眼可见"）；次级视图：会话列表 / 会话详情（cache 丢失事件高亮）。数据全部来自快照与账本，测试中用假数据验证渲染契约。

**Blocked by:** 03（快照数据）、05（账本查询）

**Status:** ready-for-agent

- [ ] 单测：管理 API 各端点响应形状（RESTful、稳定字段名）
- [ ] 看板契约测试：给定快照+账本假数据，页面渲染出的关键数值正确（窗口柱、时间进度线、丢失事件）
- [ ] 管理口只绑回环（有断言）；与流量口同 master key 鉴权可选（默认回环免 key，参照 ocg-proxy 两种模式）
- [ ] `node --test` 全绿；中文 commit；工作树干净
