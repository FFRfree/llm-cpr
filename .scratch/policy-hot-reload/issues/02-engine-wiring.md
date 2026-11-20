# 02 引擎接线：server/main/events + 审计事件与备份

Status: ready-for-agent
Blocked by: 01

## 验收

- [ ] `events.ts`：EventKind 增 `policy.reload` / `policy.reload.error`；detail 类型扩 `trigger: 'file-change'|'manual'`、`from_hash`、`to_hash`、`reason`、`cold_changed`、`error`（路由事件的 trigger 联合不受影响）。
- [ ] `server.ts`：`CreateGatewayOptions.policyFile?`；启动定型物（declaredTenants/snapshots/capture/dbPath）继续用构造时捕获；每请求路径（forward handler、admin 读侧的 backends/models 读取）改 `reloader.current()`；forward 入口与管理口 reload 触发懒检查。
- [ ] 事件纪律：成功必落 `policy.reload`（trigger + 新旧 hash）；失败落 `policy.reload.error` 仅当内容签名是新的（同坏文件每请求重试不刷账）；文件删除只在「有 → 无」转换时报一次。
- [ ] 备份目录 = `path.dirname(dbPath)/backups/policy`（CPR_DATA_DIR 接缝随之成立）。
- [ ] `main.ts`：启动行 `llm-cpr <v> — policy: <source>` 行尾追加 ` · sha256 <前12>`（仅文件来源时；既有正则断言 `^llm-cpr …` / `/policy: .*policy\.ts/` 不受影响）；`policyFile` 下传 startGateway。
- [ ] 无 `policyFile`（builtin/测试直传）路径行为逐字节不变：不建 reloader 文件检查、无新事件。
- [ ] 快照轮询器 interval 仍是启动值（routing.snapshot_interval_ms 属冷区），行为与文档一致。

## Comments
