# coding-plan-router

面向多份 coding-plan 订阅的 OpenAI 兼容路由网关：让 Hermes、Pi 等客户端共用一个入口，按会话和订阅用量分配请求。

## 为什么需要它

个人可能同时持有多个 OpenCode Go、CommandCode GOAT 等 coding-plan 订阅。每份额度都有周期和到期时间；只用一份容易提前耗尽，另一份则可能在周期结束时仍有余量。coding-plan-router 将订阅纳入同一模型入口，尽量把用量均匀分摊到“落后于周期进度”的订阅，同时保留会话粘性，减少跨账号切换带来的缓存损失。

## 能力概览

- 一个 OpenAI Chat Completions 兼容入口，提供 `/v1/chat/completions` 与配置白名单 `/v1/models`。
- 多个 `ocg` / `ccg` 后端账号；每个模型可声明其在不同家族中的上游模型 ID。
- 会话身份命中后钉死后端；新会话按“周期时间进度 − 已用进度”的欠账评分选择后端。
- 配额类错误（403 / 429）可迁移到其他兼容后端；全员不可用或超限时失败关闭，不会自动烧额外额度。
- 本机管理看板与只读 API；SQLite 审计记录请求元数据及用量，不保存请求正文。

## 要求

- Node.js 22 或更新版本（使用内置 `node:sqlite`，无第三方运行依赖）。
- 对应 coding-plan 服务的有效订阅与 API 凭据。
- 若使用 OCG，先运行可访问的 OpenCode Go 代理；该后端地址填代理的 OpenAI 兼容 API 地址，不要直接复制其他部署的账号凭据。

## 快速开始

1. 克隆仓库并在仓库根目录创建 `config.json`。先从一份账号、一个模型开始，再扩展。
2. 生成足够长的随机 master key；将其和后端凭据放在本机 `.env`，设置文件权限为仅当前用户可读（`chmod 600 .env`）。不要提交 `.env`。
3. 根据订阅家族设置每个 backend 的 `family`（`ocg` 或 `ccg`）、`base_url`、`key_env`；账号名称只用于本地识别。OCG 的 `base_url` 指向 OCG 代理，CCG 指向其 OpenAI 兼容 Provider API。
4. 在 `models` 中配置对客户端公开的统一 `id`，并在 `backends` 映射中填写每个家族的准确上游模型 ID。仅加入你已验证可用、且希望公开给客户端的模型。
5. 启动并检查模型列表与管理看板。

`.env` 示例（占位值不是可用凭据）：

```dotenv
CPR_MASTER_KEY=replace-with-a-long-random-secret
CPR_UPSTREAM_KEY=replace-with-your-provider-api-key
# 可选：开发或非默认端口；默认转发 8741、管理 8740
# CPR_FORWARD_PORT=8741
# CPR_ADMIN_PORT=8740
```

基础 `config.json` 示例（只包含一个 CCG 后端和两个示例映射；上线前请核对你的订阅及上游模型 ID）：

```json
{
  "master_key_env": "CPR_MASTER_KEY",
  "listen": { "host": "127.0.0.1", "port": 8741 },
  "admin": { "port": 8740 },
  "backends": [
    {
      "name": "ccg-main",
      "family": "ccg",
      "base_url": "https://api.commandcode.ai/provider",
      "key_env": "CPR_UPSTREAM_KEY"
    }
  ],
  "models": [
    {
      "id": "glm-5.3-flash",
      "backends": { "ccg": "z-ai/glm-5.3-flash" }
    },
    {
      "id": "deepseek-v4.1-flash",
      "backends": { "ccg": "deepseek/deepseek-v4.1-flash" }
    }
  ]
}
```

默认配置路径是仓库根目录的 `config.json`。`base_url` 是上游 URL 前缀，网关会在其后追加 `/v1/chat/completions`；例如 CCG 示例使用 `/provider` 前缀，最终请求路径为 `/provider/v1/chat/completions`。可用 `CPR_CONFIG_FILE` 指定其他路径；`CPR_FORWARD_PORT`、`CPR_ADMIN_PORT` 可覆盖端口，`CPR_KEYS_ENV` 可覆盖 master key 的环境变量名。路由监听默认仅绑定 `127.0.0.1`；管理口固定绑定回环地址。不要将管理口直接暴露到公网。

开发启动：

```sh
set -a
. ./.env
set +a
node lib/main.mjs
```

客户端配置为 OpenAI 兼容地址 `http://127.0.0.1:8741/v1`，API key 使用 `CPR_MASTER_KEY` 的值。请求需带 `Authorization: Bearer …`。例如：

```sh
curl -H "Authorization: Bearer $CPR_MASTER_KEY" \
  http://127.0.0.1:8741/v1/models
```

## 路由行为

1. **会话钉死**：识别统一会话头（默认 `x-session-id`——OpenRouter/opencode/AWS AgentCore 的业界通用名，可在 `identity_header` 配置），已有映射优先复用原后端，避免缓存前缀因换账号失效。
2. **欠账评分**：新身份在模型可用的后端中，按周期时间进度减已用进度选择；落后于日历进度的订阅优先获得新请求。窗口额度和快照可用性也会影响候选资格。
3. **错误迁移**：遇到符合条件的 403 / 429 配额错误时，尝试将会话迁移到另一可用后端并更新映射；迁移有冷却保护。流式响应开始后不会静默重试。
4. **全员满挡住**：没有健康且可用的后端时返回错误，不会自动消耗额外计费额度或绕过限制。

## 看板与管理 API

默认看板：`http://127.0.0.1:8740/`（等同 `/dashboard`）。管理接口仅供本机/受控反向代理访问，不带公网访问认证层；不要直接公开管理端口。

本机实际部署：看板走专用域名 **`https://hermes-llm-router.ffrfree.xyz/`**（nginx 站点
`/etc/nginx/sites-available/hermes-llm-router.ffrfree.xyz` → Authelia SSO `auth_request` →
`127.0.0.1:8740`，监听 8443 回源口；DNS 由 `*.ffrfree.xyz` 通配 + Cloudflare Origin Rule
`hermes-*` → 8443 覆盖，无需单独解析记录）。旧的临时反代域名
`hermes-proxy-8740.ffrfree.xyz` 已于 2026-11-16 移出白名单，不再使用。

- `GET /api/route/status`：后端状态、额度快照与身份映射概况。
- `GET /api/snapshots`：额度快照。
- `GET /api/audit/requests`：请求审计列表，可用 `limit`、`identity` 查询参数筛选。
- `GET /api/audit/sessions`：会话汇总。
- `GET /api/audit/summary`：整体汇总；传入 `identity` 时返回该会话汇总及请求。

管理口不提供写操作。需要远程查看时，请先通过 VPN/SSH 隧道，或按 [本机部署与 SSO 看板接入](docs/local-deployment.md) 配置可信认证代理。

## 测试与开发

```sh
node --test
```

测试包含路由选择、会话钉死与迁移、审计/看板 API，以及使用本地假上游的 HTTP 冒烟覆盖。测试不要连接生产账号或真实上游；编写集成测试时使用临时端口和假凭据，并验证请求体、认证头及账本行为。项目没有外部依赖安装步骤。

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
