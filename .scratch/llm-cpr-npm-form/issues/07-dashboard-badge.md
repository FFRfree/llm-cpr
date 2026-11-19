# 07 看板版本号与新版徽标（交互时现查）

Status: ready-for-agent
Blocked by: 02

## 验收

- [ ] 看板显示当前运行版本。
- [ ] **打开看板时**经管理口现查 npm registry 最新版，结果缓存 1 小时；无人交互进程零网络请求（不轮询）。
- [ ] `cpr doctor`/`cpr upgrade` 同源现查。
- [ ] 看板徽标与 CLI 输出一致展示「有新版 → 运行 cpr upgrade」。
- [ ] 测试：管理口版本端点（含缓存窗口）、registry 不可达时降级显示不炸。

## Comments
