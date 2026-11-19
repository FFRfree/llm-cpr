# 09 用户补丁：~/.cpr/patches 随升级自动重打

Status: completed
Blocked by: 05

背景（2026-11-19 用户提出）：部分用户的引擎级诉求走 policy 契约表达不了，此前的出路只有 fork。本票给这类用户一条受控逃生门：自己维护统一 diff，`cpr install` / `cpr upgrade` 自动打到 npm 包上。与 patch-package 的区别：零 npm 依赖（系统 `patch` 二进制）、不进 node_modules 生命周期钩子、状态在 doctor 显性化、打不上=升级失败走回滚而非静默丢定制。

## 验收

- [x] `~/.cpr/patches/*.patch`（按文件名序）：install 与 upgrade 在 npm 装包后自动应用；探测式幂等（正向 dry-run 干净过=打；输出带「Reversed (or previously applied)」=已打过跳过；非零=冲突零改动）。
- [x] upgrade 时补丁冲突 → 升级失败走既有自动回滚（装回旧版 + 旧版上重打补丁 + 重启健康门），报补丁名单与修复指引；健康门失败与补丁冲突共用同一条回滚函数。
- [x] install 时补丁冲突 → 拒绝继续（服务不启动）；打上后冒烟验证的是补丁后的引擎。
- [x] doctor 报 PATCH 四态：无 / 已应用 / 未应用 / 冲突（探测只读不改文件）+ 对应 NEXT。
- [x] 测试：fixture 真用系统 diff 生成补丁 + 真 patch 二进制应用（CPR_PATCH_DIR 接缝钉 tmp）——应用/幂等跳过/冲突回滚/doctor 三态探测。

## Comments

- commit 9e2a21c：`probeUserPatches`（只读探测）+ `applyUserPatches`（只真打 pending，dry-run 失败的从不真打，无半截应用）+ upgrade 回滚抽成 `rollbackAfterFailedUpgrade`（健康门/补丁冲突共用）+ install/doctor 挂钩；接缝 `CPR_PATCH_DIR`/`CPR_PATCH_BIN`。
- **实现坑（两次迭代才修对，值得留档）**：① 纯新增型补丁打过后正向 dry-run 仍干净通过（patch 不查「要加的行已存在」，会加第二遍）——不能只看正向；② 反向 dry-run 也不可靠：**GNU patch 会自作主张翻转方向**（已打文件上正向自动 assume -R、原始文件上反向自动忽略 -R，四种方向组合全 exit 0）——退出码完全无法判方向。唯一可靠信号是输出标记：正向 dry-run 带 `Reversed (or previously applied)` / `Unreversed patch detected` = 已打。探测实现按标记判，配 `--batch`（永不交互提问）。
- 验证：`npm run typecheck` 0 错；`node --test` 153/153（新增 4 例：install 自动打+重跑幂等不重复、doctor 四态探测不改文件、冲突→自动回滚（npm 双装+旧版如实报打不上）、包未变时幂等跳过照常完成升级）。
- 没做的验证：真 systemd 上补丁后引擎的完整 e2e（发布前一次性 e2e 一并覆盖）；macOS 系统 patch 的消息措辞差异（BSD 系 patch 同源 GNU，标记词相同，experimental 口径内）。
