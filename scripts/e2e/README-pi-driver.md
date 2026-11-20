# README-pi-driver.md — e2e 打样：pi coding agent 无头驱动

`pi-driver.ts` 锁版本安装 pi coding agent 并无头驱动它，把模型请求打到 llm-cpr 推理口。产物不 import 仓内代码，不读写 `~/.llm-cpr` / `~/.hermes` / `~/.config`。

## 包名与版本（现查结论）

- **CLI 包名 = `@mariozechner/pi-coding-agent`，锁定 `0.73.1`，bin 名 `pi`**。
- 文档线索里的 `@mariozechner/pi` 是**另一个包**（vLLM pods 管理工具，bin `pi-pods`）——安装时千万别装错。

## 接口

```ts
import { ensurePiVendor, runPi, PI_PACKAGE, PI_VERSION } from './pi-driver.ts';

// ① 安装（一次装好后续复用；版本一致则跳过 npm install）
const vendor = await ensurePiVendor('<e2e>/pi-vendor');   // vendor.binPath, vendor.version

// ② 无头跑一问
const result = await runPi({
  inferPort: 41001,              // llm-cpr 推理口
  model: 'test-model',           // 必须与 llm-cpr policy.ts 声明的 models[].id 一致
  sessionId: 'e2e-sess-001',     // 写进 x-session-id 头（llm-cpr 会话亲和键）
  prompt: 'say hi',
  cwd: '<e2e 批次目录>/pi-cwd',      // 自动 git init（pi 要求 git 仓）并自动 mkdir
  homeDir: '<e2e 批次目录>/pi-home', // HOME 重定向，pi 一切 ~/.pi 状态隔离在此
  timeoutMs?: 120_000,           // 超时 SIGKILL
  provider?: 'e2e-cpr',          // models.json 里的 provider 键名，默认 e2e-cpr
});
// result: { exitCode, events(JSON 事件对象数组), rawLines(JSONL 原始行), finalText, stderr, timedOut }
```

### `runPi` 内部做了什么

1. **HOME 隔离**：spawn 时 `HOME=homeDir`，写 `homeDir/.pi/agent/models.json`：
   ```json
   { "providers": { "e2e-cpr": {
       "baseUrl": "http://127.0.0.1:<inferPort>/v1",
       "api": "openai-completions",
       "apiKey": "e2e-test-key",
       "headers": { "x-session-id": "<sessionId>" },
       "models": [ { "id": "test-model", "reasoning": false, "contextWindow": 128000, "maxTokens": 4096 } ] } } }
   ```
   字段契约对齐 pi 包内 `docs/models.md`：`baseUrl` 必须 `/v1` 结尾；`apiKey`/`headers` 支持字面量值；`api: openai-completions` 兼容性最好。
2. **cwd**：`mkdir -p` + `git init -q`（已是 git 仓则静默跳过）。
3. **spawn**：`pi --print --mode json --provider e2e-cpr --model <model> --offline --no-session <prompt>`（prompt 以 `-` 开头时前置空格防被吃成 flag）。
4. **收集**：stdout 逐行解析 JSONL 事件（pi `--mode json` 契约见 pi 包内 `docs/json.md`：首行 `{type:'session',...}`，随后 `agent_start/turn_start/message_start/message_update/message_end/turn_end/agent_end` 等）；stderr 原文保留；默认 120s 超时 SIGKILL。
5. **finalText**：最后一条 `message_end` 且 `message.role==='assistant'` 的 `content[].text` 拼接。

## 首次跑通的坑（实测）

- **`--provider` 必须显式指到 models.json 里的自定义 provider 名**。pi 默认 provider 是 `google`，不指就会去连 Google 而不是我们的 baseUrl。
- **`--offline`** 关掉启动期联网检查，避免 e2e 跑外网。
- **`--no-session`** 让 pi 不落 session 文件，纯无头一次性问答；`sessionId` 参数与 pi 会话无关，它只进 `x-session-id` 头给 llm-cpr 做亲和。
- HOME 重定向后 pi 完全不碰真实 `~/.pi`；首次运行无需任何交互式初始化/auth.json，models.json 里的字面量 `apiKey` 即认证。
- 超时杀掉时 `exitCode=null, timedOut=true`；pi 启动失败（如 cwd 不存在）现在会抛带原因的 Error 而非静默 ENOENT。

## 已验证（selftest 真跑证据）

- pi 首行：`{"type":"session","version":3,"id":"01a1f841-...","timestamp":"2026-11-20T09:20:07.962Z","cwd":".../pi-cwd"}`
- 最后 assistant message_end（截断）：`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi there, e2e ok"}],"api":"openai-completions","provider":"e2e-cpr","model":"test-model",...}}`
- `finalText = "hi there, e2e ok"`（非空）；上游侧同时收到 `model=test-model`、`Authorization: Bearer e2e-test-key`、session 头在。

## 注意事项

- `pi-vendor/` 落在套件目录自身（`<仓根>/scripts/e2e/pi-vendor/`，约百个包）：**不进仓**（.gitignore 排除）、不进 npm 包（files 白名单不含），套件首跑时 `ensurePiVendor` 自动 `npm install` 锁定版（需网络，约 1-2 分钟）；换版本改 `PI_VERSION` 常量即可，`ensurePiVendor` 会自动重装。
- `runPi` 每次调用会读一次 vendor 的 package.json 核对版本，正常路径零网络零安装。
- 多路并发 `runPi`：homeDir/cwd 各自独立即可，pi 无全局锁；llm-cpr 侧建议不同 `sessionId` 以免亲和串线。
