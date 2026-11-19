# 07 看板版本号与新版徽标（交互时现查）

Status: completed
Blocked by: 02

## 验收

- [x] 看板显示当前运行版本。
- [x] **打开看板时**经管理口现查 npm registry 最新版，结果缓存 1 小时；无人交互进程零网络请求（不轮询）。
- [x] `cpr doctor`/`cpr upgrade` 同源现查。
- [x] 看板徽标与 CLI 输出一致展示「有新版 → 运行 cpr upgrade」。
- [x] 测试：管理口版本端点（含缓存窗口）、registry 不可达时降级显示不炸。

## Comments

- 实现：`core/http/server.ts` 新增 `GET /api/version`（version 来自 engine package.json，latest 经 `fetch registry /llm-cpr/latest` 现查、模块级缓存 1h，5s 超时，失败 latest=null 降级）；接缝 `CPR_REGISTRY_URL`/`CPR_LATEST_TTL_MS`。看板 `static/dashboard.html` 头部加 `#ver` 区：有新版亮「有新版 vX → 运行 cpr upgrade」、一致则「vX（最新）」、查不到只报当前版；只在打开看板/回前台时请求，不进 30s 自动刷新轮。顺手修 rebrand 漏网：看板 `<h1>` "Coding Plan Router" → "LLM CPR"。
- CLI 同源说明：`cpr doctor`/`upgrade` 走 `npm view llm-cpr version`（spawn npm），引擎走 registry HTTP——两者同打 registry.npmjs.org/llm-cpr，真相同源；引擎不 spawn npm（服务进程不依赖 npm 二进制存在）。
- 测试 `test/version.test.ts` 3 例：现查一次+缓存窗口零重复（假 registry 命中计数）、TTL=0 接缝下每次现查、registry 不可达降级 latest=null 端点 200。探活用 /api/route/status，不污染 registry 命中计数。
