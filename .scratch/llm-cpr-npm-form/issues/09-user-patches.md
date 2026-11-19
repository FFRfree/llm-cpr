# 09 用户补丁：~/.cpr/patches 随升级自动重打

Status: ready-for-agent
Blocked by: 05

背景（2026-11-19 用户提出）：部分用户的引擎级诉求走 policy 契约表达不了，此前的出路只有 fork。本票给这类用户一条受控逃生门：自己维护统一 diff，`cpr install` / `cpr upgrade` 自动打到 npm 包上。与 patch-package 的区别：零 npm 依赖（系统 `patch` 二进制）、不进 node_modules 生命周期钩子、状态在 doctor 显性化、打不上=升级失败走回滚而非静默丢定制。

## 验收

- [ ] `~/.cpr/patches/*.patch`（按文件名序）：install 与 upgrade 在 npm 装包后自动应用；探测式幂等（正向 dry-run 过=打；反向过=已打过跳过；都不过=冲突零改动）。
- [ ] upgrade 时补丁冲突 → 升级失败走既有自动回滚（装回旧版 + 旧版上重打补丁 + 重启健康门），报补丁名单与修复指引。
- [ ] install 时补丁冲突 → 拒绝继续（服务不启动）；打上后冒烟验证的是补丁后的引擎。
- [ ] doctor 报 PATCH 三态：无 / 已应用 / 未应用 / 冲突（探测只读不改文件）+ 对应 NEXT。
- [ ] 测试：fixture 真用系统 patch 二进制（CPR_PATCH_DIR 接缝钉 tmp）——应用/幂等跳过/冲突回滚/doctor 三态。

## Comments
