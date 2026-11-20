# 03 管理口 API：GET /api/policy + POST /api/policy/reload

Status: completed
Blocked by: 02

## 验收

- [x] `GET /api/policy`（只读）：`{ source, sha256, loadedAt, reloads, failedReloads, lastError, lastErrorAt, lastColdChanged }`；无 policyFile 时 source 为包内 mine.ts 标识、reload 恒 unchanged。
- [x] `POST /api/policy/reload`：同步执行懒检查（trigger=manual），返回 `{ outcome, status }`；outcome ∈ reloaded / unchanged / kept。
- [x] 更新管理口「唯一写操作」注释为两个写操作；`/api/events` 的 kind 过滤白名单自动覆盖新 kind（EVENT_KINDS 集合同步）。
- [x] 事件 trigger='manual' 与文件拾取可区分（测试断言）。

## Comments

- commit b390782 + 712f0d0：GET /api/policy 与 POST /api/policy/reload（响应 {outcome, status}）落地；trigger=manual 与 file-change 可区分（测试断言）。review 探针 probe2 ③ 核对 lastTrigger=最近一次生效换新（P3-5 修复后口径）。
- 验证：test/policy-reload.test.ts manual/builtin 两例 + review 探针；管理口仍只绑 127.0.0.1（review 核对项）。
- 没做的验证：看板前端未接新端点（本批不含 UI 改动，状态走 /api/events 时间线可看）。
