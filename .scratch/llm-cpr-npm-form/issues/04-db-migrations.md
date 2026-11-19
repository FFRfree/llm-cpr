# 04 DB 迁移三件套（启动路径内建）

Status: completed
Blocked by: 01

## 验收

- [x] `PRAGMA user_version` + 有序步骤表：启动时逐版本升级；库版本高于代码期望 → 拒启动（fail-fast）。
- [x] 基线步骤：现 data.db 双表结构（含 tenant 列的既有 ALTER 套路）收编为 `applyBaseline`（幂等，openDatabase 每次开库执行），版本机 `runMigrations` 在 server 启动时标记版本。
- [x] 迁移前自动备份：WAL checkpoint(TRUNCATE) + 拷 `<库目录>/backups/<时间戳>/` + integrity_check（存量库才备份，新库跳过）。
- [x] 启动日志报 schema 版本与执行步骤；迁移失败拒绝启动。
- [x] 测试：旧 schema 库升级、同版本零动作、未来版本拒启、备份产物断言、步骤失败事务回滚。

## Comments

- commit 0ebe449：`core/store/migrate.ts` 新增。分工设计：加法类（SCHEMA/补列/索引）留 `applyBaseline` 幂等路径（openDatabase 开库即跑，保住 audit.ts dbFile 自开库与五个直连测试的既有行为）；非幂等重活（搬数/换表）走步骤表，每步一个事务、完成即写 user_version，中断可续；`targetVersion`/`steps` 测试接缝让步骤执行路径在 SCHEMA_VERSION=1 时代就可测。
- 坑（实现中踩到并修掉）：fresh 判定不能看「表存在」（openDatabase 开库即建表）——改看 requests 行数；手搭旧库夹具必须带全非 ALTER 管的列（baseline 的看板索引引用 total_tokens 等）。
- 验证：`npm run typecheck` 0 错；`node --test` 146/146（新增 test/migrate.test.ts 6 例）。
- 没做的验证：本机生产 data.db（user_version=0、1100+ 行）首次跑 v0.2.0 时会走「upgraded + 备份」路径——属阶段 3 生产切换时实测。
- **独立 review 六项修正（3a46ab2，探针复验通过）**：P1 备份的 checkpoint busy 被忽略 + integrity 查的是源库而非备份产物 → busy 即拒迁、备份副本自开只读连接校验；P2 基线 DDL 原在 openDatabase 里跑（备份先被补列污染、未来版本拒启前已动结构）→ `openDatabase({baseline:false})` + 基线成为迁移步骤 1（`STEPS[0]`，下标=版本-1），直连入口默认 baseline:true 保持旧测试行为；P2 fresh 判定漏 system_events 决策账 → 两本账行数都查。回归面 8 例全钉进 test/migrate.test.ts（含「备份原貌未补列」「拒启不碰结构」「backups 受阻库原样」三个修正点断言）。
