# 01 无可解析身份 → 本地 400；Identity.kind 收窄两级

Status: completed
Blocked by: (none)

## 验收

- [x] `resolveIdentity` 返回 `Identity | null`，address 分支删除，`remoteAddress` 退出 `IdentityQuery`；fingerprint 分支行为不变。
- [x] `Identity.kind` 联合类型收窄为 `'session' | 'fingerprint'`（contracts.ts）。
- [x] `server.ts`：identity 为 null → 本地 400（`invalid_request_error`），不转发、不落 requests、不写 system_events、不走 capture。
- [x] `opencode.ts` requestHeaders 兜底链注释与实现核对：null 不会流到转发路径。
- [x] 测试：identity.test.ts 改写 address 用例为 null 断言（含 messages 非数组/空/无 user 五种不可解析形态）；family-protocol-http.test.ts 删 `[{}, '127.0.0.1']` address 用例，新增「无会话头 + 无 messages → 400 且 requests 与 system_events 零新增、上游零转发」用例。
- [x] 文档：GLOSSARY.md Identity 词条改两级口径；README.md OCG session 表述同步。

## Comments

- 验证：`npm run typecheck` 0 错；`node --test` 全量 220/220 绿（worktree 分支与合并后 master 各跑一遍）。
- commit 53bef47（分支 no-identity-reject）→ merge 20fa80d，master 已推 origin（184a61f..20fa80d）。
- 没做的验证：未对存量生产 DB 做迁移演练（本票明确不做数据迁移，历史 address 行查询路径未动）。
- 意外改动面：8 个既有测试依赖 address 兜底（无头无 messages 期待 200）——capture.test.ts shape guard 改口径为「本地 400 不捕获」，gateway/numeric-time/family-protocol SSE 用例补会话头，routing-score 默认体补 user 消息；均保留原测试意图。
