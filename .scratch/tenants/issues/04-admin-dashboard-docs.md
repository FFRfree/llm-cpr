# 04 管理口 + 看板 + 文档 + 生产声明

Status: completed
Blocked by: 03

## 验收

- [x] `/api/audit/requests|sessions|summary|sessions/{id}` 接受 `?tenant=`；`/api/route/status` 返回 `tenants` 清单。
- [x] dashboard：租户下拉（仅 >1 租户时显示），sessions/summary/明细按所选租户传参；mappings 行按租户分列。
- [x] `mine.ts` 声明 main + hermes 两租户（不限池、不限模型）。
- [x] docs/policy-guide.md ctx 铁律加 `tenant`；GLOSSARY 加 Tenant 词条；ADR-0007 立案（租户=记账/选路维度而非额度隔离，及「声明 tenants 即弃用 master_key_env 鉴权」取舍）。
- [x] test/tenants.test.ts 覆盖：鉴权三态、亲和隔离、记账带 tenant、ctx.tenant、backends 子集、models allowlist、旧库迁移、无声明兼容、validateConfig 坏声明。

## Comments

- commit 51a0ad4（含 review 修复 amend）：管理口 `?tenant=` 与 status tenants 清单落地；看板下拉/行租户标注/script 语法经 vm.Script + node --check 双检（review 复验 PASS）；review 追加 summary?identity= 范围一致性修复与回归测试。
- 验证：`npm run typecheck` 0 错 + `node --test` 136/136；admin-dashboard/family-protocol 既有断言随 mappings 形状（+tenant）同步更新。
- 没做的验证：看板在真实浏览器的人肉过版（部署后用户打开看板即见；语法/结构已机器验证）。生产 mine.ts 生效与 Hermes 换 key 属部署步骤，单独授权后进行。
