# 02 引擎接线：server/main/events + 审计事件与备份

Status: completed
Blocked by: 01

## 验收

- [x] `events.ts`：EventKind 增 `policy.reload` / `policy.reload.error`；detail 类型扩 `trigger: 'file-change'|'manual'`、`from_hash`、`to_hash`、`reason`、`cold_changed`、`error`（路由事件的 trigger 联合不受影响）。
- [x] `server.ts`：`CreateGatewayOptions.policyFile?`；启动定型物（declaredTenants/snapshots/capture/dbPath）继续用构造时捕获；每请求路径（forward handler、admin 读侧的 backends/models 读取）改 `reloader.current()`；forward 入口与管理口 reload 触发懒检查。
- [x] 事件纪律：成功必落 `policy.reload`（trigger + 新旧 hash）；失败落 `policy.reload.error` 仅当内容签名是新的（同坏文件每请求重试不刷账）；文件删除只在「有 → 无」转换时报一次。
- [x] 备份目录 = `path.dirname(dbPath)/backups/policy`（CPR_DATA_DIR 接缝随之成立）。
- [x] `main.ts`：启动行 `llm-cpr <v> — policy: <source>` 行尾追加 ` · sha256 <前12>`（仅文件来源时；既有正则断言 `^llm-cpr …` / `/policy: .*policy\.ts/` 不受影响）；`policyFile` 下传 startGateway。
- [x] 无 `policyFile`（builtin/测试直传）路径行为逐字节不变：不建 reloader 文件检查、无新事件。
- [x] 快照轮询器 interval 仍是启动值（routing.snapshot_interval_ms 属冷区），行为与文档一致。

## Comments

- commit b390782 + 712f0d0：接线与审计事件落地；review 探针 probe2 复跑：慢 import 并发 4 调用者 → policy.reload 事件恰 1 条（P2-1 修复生效）、坏文件请求 21ms 即 200 保旧。
- 验证：全量 `node --test` 202/202（186 旧全数未变行为 + 新增 16）；builtin 直传实例零行为断言（不 stat、无事件）在 test/policy-reload.test.ts。
- 没做的验证：多 worker/多进程共享文件签名的竞态（单进程设计，不构成面）。
