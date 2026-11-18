# Spec: policy 收回代码内（停掉用户配置文件加载）

**Status:** claimed
**日期:** 2026-11-18

## Problem Statement

工单 14（policy-as-code）把声明+策略放进了用户可写的 `policies/mine.ts`，由 PolicyStore 运行时加载（mtime 热重载、软链、`CPR_POLICY_FILE`）。对单用户系统这套机制偏重：软链、环境变量、启动/重载两套失败语义、`/api/policy` 观测口，全是为「用户不改代码改文件」付的复杂度税。用户拍板：先做简单，**配置写死在代码内**，改配置 = 改代码 = 发 release，走既有部署纪律。

## Solution

- `policies/mine.ts` → `lib/policy/mine.ts`，由 `main.ts` 静态 import；声明校验（validateConfig）在启动路径执行，坏声明拒绝启动（保留 Q2 语义）。
- 删除 `PolicyStore`（文件加载/mtime 热重载/lastError）、`PolicyMeta`、`PolicySource`、`DEFAULT_POLICY_FILE`、`/api/policy` 端点、`CPR_POLICY_FILE`。`resolveListenEndpoints` 移入 `lib/policy/config.ts`。
- `server.ts` 简化：`createGatewayServers(policy)` 直收实例（不再包 source），`attachPolicySource`/`snapshotsFor` 的实例重建逻辑、`policyTag()` 的 mtime 拼接一并退役（`routing_note` 记 `policy:...` 前缀）。
- `policies/default.ts` 模板随之退役（配置即代码，无「拷贝模板」动作）；仓库 `policies/` 目录消失。
- decide 契约保留（`{backend, model?}` | `'keep'` | `null`）——后续选路钩子的地基不动。
- 测试适配：loader 生命周期测试删除；`family-protocol-http` 的子进程注入从 `CPR_POLICY_FILE` 改为临时启动器脚本直传实例；`smoke-release.ts` 同理适配；`routing_note` 断言前缀跟进。

生产影响：零（线上仍跑旧 release 读 config.json）。未来上线清单简化为「发 release + unit ExecStart 改 `lib/main.ts`」，不再需要软链与 `CPR_POLICY_FILE`。
