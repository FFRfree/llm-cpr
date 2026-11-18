# 01 契约与鉴权：tenants 声明 + key→租户

Status: completed
Blocked by: (none)

## 验收

- [x] `contracts.ts` 有 `Tenant { name; key_env; backends?; models? }`；`GatewayConfig.tenants?`。
- [x] `policy/contract.ts`：`RouterPolicy.tenants?`；`DecisionCtx.tenant: string`（两个决策点都有）。
- [x] `policy/config.ts` 校验：tenants 数组时逐项必填 name/key_env、name 唯一、backends 引用必须是已声明 backend name、models 引用必须是已声明 model id；坏声明拒启动。
- [x] `http/server.ts`：Bearer 命中租户 key → 归属该租户；全不匹配 401；不声明 tenants 时 master key + 隐式 `default` 租户（行为不变）。
- [x] `main.ts` 启动行列出已声明租户名。

## Comments

- commit 51a0ad4（含 review 修复 amend）：契约/校验/鉴权落地；review 追加两项静态校验（name/key_env 非空字符串逐元素验串、同 key_env 双租户拒绝）与 createGatewayServers 运行期同 key 值 fail fast（缺 env 不拦启动）。
- 验证：`npm run typecheck` 0 错；`node --test`（tenants.test.ts 覆盖鉴权三态/兼容模式/凭据冲突拒启）；独立 review 用 probe.mjs 复现凭据冲突后由修复消解，隐式模式 authorized/masterKeyOf 与 v0.1.0 源码逐字节一致。
- 没做的验证：多 worker/多进程并发下的 env 竞态（本设计单进程、env 启动期定型，不构成面）。
