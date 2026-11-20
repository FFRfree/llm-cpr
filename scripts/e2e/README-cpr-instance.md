# README-cpr-instance.md — e2e 打样：llm-cpr 独立实例启动驱动

`cpr-instance.ts` 从 llm-cpr 的 `npm pack` 产物（源目录 = 仓根自身，或 `--worktree` 指定的工作树）启动一个完全独立的网关实例（pi → llm-cpr → 假上游链路的中间一环）。产物不 import 仓内代码，不读写 `~/.llm-cpr`，绝不调用 systemctl。

## 接口

```ts
import { startCprInstance, CprInstanceError, FORBIDDEN_PORTS,
         E2E_MODEL_ID, E2E_IDENTITY_HEADER, E2E_MASTER_KEY, E2E_MASTER_KEY_ENV } from './cpr-instance.ts';

const inst = await startCprInstance({
  repoDir: '/root/ffr-projects/llm-cpr',      // npm pack 源目录（仓根；run-scenarios 的 --worktree 可覆盖）
  ports: { infer: 41001, admin: 41002, upstreamA: 41003, upstreamB: 41004 },
  configDir: '<e2e 批次目录>/cpr-config',   // 调用方持有；拒绝 ~/.llm-cpr
  dataDir:   '<e2e 批次目录>/cpr-data',     // 调用方持有；自动预建
  readyTimeoutMs?: 20_000,                  // 健康轮询上限
  stopGraceMs?: 8_000,                      // SIGTERM 宽限
});
// inst: { pid, policyPath, entryPath, stdout, stderr, stopDetail, stop(): Promise<void> }
await inst.stop();
```

### `startCprInstance(options)` 流程

1. **端口断言**：四个端口任一命中 `{8740, 8741}` 即抛 `CprInstanceError` 拒绝启动（生产保留口）。
2. **npm pack**：在 `repoDir` 跑 `npm pack --json`，解包 tgz 到系统 TMPDIR 的 `cpr-e2e-pack-*`，校验包内 `package.json.files` 含 `core`、入口 `core/main.ts` 真实存在。
3. **写 policy.ts** 到 `configDir/policy.ts`（已对照 `core/policy/contract.ts`、`core/contracts.ts`、`policy.example.ts` 核实字段名）：
   - `backends`：`[{name:'be-a', family:'ocg', base_url:'http://127.0.0.1:<upstreamA>/v1', key_env:'CPR_MASTER_KEY', priority:1}, {name:'be-b', family:'ccg', base_url:'http://127.0.0.1:<upstreamB>/v1', key_env:'CPR_MASTER_KEY', priority:2}]`
   - `models`：`[{id:'test-model', backends:{ocg:'test-model', ccg:'test-model'}}]`
   - `listen/admin` 用传入的 infer/admin 端口；`identity_header:'x-session-id'`；`decide()` 恒 null（内置路由）。
   - 刻意不写 `import type { RouterPolicy }`：类型名触发模块解析需要装包，纯声明 + 引擎 `validateConfig` 运行期校验即可。
4. **env**：`CPR_CONFIG_DIR`、`CPR_DATA_DIR`、`CPR_MASTER_KEY=e2e-test-key`、`CPR_UNIT_NAME=e2e-cpr-test.service`（安全垫：万一走 systemctl 只指向不存在的 unit）；同时剔除 `CPR_FORWARD_PORT`、`CPR_ADMIN_PORT`、`CPR_ENV_FILE`、`CPR_NPM_SOURCE`，防宿主环境泄漏干扰。不写 `.env` 文件（密钥仅进程环境注入）。supervisor 形态（`startSupervisorInstance`）另钉 `CPR_APP_ROOT`（swap 载荷缺省）与 `CPR_REGISTRY_URL=http://127.0.0.1:9`（/api/version 现查 registry 钉死口，测试不依赖真实 registry）。
5. **spawn** `node <tmp>/package/core/main.ts`，cwd=包目录，stdout/stderr 全程收集。
6. **健康等待**：轮询管理口 `GET /api/route/status`（纯本地，不联网）→ 200 即就绪；候选备胎 `/api/version`（该端点会现查 npm registry，离线时慢，故只作备胎）。上限 20s，超时 SIGKILL 并把 boot 输出附在错误里。
7. **`stop()`**：SIGTERM → 等 `stopGraceMs` → SIGKILL 兜底；`stopDetail` 标明 `'sigterm-clean' | 'sigkill-fallback' | 'already-exited'`。实测 SIGTERM 即刻干净退出（~15ms）。

## 核实的配置加载路径（上游实现依据）

- `core/paths.ts`：`CPR_CONFIG_DIR` / `CPR_DATA_DIR` 接缝；未设时默认 `~/.llm-cpr`。
- `core/main.ts`：先读 `CPR_ENV_FILE`（默认 `configDir/.env`，存在才加载，只填缺失键）→ `import <configDir>/policy.ts`（无则退回包内 `core/policy/mine.ts`）→ `validateConfig` → `startGateway`。
- `core/policy/config.ts`：监听口可用 `CPR_FORWARD_PORT` / `CPR_ADMIN_PORT` 环境变量覆盖（本驱动已剔除，以 policy 声明为准）。
- `core/policy/contract.ts`：`backends[].{name,family,base_url,key_env}` 必填，family 仅 `ocg|ccg`；`models[].{id,backends}` 必填。

## 已验证

打样批次（/root/ffr-scratch/2026-11-20-cpr-policy-hot-reload/e2e/，selftest 留批次未进仓）真跑通过：`llm-cpr 0.4.0 — policy: <configDir>/policy.ts · sha256 5d3a27ac8f85` boot 行、`/api/route/status` 200、chat 请求透传到 be-a（`model=test-model`、`Authorization: Bearer e2e-test-key`、session 头在）、`stop()` 后 pid 消失（/proc 无条目）。

## 注意事项

- **启动期额度探活**：llm-cpr 会对每个 backend 发额度查询（ocg direct → `GET <base_url>/usage`）。假上游应容忍对该路径的 GET（404 也行，引擎按 degraded 容忍），且别把探活误当 chat 请求断言。
- 解包临时目录在系统 TMPDIR，`startCprInstance` 不清理（e2e 批次结束后可整体清批次目录；TMPDIR 条目 24h 自动老化）。
- 同机多实例：务必用互不冲突的端口（工具不做全系统占用检测，只做保留口断言）。
