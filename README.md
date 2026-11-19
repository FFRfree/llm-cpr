# llm-cpr（原 coding-plan-router，2026-11-19 改名）

面向多份 coding-plan 订阅的 OpenAI 兼容路由网关：让 Hermes、Pi 等客户端共用一个入口，按会话和订阅用量分配请求。

## 为什么需要它

个人可能同时持有多个 OpenCode Go、CommandCode GOAT 等 coding-plan 订阅。每份额度都有周期和到期时间；只用一份容易提前耗尽，另一份则可能在周期结束时仍有余量。llm-cpr 将订阅纳入同一模型入口，尽量把用量均匀分摊到“落后于周期进度”的订阅，同时保留会话粘性，减少跨账号切换带来的缓存损失。

## 能力概览

- 一个 OpenAI Chat Completions 兼容入口，提供 `/v1/chat/completions` 与配置白名单 `/v1/models`。
- 多个 `ocg` / `ccg` 后端账号；每个模型可声明其在不同家族中的上游模型 ID。
- 会话身份命中后亲和到固定后端；新会话按“周期时间进度 − 已用进度”的欠账评分选择后端。
- 配额类错误（403 / 429）可改绑到其他兼容后端；已知窗口超限时不选该后端，额度未知时按优先级尝试，上游额外计费开关须自行关闭。
- 本机管理看板与只读 API；SQLite 审计记录请求元数据及用量，不保存请求正文。

## 要求

- Node.js **≥ 22.18.0**（使用内置 `node:sqlite` 和原生 `.ts` 类型擦除；不需构建或 TypeScript 运行时，无第三方运行依赖）。
- 对应 coding-plan 服务的有效订阅与 API 凭据。
- OpenCode Go 可配置为直连（`direct: true`）或通过兼容代理接入；两种方式的额度查询方式不同。

## 快速开始（普通用户）

前置：Node.js **≥ 22.18.0**（用内置 `node:sqlite` 和原生 `.ts` 类型擦除，零构建、零第三方依赖）+ 至少一份 coding-plan 订阅凭据。

1. 首装一条命令（Linux/macOS，全程免 sudo）：

   ```sh
   npx -y llm-cpr install
   ```

   它做四件事：npm 把引擎下载进固定位置 `~/.local/lib/llm-cpr/`（npm 只是下载器，代码住哪我们自己定，ADR-0009）；建命令软链 `~/.local/bin/cpr`；在你的用户目录建 `~/.llm-cpr/`（policy 模板 + 随机 master key 的 `.env`，已 chmod 600）；写用户级 systemd unit、自举冒烟通过后启动。macOS 走 LaunchAgent（experimental）。
2. 编辑 `~/.llm-cpr/policy.ts`——配置即代码：订阅声明与路由策略就在这个 TS 类里（`name` 定了绝不改，写法见 [docs/policy-guide.md](docs/policy-guide.md)）；上游凭据按 `key_env` 名填进 `~/.llm-cpr/.env`。改完 `systemctl --user restart llm-cpr` 生效。
3. 客户端配 OpenAI 兼容地址 `http://127.0.0.1:8741/v1`，API key 用 `.env` 里 `CPR_MASTER_KEY` 的值；请求带 `Authorization: Bearer ***`。
4. 打开看板 `http://127.0.0.1:8740/` 看额度与会话；`cpr doctor` 随时体检。

`.env` 示例（占位值不是可用凭据）：

```dotenv
CPR_MASTER_KEY=replace-with-a-long-random-secret
CPR_UPSTREAM_KEY=replace-with-your-provider-api-key
# 可选：开发或非默认端口；默认转发 8741、管理 8740
# CPR_FORWARD_PORT=8741
# CPR_ADMIN_PORT=8740
```

声明形状（`~/.llm-cpr/policy.ts` 从模板生成，不用写 JSON；完整真实示例看包内 `core/policy/mine.ts`）：`master_key_env`、`listen`/`admin` 端口、`backends[]`（`name`/`family`/`alias`/`base_url`/`key_env`）与 `models[]`（对客户端公开的统一 `id` → 各家族真名映射）。

`backends[].alias` 是可选的看板显示名：后台各处（订阅卡标题、汇总、钉住会话、请求明细）优先显示它，家族一律用全名 `OpenCode Go` / `CommandCode GOAT`，卡片脚注保留内部名 `name` 便于对日志。不配 `alias` 时显示内部名。

`base_url` 是上游 URL 前缀，网关会在其后追加 `/v1/chat/completions`；例如 CCG 的 `/provider` 前缀，最终请求路径为 `/provider/v1/chat/completions`。`CPR_FORWARD_PORT`、`CPR_ADMIN_PORT` 可在启动时覆盖声明里的端口。路由监听默认仅绑定 `127.0.0.1`；管理口固定绑定回环地址。不要将管理口直接暴露到公网。改声明 = 改代码，须走发布流程（`npm run typecheck` + `node --test` + 假上游冒烟 + release 切换）。生产部署路径与数据库隔离方式见 [`docs/deployment.md`](docs/deployment.md)。

开发启动：

```sh
set -a
. ./.env
set +a
node core/main.ts
```

