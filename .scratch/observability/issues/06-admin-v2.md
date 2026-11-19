# 06 后台 Admin v2：多页化 + 分页排序 + 轨迹查看器

Status: completed

## 背景

用户拍板：旧单页 dashboard.html（522 行）废弃，后台重做。硬需求：
1. 每个订阅的用量展示（上游快照 + 账本实际消耗两个口径）；
2. 基于现有库的查询/聚合；
3. 服务端分页/排序；
4. DSH 式 Trajectory（逐轮完整 messages 数组浏览）。

## 验收

- [x] 拆成 5 页（static/ 下多页 + 共享 assets/app.css、assets/app.js，无框架无构建）：
      index（概览+订阅用量）、requests、sessions、trajectory、observability。
- [x] 订阅用量双口径：`/api/route/status` 快照窗口卡 + 新端点 `/api/audit/usage`
      （账本按订阅×北京时间日聚合 requests/errors/tokens/cache，`usageByDay`）。
- [x] 服务端分页排序：`listRequestsPaged`（排序键白名单，days 只有下界）与
      `listSessionsPaged`（组数 ≤500，full_miss_rate JS 排序 null-last）；page 参数
      在 → 分页响应（带 total），不在 → 旧 limit 形态（兼容既有调用方）。
- [x] 轨迹查看器：会话 → 轮次时间线（缓存取证链标「前缀断裂/新增」）→ 单轮完整
      messages 渲染；`turnBody` 增 `refs`（逐消息盐化哈希），前端精确标
      「同上轮（缓存命中段）/本轮新增」；支持 `?identity&tenant&capture_id` 直达。
- [x] 静态目录分发（白名单扩展名 + 防穿越 + HTML no-store/资产 60s），`/` → index.html；
      旧 dashboard.html 删除（历史在 git）。
- [x] 新端点 `/api/events`（kind 白名单）供观测页事件流。
- [x] 测试：test/admin-backend.test.ts 4 张（分页/聚合/静态穿越守卫/turnBody refs）
      + admin-dashboard.test.ts 断言改新 index 契约；全量 185/185。
