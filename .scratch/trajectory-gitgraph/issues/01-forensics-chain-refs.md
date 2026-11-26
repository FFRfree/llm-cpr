# 01 cacheChain 条目带 refs

Status: completed

链条目补 `refs: string[]`（盐化消息哈希，与 turns/:id 的 refs 同源）。轨迹页前端凭单次
取证调用即可建前缀树，不再逐轮拉正文。CacheChainEntry 类型 + cacheChain 组装同步加字段；
admin 的 /api/capture/cache-forensics 原样透传（返回值整体序列化，无需改 admin 层）。

## Acceptance
- [x] chain 条目含 refs，且相邻轮次 refs 前缀关系与 common_prefix 结论一致（observability.test.ts 扩展断言）

## Comments
- 验证：node --test packages/core/test/observability.test.ts 13/13（含新增 refs 断言：轮次 2 前 2 条哈希与轮次 1 一致）。
- 没做的验证：未对 500 轮上限的大会话量响应体积做基准（本地真数据 204 轮 forensics 响应约 4MB，页面可接受；超大会话如卡再议分页）。
