# 05 — uninstall：红线是数据

**Status:** ready-for-agent

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
