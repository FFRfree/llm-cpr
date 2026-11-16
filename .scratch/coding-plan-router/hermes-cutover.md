# Hermes 生产切换草案（仅供审批后执行）

> **本文件只记录方案；没有修改 `/root/.hermes/config.yaml`、生产服务或任何生产文件。**
> 下列差异按 2026-11-16 读取到的当前配置整理。执行前须先确认路由器已在 `127.0.0.1:8741` 运行、`CPR_MASTER_KEY` 已安全注入 Hermes 进程环境，且 `/v1/models` 确实公开所需模型。当前仓库的示例 `config.json` 仅配置 `glm-4.6`，不能据此假定下面整份白名单已经可用。

## 当前 Hermes 配置要点（无凭据）

- 当前模型：`z-ai/glm-5.3-flash`
- 当前 provider：`custom:commandcode`
- 当前 base URL：`https://api.commandcode.ai/provider/v1`
- 当前 API mode：`chat_completions`
- `providers.opencode-go` 和 `providers.commandcode` 都是 `chat_completions`、`discover_models: false`。
- 原 `opencode-go` 模型清单：`glm-5.3-flash`、`deepseek-v4.1-flash`、`mimo-v2.6-flash`、`hy3`、`hy4`、`longcat-2.5-free`。
- 原 `commandcode` 模型清单仍使用上游完整模型 ID（如 `z-ai/glm-5.3-flash`、`deepseek/deepseek-v4.1-flash`）。原配置中没有在这两个 provider 项下设置 `key_env` 或 `session_affinity_header`。

## 建议的最小增量 diff

这是示意性 YAML diff。模型白名单依据现有 `opencode-go` provider 的统一短名称；执行时必须与 coding-plan-router 实际 `/v1/models` 输出、`config.json` 的 `models[].id` 逐项一致。不要为了套用此示例而加入路由器未配置的模型。

```diff
 model:
   default: z-ai/glm-5.3-flash
-  provider: custom:commandcode
-  base_url: https://api.commandcode.ai/provider/v1
+  provider: custom:coding-plan-router
+  base_url: http://127.0.0.1:8741/v1
   api_mode: chat_completions

 providers:
+  coding-plan-router:
+    name: Coding Plan Router
+    api: http://127.0.0.1:8741/v1
+    transport: chat_completions
+    key_env: CPR_MASTER_KEY
+    session_affinity_header: x-session-id
+    discover_models: false
+    models:
+      - glm-5.3-flash
+      - deepseek-v4.1-flash
+      - mimo-v2.6-flash
+      - hy3
+      - hy4
+      - longcat-2.5-free
```

若该 Hermes 版本的 provider schema 使用 `api` 字段作为 provider URL，请保持 `api` 与 `model.base_url` 两处都指向路由器；在实际改动前通过本机 schema/启动校验确认 `key_env`、`session_affinity_header` 的字段含义。此处没有写入真实 master key：只有环境变量名。`session_affinity_header` 用于把 Hermes 会话 id 装进统一会话头 `x-session-id`（业界通用名，头名与 opencode 解耦；网关会按后端家族翻译成下游要求的头）。

## 切换前检查

1. 从本机安全配置渠道给 Hermes 运行环境注入 `CPR_MASTER_KEY`，并确认值与路由器的 master key 完全一致；不要写进 YAML、文档或 shell 历史。
2. 检查路由器绑定 `127.0.0.1:8741`，管理口仍仅回环绑定 `127.0.0.1:8740`。
3. 用受控请求验证 `GET http://127.0.0.1:8741/v1/models`：返回模型必须覆盖默认模型及计划使用的白名单；仓库当前模型配置未覆盖上述清单时，先另行完成并验收路由器模型配置。
4. 确认 Hermes 发出的请求使用 `Authorization: Bearer <CPR_MASTER_KEY>`，并带 `x-session-id`；禁止在日志/工单里粘贴 header 值。
5. 备份当前 Hermes 配置文件权限受控；记录切换前 model/provider 区块。备份不得提交仓库。
6. 经用户明确批准后再编辑生产配置并重启/重新加载 Hermes。未经批准不得执行这些步骤。

## 切换后验收

- Hermes `/model` 可见并可选择路由器白名单模型。
- 一次非生产风险可控的普通对话返回成功，流式响应完整。
- 同一会话多轮请求的 `x-session-id` 保持一致，路由器映射保持钉死。
- 路由器账本出现对应请求，管理看板显示订阅/会话/用量数据。
- 若任一项不通过，立即按下方步骤回滚，不在生产环境临时扩大白名单或关闭认证。

## 逐项回滚到原始值

只回滚 Hermes 配置；不要清除路由器账本或更改上游订阅配置。

1. 在 `model` 区块恢复：
   ```yaml
   model:
     default: z-ai/glm-5.3-flash
     provider: custom:commandcode
     base_url: https://api.commandcode.ai/provider/v1
     api_mode: chat_completions
   ```
2. 从 `providers` 删除本次新增的整个 `coding-plan-router:` 项（包括 `name`、`api`、`transport`、`key_env`、`session_affinity_header`、`discover_models` 和 `models`）。
3. 保留原有 `providers.opencode-go` 和 `providers.commandcode` 条目，不用新增项覆盖它们。其已核对的原始非凭据值如下：
   ```yaml
   providers:
     opencode-go:
       name: OpenCode Go
       api: http://127.0.0.1:8731/v1
       transport: chat_completions
       discover_models: false
       models:
         - glm-5.3-flash
         - deepseek-v4.1-flash
         - mimo-v2.6-flash
         - hy3
         - hy4
         - longcat-2.5-free
     commandcode:
       name: CommandCode
       api: https://api.commandcode.ai/provider/v1
       transport: chat_completions
       discover_models: false
       models:
         - z-ai/glm-5.3-flash
         - deepseek/deepseek-v4.1-flash
         - inclusionai/ling-3.1-flash
         - inclusionai/ling-3.1-flash-1019
         - zai-org/GLM-5.3
         - zai-org/GLM-5.2
         - tencent/hy3-paid
         - Qwen/Qwen3.8-27B
         - deepseek/deepseek-v4-flash
         - deepseek/deepseek-v4.1-flash-fast
         - moonshotai/Kimi-K2.7-Code
         - meituan/LongCat-2.0
         - MiniMaxAI/MiniMax-M3
         - google/gemini-3.8-flash
         - google/gemini-3.7-flash
   ```
   若原配置中的其余字段或凭据与上述摘录不同，以切换前受控备份为准；不要用这份非凭据摘录重建、覆盖原条目。
4. 用 YAML 解析/配置校验确认 model 恢复为原值、`custom:coding-plan-router` 已移除；重新加载或重启 Hermes（需在批准的维护窗口操作）。
5. 通过 Hermes 执行一条普通请求，确认恢复直连 `custom:commandcode`；同时确认没有继续向路由器发新请求。
6. 若恢复后仍异常，使用切换前备份完整恢复配置并复查文件权限。回滚完成后再单独决定是否撤销 Hermes 进程的 `CPR_MASTER_KEY` 注入；不要删除其他服务共用的密钥配置。

**执行界限：**本文不是生产变更授权。真实切换、重载及回滚都须由用户单独批准；本工单未执行任何生产操作。