客户端配置为 OpenAI 兼容地址 `http://127.0.0.1:8741/v1`，API key 使用 `CPR_MASTER_KEY` 的值。请求需带 `Authorization: Bearer …`。例如：

```sh
curl -H "Authorization: Bearer $CPR_MASTER_KEY" \
  http://127.0.0.1:8741/v1/models
```

## 安装 / 升级 / 卸载（cpr 命令）

安装、升级、卸载全部由 `cpr` 命令代劳；位置纪律：用户资产住 `~/.llm-cpr`，代码住 `~/.local/lib/llm-cpr`（版本目录 + `current` 软链），命令软链 `~/.local/bin/cpr`，unit 住 systemd 用户级抽屉（ADR-0009）。

```sh
cpr doctor                 # 只读体检：NODE/MODE/VERSION/APPROOT/BIN/UNIT/DB/POLICY/PATCH + NEXT 建议
cpr upgrade                # 升级：npm 下载新版目录 → 打用户补丁 → 临时库冒烟 → 软链切换 → 健康门
cpr upgrade --to <版本>     # 手动升/退到指定版本（不查 registry）
cpr uninstall              # 停服务、删 unit/命令软链/代码安装区；~/.llm-cpr 永不静默删（--purge 显式确认）
```

升级语义：下载到**独立版本目录**（current 与服务全不动）→ 补丁/冒烟全过才翻转 `current` 软链 → 重启 + is-active 健康门；任何一步失败，`current` 拨回上一版目录——**零网络、瞬时**，你的数据在 `~/.llm-cpr` 里一动不动。版本目录保留当前+上一版垫背，更老的升级成功后自动清。数据库备份与迁移内建在引擎启动路径（`core/store/migrate.ts`：迁移前 WAL checkpoint + `~/.llm-cpr/backups/<时间戳>/` + integrity check），CLI 不重复做。

启动日志第一行报当前版本（`llm-cpr <版本> — policy: ~/.llm-cpr/policy.ts|内置 mine`），随时核对「磁盘版本 = 运行版本」。

## 引擎开发者（clone 轨道）

```sh
git clone <仓库地址> llm-cpr && cd llm-cpr
node scripts/cpr.ts install    # 同款用户级服务，但代码直接跑 clone（开发迭代用）
node scripts/cpr.ts doctor
```

clone 的升级不走 `cpr upgrade`（那是 npm 安装形态的通道）：`git pull` 后自行验证 `npm run typecheck` + `node --test` + `node scripts/xdg-deploy/smoke-release.ts`，再 `systemctl --user restart llm-cpr`。clone 里改引擎代码、npm 用户改 policy/补丁——两条轨道互补不互斥。

## 路由行为

1. **会话亲和**：识别统一会话头（默认 `x-session-id`——OpenRouter/opencode/AWS AgentCore 的业界通用名，可在 `identity_header` 配置），已有映射优先复用原后端，避免缓存前缀因换账号失效。
2. **欠账评分**：新身份在模型可用的后端中，按周期时间进度减已用进度选择；落后于日历进度的订阅优先获得新请求。窗口额度和快照可用性也会影响候选资格。
3. **撞墙改绑**：遇到符合条件的 403 / 429 配额错误时，尝试将会话改绑到另一可用后端并更新映射；改绑有冷却保护。流式响应开始后不会静默重试。**长会话例外**：请求轮数达到 `routing.long_session_min_requests`（默认 10，0 关闭）的会话不做额度改绑——换后端会作废上游 prompt cache，此时原样透传错误（含 `retry-after`），由客户端稍后重试原后端。
4. **窗口满时挡住**：新会话的候选后端全部处于已知超限窗口时返回错误。快照未知或过期时可能仍向上游尝试；网关无法保证上游不会使用额外付费额度，应在订阅服务侧关闭额外计费。

`routing.snapshot_interval_ms`（默认 300000，即 5 分钟）控制额度快照轮询间隔；管理口 `POST /api/snapshots/refresh` 可随时手动触发一轮刷新（看板「刷新快照」按钮走同一通道）。

## 看板与管理 API

默认看板：`http://127.0.0.1:8740/`（等同 `/dashboard`）。管理接口仅供本机/受控反向代理访问，不带公网访问认证层；不要直接公开管理端口。

本机实际部署：看板走专用域名 **`https://hermes-llm-router.ffrfree.xyz/`**（nginx 站点
`/etc/nginx/sites-available/hermes-llm-router.ffrfree.xyz` → Authelia SSO `auth_request` →
`127.0.0.1:8740`，监听 8443 回源口；DNS 由 `*.ffrfree.xyz` 通配 + Cloudflare Origin Rule
`hermes-*` → 8443 覆盖，无需单独解析记录）。旧的临时反代域名
`hermes-proxy-8740.ffrfree.xyz` 已于 2026-11-16 移出白名单，不再使用。

