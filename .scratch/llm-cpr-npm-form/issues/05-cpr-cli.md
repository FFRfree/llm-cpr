# 05 cpr.ts 重写为 npm 形态

Status: ready-for-agent
Blocked by: 02, 03, 04

## 验收

- [ ] install：Node/npm 前提检查 → 建 `~/.cpr`（policy 模板、`.env` 随机 master key、tsconfig）→ 用户级 unit（Linux `systemctl --user` + `loginctl enable-linger`；macOS LaunchAgent 输出标 experimental）→ 冒烟 → y/N 启动；幂等，重复执行报现状不重置用户文件。
- [ ] upgrade：npm 装新版 → 备份 DB → y/N 重启 → 健康检查，失败**自动装回旧版**并报原因；`cpr upgrade --to <版本>` 手动退版。
- [ ] doctor：NODE/REPO（npm 版）/当前版本/npm 最新版现查/DB schema 版本 + NEXT 建议。
- [ ] uninstall：停服务删 unit；`~/.cpr` 永不静默删（打印路径留证）。
- [ ] 测试：fixture 全接缝钉死（`CPR_*` stub 沿用），含升级失败自动回滚路径；真 systemd 一次性 e2e 按惯例现场构造、不进常驻套件。

## Comments
