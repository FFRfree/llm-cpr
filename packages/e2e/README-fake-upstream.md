# fake-upstream.ts — e2e 打样用假 LLM 上游

给 llm-cpr 的 e2e 套件当假上游（链路 `pi → llm-cpr（被测）→ 本脚本`）。零 npm 依赖单文件 `.ts`，Node ≥22.18 直接跑（默认 strip types）：

```
node <仓根>/scripts/e2e/fake-upstream.ts \
  --port <p> --scenario <名> --record <path.jsonl> \
  [--tool-call <工具名>] [--tool-args <json串>] [--wall-after <N>] [--usage-chunk <on|off>]
```

只监听 `127.0.0.1`。内容确定无随机：id 固定前缀 + 请求序号（`chatcmpl-fake-0001` / `call-fake-0001`），`created` 固定纪元 1700000000。stderr 每请求一行 `[fake-upstream] #N <method> <path> -> <结果>` 日志。

## CLI 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `--port <p>` | 是 | 监听端口。**传 8740/8741 直接报错 exit 1**（llm-cpr 生产 forward/admin 口防撞）；只绑 127.0.0.1 |
| `--scenario <名>` | 是 | `ok` / `always-429` / `always-403` / `quota-wall-then-ok` / `midstream-cut` / `hang-ttft`，其他值报错退出 |
| `--record <path.jsonl>` | 否 | 每请求追加一行 JSON（见下）；父目录不存在会自动创建；落点在 `/root/.llm-cpr`、`/root/.config`、`/root/.hermes`（合规 TMPDIR scratch 区除外）下会拒绝启动 |
| `--tool-call <工具名>` | 否 | 启用工具调用启发（见「工具启发」） |
| `--tool-args <json串>` | 否 | tool_calls 的 arguments 原文；必须合法 JSON，否则启动报错；缺省 `{}` |
| `--wall-after <N>` | 否 | 仅 `quota-wall-then-ok`：前 N 次 chat 请求回 429，缺省 3 |
| `--usage-chunk <on\|off>` | 否 | on（缺省）：流尾部带 usage chunk；off：省略，结尾仍是 `data: [DONE]` |

## 路由与回包

- **任何 GET**（含 `GET /usage`）：立即回 JSON，**绝不回 SSE**（已知坑：上游快照轮询 GET origin/usage，回 SSE 会拖满超时）。`/usage` → 200 + usage JSON；其他 GET → 404 JSON。
- **POST `/v1/chat/completions` 或 `/chat/completions`**：按剧本回包（见下）。`body.stream === false` 时回等价 JSON completion（同内容同 finish_reason）；缺省/`stream:true` 回 SSE。
- **其他 POST**：404 JSON。

### usage JSON 形状（`GET /usage`）

```json
{
  "generated_at": "<now ISO>",
  "accounts": [{
    "name": "fake-account", "monthly_percent": 10, "month_progress": 30, "exhausted": false,
    "window_start": "<本月1日 ISO>", "window_end": "<本月末日 23:59:59 ISO>", "resets_at": "<下月1日 ISO>"
  }]
}
```

额度日期相对当前时间动态生成（UTC 月窗口）。

## 剧本

| scenario | 行为 |
|---|---|
| `ok` | 正常 SSE 流：role 帧 → 文本/工具帧 → finish 帧 →（usage chunk）→ `data: [DONE]` |
| `always-429` | 每次 chat 都 429，`retry-after: 1` + `{"error":{"message","type":"rate_limit_error","code":"rate_limit_exceeded"}}` |
| `always-403` | 每次 chat 都 403 + 错误信封（`code:"forbidden"`） |
| `quota-wall-then-ok` | 前 `--wall-after`（缺省 3）次 chat 回 429（同 always-429 形状），之后回正常流 |
| `midstream-cut` | 200 + SSE 头，**恰好 2 个 data: 帧真正 flush 上线后 destroy socket**，无 [DONE] |
| `hang-ttft` | 收下请求体（照常 record）、stderr 记日志，然后**不回应**——socket 悬挂（TTFT 超时探测用） |

## 工具启发（chat 剧本共用）

- 给了 `--tool-call` 且 `body.tools` 非空且历史**无** `role:"tool"` 消息 → 回 `finish_reason:"tool_calls"`，OpenAI 线格式：首帧 `delta.tool_calls[0]` 带 `id/type:"function"/function.name` + `arguments:""`，随后帧逐片给 `function.arguments`（每片 8 字符），末帧 `finish_reason:"tool_calls"`。
- 给了 `--tool-call` 且历史**已有** `role:"tool"` → 纯文本最终回答 `e2e task done`，`finish_reason:"stop"`。
- 没给 `--tool-call` → 一律纯文本 `e2e ok`。

## --record 行格式

每请求一行（追加），四个固定键：

```json
{"ts":"<ISO 时间>","method":"POST","url":"/v1/chat/completions","headers":{...原始请求头...},"body":{...POST body 的 JSON 解析结果...}}
```

- `body`：POST 时是解析后的 JSON 对象（body 非合法 JSON 时存原文）；GET/无请求体时为 `null`。
- 每请求一行、行序即请求顺序；就绪探针的 GET 也会如实记录，消费方按 `method`/`url` 过滤即可。

## 自测

selftest（`selftest-fake-upstream.mjs`，覆盖：①ok 剧本 SSE 完整帧 + [DONE] + record 行格式 ②tool_calls 首轮 / role:tool 历史纯文本 ③quota-wall 前 3 次 429 第 4 次 200 ④GET /usage 回 JSON 非 SSE ⑤`--port 8740/8741` 报错退出 ⑥always-429/always-403/midstream-cut（原生 socket 线上字节证据）/hang-ttft/--usage-chunk off。全过 exit 0。selftest 留在打样批次（2026-11-20），未随套件进仓。
