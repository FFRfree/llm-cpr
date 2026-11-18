# 1 — policy 收回代码内（停掉用户配置文件加载）

**Status:** completed

**目标：**撤销工单 14 的「用户 policy 文件运行时加载」机制——声明与策略写死在代码内，改配置 = 改代码 = 发 release；decide 契约保留。

## 落地（2026-11-18）

- `policies/mine.ts` → `lib/policy/mine.ts`，`main.ts` 静态 import 并 `new Mine()`；`validateConfig` 在启动路径执行，坏声明拒绝启动（保留 Q2 语义）。`policies/default.ts` 模板与 `config.example.json` 一并删除（配置即代码，无「拷贝模板」动作）。
- 删除 `lib/policy/loader.ts`（PolicyStore/mtime 热重载/lastError）、`PolicyMeta`、`PolicySource`、`DEFAULT_POLICY_FILE`、`/api/policy` 端点、`CPR_POLICY_FILE`；`resolveListenEndpoints` 移入 `lib/policy/config.ts`（连 portFrom）；identity_header/decide 校验并入 validateConfig；`LoadedPolicy` 接口删除。
- `server.ts` 去源化：`createGatewayServers(policy)` 直收实例；`attachPolicySource`、`snapshotsFor` 的实例重建逻辑（只为热重载存在）、`policyTag()` 的 mtime 拼接退役——`routing_note` 前缀固定为 `policy:`。
- `startGateway(policy: RouterPolicy, opts)` 必传实例；启动校验责任在 `main.ts`（startGateway 保持宽容口径，兼容测试直传）。

## 验收

- [x] `npm run typecheck` 通过；`node --test` 107/107 全绿（110 − 3 条 loader 生命周期/API 测试退役）。
- [x] `lib/main.ts` 真启动验证：`validateConfig(new Mine())` 通过、双口监听、快照缺凭据时按设计降级（HTTP 401 → priority 路由，非致命）。
- [x] `smoke-release.ts` 全步通过（启动、鉴权、模型列表、聊天转发、SSE 直通、route/status、账本、会话聚合、看板、数据落位）。
- [x] 子进程注入改造：`family-protocol-http` 改用临时 `launcher.mjs` 直传假 policy 实例（不再 `CPR_POLICY_FILE`）；`smoke-release.ts` 同理（并顺带修掉它滞留的 `CPR_CONFIG_FILE`/config.json 时代写法）。
- [x] 文档同步：README（快速开始、声明示例、`CPR_CONFIG_FILE`/`CPR_KEYS_ENV` 段落）、`docs/xdg-deployment.md`（分层表、路径推算、unit 备注）、仓库 `AGENTS.md`。

## Comments

- 2026-11-18：用户拍板「先做简单一点，不要加载用户配置」——热重载/软链/`CPR_POLICY_FILE` 全套机制退役；代价是改声明必须走发布流程，收益是少一整层加载失败语义。`mine.ts` 导出的是 class，默认 import 拿到的是类不是实例（PolicyStore 时代在加载器里 `new`），此坑在 gateway.test 的 tsc 报错中现形。
- 2026-11-18：**未上线**。生产仍跑 `20261116-252f723`（读 config.json 旧版），本次改动不触碰线上。未来上线清单简化为：发 release（`git archive HEAD lib static package.json`，声明已随 lib 打包）+ unit `ExecStart` 改 `lib/main.ts`，不再需要软链与 `CPR_POLICY_FILE`；旧 config.json 稳定一个周期后删。
- 2026-11-18：decide 契约（`{backend, model?}` | `'keep'` | `null`）与全部 decide 语义测试原样保留——后续选路钩子（choose/shouldMigrate）的地基不动。
