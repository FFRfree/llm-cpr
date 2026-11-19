# 05 cpr.ts 重写为 npm 形态

Status: completed
Blocked by: 02, 03, 04

## 验收

- [x] install：Node 前提检查 → 建 `~/.cpr`（policy 模板、`.env` 随机 master key、tsconfig/package.json 指路）→ 用户级 unit（Linux `systemctl --user` + `loginctl enable-linger`；macOS LaunchAgent 输出标 experimental）→ 冒烟 → y/N 启动；幂等，重复执行报现状不重置用户文件。
- [x] upgrade：npm 装新版 → y/N 重启 → 健康检查（is-active 门），失败**自动装回旧版**并报原因；`cpr upgrade --to <版本>` 手动退版；clone 形态拒绝并指回 git 路线。
- [x] doctor：NODE/PKGROOT/MODE（clone|npm）/VERSION/npm 最新版现查/DB schema 版本/POLICY + NEXT 建议。
- [x] uninstall：停服务删 unit（用户级）；`~/.cpr` 永不静默删（`--purge` 显式确认）。
- [x] 测试：fixture 全接缝钉死（`CPR_SYSTEMCTL/CPR_LOGINCTL/CPR_NPM` stub + `CPR_HEALTH_DELAY_MS`），含升级失败自动回滚主线（npm install 写版本状态文件 + systemctl is-active 按版本判活联动）；真 systemd 一次性 e2e 按惯例现场构造、不进常驻套件。

## Comments

- commit f311bf1：cpr.ts 整体重写。要点：包根按脚本自身位置推算（`import.meta.url` 上一级，clone/npm/fixture 三态同构）——**弃 cwd 口径**；git 升级机器（fetch/ff-only/rebase/abort/脏拒绝）全部退役，dev clone 直接指回 git pull；`systemctl` 全部带 `--user`、永不 sudo；unit 模板 `WantedBy=default.target` + 显式传 `CPR_CONFIG_DIR/CPR_DATA_DIR`；install 默认冒烟 = 引擎自举（真 ~/.cpr policy/.env 验证 + 临时 DB + 0 端口等 admin listening 行），`CPR_SMOKE_CMD` 接缝保留给 fixture；upgrade 的 DB 备份不进 CLI——引擎启动路径的迁移三件套是单一来源（备份+校验已过独立 review），CLI 只负责换代码/重启/健康门。
- 实现坑（测试当场抓出）：fixture 必须跑**拷贝里的** cpr.ts 而不是仓里的原版——新版包根与 cwd 无关，跑原版会把 worktree 当包根（有 .git → 被判 clone）；clone 拒绝发生在查 registry 之前，npm 日志可能不存在，断言用容错读取。
- 验证：`npm run typecheck` 0 错；`node --test` 149/149（user-scripts 14 例：npm 形态 doctor ×2、install/幂等/uninstall ×2、upgrade ×5——含「新版起不来→自动装回 0.1.0→服务恢复」回滚主线与 `--to` 跳过 registry）。
- 没做的验证：macOS LaunchAgent 全链路（无真机，experimental 口径）；真 systemd 用户级一次性 e2e（发布 v0.2.0 前按惯例现场构造跑一轮，战果回填本票）。
