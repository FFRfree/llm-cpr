# 03 管理口 API：GET /api/policy + POST /api/policy/reload

Status: ready-for-agent
Blocked by: 02

## 验收

- [ ] `GET /api/policy`（只读）：`{ source, sha256, loadedAt, reloads, failedReloads, lastError, lastErrorAt, lastColdChanged }`；无 policyFile 时 source 为包内 mine.ts 标识、reload 恒 unchanged。
- [ ] `POST /api/policy/reload`：同步执行懒检查（trigger=manual），返回 `{ outcome, status }`；outcome ∈ reloaded / unchanged / kept。
- [ ] 更新管理口「唯一写操作」注释为两个写操作；`/api/events` 的 kind 过滤白名单自动覆盖新 kind（EVENT_KINDS 集合同步）。
- [ ] 事件 trigger='manual' 与文件拾取可区分（测试断言）。

## Comments