- `GET /api/route/status`：后端状态、额度快照与身份映射概况。
- `GET /api/snapshots`：额度快照。
- `POST /api/snapshots/refresh`：手动触发一轮额度快照刷新并返回结果（管理口唯一写操作）。
- `GET /api/audit/requests`：请求审计列表，可用 `limit`、`identity` 查询参数筛选。
- `GET /api/audit/sessions`：会话汇总。
- `GET /api/audit/summary`：整体汇总；传入 `identity` 时返回该会话汇总及请求。各订阅含性能字段：`avg_ttft_ms`（首字节平均延迟）与 `tps`（按 Σtokens/Σstream_ms 加权的吐字速度，仅流式请求计入）。

管理口仅支持刷新额度快照这一写操作，其他管理接口为只读。需要远程查看时，请先通过 VPN/SSH 隧道，或按 [本机部署与 SSO 看板接入](docs/local-deployment.md) 配置可信认证代理。

## 测试与开发

```sh
npm ci              # 只安装锁定的开发依赖：TypeScript / Node 类型
npm run typecheck   # 项目本地 tsc --noEmit；strict + erasableSyntaxOnly
npm test            # 等同 node --test
```

生产仍用 `node core/main.ts`，不用编译或安装开发依赖；若用 npm 安装生产环境，可用 `npm ci --omit=dev`。`package-lock.json` 固定开发工具链，不依赖全局 `tsc`。

测试只用公开配置、真实本机 HTTP、假凭据和可丢弃数据库，包含 main 入口、两家族会话头/额度端点、JSON/SSE 原字节透传、路由亲和与改绑、审计/看板，以及超时/取消/流式缓冲上限回归。不要连接生产账号、读取真实凭据或请求真实上游。`type-tests/` 只用于编译期正负类型契约，刻意放在 Node 测试自动发现目录之外。

### 渐进类型化与模块职责

- `core/providers/opencode.ts` / `commandcode.ts` 是同一 `ProviderAdapter` 的两个真实实现：负责各家的会话头和 quota read。OCG 保留直连 `/usage`（浏览器 UA + 订阅 key）与代理 route-status（管理 key + `account` 匹配）；CCG 读取三个 `/alpha` 额度端点。`providers/index.ts` 集中注册家族，不把家族分支放进路由核。
- `core/protocols/chat-completions.ts` 是具体 Chat 实现：入口匹配、上游路径拼接、模型重映射、透明保留其他请求字段、JSON/SSE 用量观察。256 KiB 的有界旁路只供审计，不重写响应字节。
- `core/contracts.ts` 类型覆盖后端身份/模型映射、会话身份、HTTP headers、额度窗口/快照，以及 provider/protocol 输入输出；第三方 JSON 从 `unknown` 检查后读取，不用 `any` 假装已验证。用量对象仍是开放字段集，token 数值与 cache 字段的校验继续由原审计层负责。
- `server.ts` 继续负责 HTTP 生命周期、超时、取消、选路、亲和、重试、改绑与事件账；`snapshots.ts` 继续负责轮询、去重、过期与降级状态，只将获取各家额度委托给 provider。没有改变持久化 schema、订阅 `name`、重试阈值或改绑策略。
- 无会话头时，OCG 上游 session 使用路由已经解析的 fingerprint（无可指纹化消息时用 address），使上游缓存键与亲和/审计身份一致；有效统一头仍优先，旧 `x-opencode-session` 仍兼容，空统一头不覆盖有效旧头。CCG 不接收这两种会话头。

全仓 TypeScript：`core/`、`test/`、`scripts/` 下只有 `.ts`，Node 原生类型擦除直接运行，没有构建步骤也没有运行时依赖。`npm run typecheck` 对这三处全部做 strict 静态检查；`type-tests/` 只放编译期正负类型契约，刻意放在 Node 测试自动发现目录之外。类型不代替运行时校验：配置、上游 JSON 与 SQLite 行仍从 `unknown` 检查后读取。

未来 Responses/Messages 应作为 `core/protocols/` 下独立的具体模块，先验证协议能力、状态归属、流事件和 usage 再接入路由；目前 `/v1/responses`、`/v1/messages` 仍返回 404，没有空适配器、跨协议转换或虚构能力声明。

## 安全与数据

- `.env`、密钥及真实上游凭据不得提交；示例中的 key 仅为占位符。
- 路由端口默认回环监听；管理口只监听回环。生产部署应由服务管理器注入环境变量，避免将密钥写在命令行参数中。
- SQLite 数据库包含路由身份、模型、状态和用量等元数据；数据库文件可能含敏感使用记录，应限制文件权限并纳入本机备份/保留策略。
- 本项目不保存推理请求正文；仍应按敏感运行数据保护数据库和日志。
- 生产接入 Hermes 或其他客户端前，请单独审核模型白名单、后端映射、密钥管理和反向代理配置。

## 本机部署

需要让可信用户远程查看管理看板时，可在路由器所在主机用 Nginx 反向代理管理端口，并通过现有 SSO 的 `auth_request`/等价认证子请求先行鉴权。管理端口仍只绑定 `127.0.0.1`；反向代理只代理看板及必要的只读 `/api/` 路径，不代理推理入口、不直通 Node 服务的非管理端口。完整部署思路见 [docs/local-deployment.md](docs/local-deployment.md)。

## 许可

尚未指定。发布前请补充项目许可证及版权信息。
