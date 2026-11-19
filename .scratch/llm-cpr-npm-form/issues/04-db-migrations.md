# 04 DB 迁移三件套（启动路径内建）

Status: ready-for-agent
Blocked by: 01

## 验收

- [ ] `PRAGMA user_version` + 有序步骤表：启动时逐版本升级；库版本高于代码期望 → 拒启动（fail-fast）。
- [ ] 基线步骤：把现 data.db 双表结构（含 tenant 列的既有 ALTER 套路）收编为版本化步骤，老库首次开库自动补齐。
- [ ] 迁移前自动备份：WAL checkpoint + 拷 `~/.cpr/backups/<时间戳>/` + integrity check（套 migrate-dbs.ts 原套路）。
- [ ] 启动日志报 schema 版本与执行步骤；迁移失败拒绝启动。
- [ ] 测试：旧 schema 库升级、同版本零动作、未来版本拒启、备份产物断言、失败中断不留半迁移库。

## Comments
