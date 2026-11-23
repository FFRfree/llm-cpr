# 砍掉 identity address 兜底：无可解析身份本地 400 拒绝

2026-11-23 用户拍板（对话）：identity 解析收窄为两级——①统一会话头（x-session-id / 老 x-opencode-session）→ kind 'session'；②body.messages 可指纹化（数组且含 user 消息）→ sha256(system+首条 user) → kind 'fingerprint'。两级皆不可得 → 网关本地 400 拒绝，不转发、不落账本、不写 system_events、不走 capture。

## 动机

- OCG 上游强制 `x-opencode-session` 头（identity 是它的供值源），无身份请求转发过去也是死。
- 生产几个月 address 身份仅 2 行垃圾流量，兜底没有存在价值。

## 方案

- `core/contracts.ts`：`Identity.kind` 收窄为 `'session' | 'fingerprint'`。
- `core/store/identity.ts`：`resolveIdentity` 返回 `Identity | null`，删 address 分支；`IdentityQuery` 去掉 `remoteAddress`（IP 不再参与解析）。fingerprint 分支逻辑原样保留（messages 非数组/空数组/无 user 消息 → null）。
- `core/http/server.ts`：resolveIdentity 返回 null → 沿用既有本地 400 路径（同 readBody 413 / model not allowed 的 `span.suppress(); return json(res, 400, …)` 写法），任何后续动作（亲和事件、账本 INSERT、capture、上游转发）都不发生。
- `core/providers/opencode.ts`：`context.identity?.key` 兜底不变（null 在转发前已被 400 拦住，类型链自然收窄），注释去掉 address 表述。
- 存量 DB 行（requests.identity_kind / system_events.identity_kind / capture identity_kind）仍可能带 'address'，不做迁移，展示与查询照旧（GLOSSARY 口径：进 `.archive/` 式退役，不清洗历史）。

## 交付面

`core/contracts.ts`、`core/store/identity.ts`、`core/http/server.ts`、`core/providers/opencode.ts`、`test/identity.test.ts`、`test/family-protocol-http.test.ts`、`GLOSSARY.md`、`README.md`。

## 边界（不做）

- npm 发版 / 生产 release / 重启服务 / `~/.local/lib` 与 `/root/.llm-cpr` 部署（另行逐次授权）。
- 存量 address 行的数据迁移。
