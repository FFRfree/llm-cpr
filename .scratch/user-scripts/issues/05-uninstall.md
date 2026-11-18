# 05 — uninstall：红线是数据

**Status:** completed

**目标：** `scripts/cpr.ts uninstall`，能卸干净，但唯一不可逆的东西（数据库）永不静默删。

## 流程

1. `systemctl disable --now coding-plan-router`（在跑则先停；注入式测试同 04）。
2. 删 unit 文件 + `daemon-reload`。
3. 打印保留项与路径：`/root/.local/share/coding-plan-router/`（sessions.db、usage.db）、`/root/.config/coding-plan-router/`（.env）——明说「数据与密钥未动，确认不要再手动删或 `--purge`」。
4. `--purge`：删上述两目录前再确认一次（交互 y/N）。
5. clone 目录本身：默认不动，打印路径让用户自行删（rm 需用户明确点头的仓库铁律）。

## 验收

- 卸载后 `systemctl status` 查无此 unit；数据文件原样存在（测试断言 mtime/大小不变）。
- `--purge` 无确认不删；clone 目录任何情况下不被脚本删除。

## Comments

- 2026-11-18 落地（commit ce8bf5b）。实现差异：数据/密钥目录默认 `~/.config|~/.local/share/coding-plan-router`，可经 `CPR_CONFIG_DIR`/`CPR_DATA_DIR` 注入（测试隔离用）；`--purge` 删除前仍过一遍 confirm（非交互默认 N）。
- 验证：uninstall 三段用例（默认删 unit 留数据 / --purge 无确认不删 / --purge --yes 删且 clone 目录保留）全过；全量 119/119。
- 没做的验证：真实 systemd disable 未跑（stub 注入口径同 03）。
