#!/usr/bin/env node
// fake-upstream.ts — e2e 打样用可编排假 LLM 上游（llm-cpr 的被测链路：pi → llm-cpr → 本脚本）。
// 零 npm 依赖单文件 .ts，Node >=22.18 直接 `node fake-upstream.ts` 跑（默认 strip types）。
// 独立于仓、不 import 仓内代码；不读写 /root/.llm-cpr、/root/.config、~/.hermes，不碰 systemctl。
// 内容确定无随机：id/created 固定基值 + 请求序号，无 Math.random。
//
// 用法：
//   node fake-upstream.ts --port <p> --scenario <名> --record <path.jsonl>
//        [--tool-call <工具名>] [--tool-args <json串>] [--wall-after <N>] [--usage-chunk <on|off>]
// 剧本：ok | always-429 | always-403 | quota-wall-then-ok | midstream-cut | hang-ttft
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Scenario =
  | 'ok'
  | 'always-429'
  | 'always-403'
  | 'quota-wall-then-ok'
  | 'midstream-cut'
  | 'hang-ttft';

const SCENARIOS: readonly Scenario[] = [
  'ok',
  'always-429',
  'always-403',
  'quota-wall-then-ok',
  'midstream-cut',
  'hang-ttft',
];

// 生产口防撞：8740（llm-cpr forward）/8741（admin）绝不绑定。
const FORBIDDEN_PORTS = new Set(['8740', '8741']);
// 硬约束自保：record 落点不允许进受保护的运行层目录（TMPDIR 指向的 Hermes 合规 scratch 区除外）。
const FORBIDDEN_PREFIXES = ['/root/.llm-cpr', '/root/.config', '/root/.hermes'];
const SANCTIONED_TMP = process.env.TMPDIR || os.tmpdir();

const CREATED = 1_700_000_000; // 固定纪元，保证内容确定
const MODEL = 'fake-model';
const PLAIN_TEXT = 'e2e ok';
const TOOL_FINAL_TEXT = 'e2e task done';
const ARG_SLICE = 8; // arguments 分片宽度（字符），确定切法

function fail(message: string): never {
  console.error(`fake-upstream: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  port: string;
  scenario: string;
  record?: string;
  toolCall?: string;
  toolArgs?: string;
  wallAfter: number;
  usageChunk: boolean;
} {
  const out: {
    port?: string;
    scenario?: string;
    record?: string;
    toolCall?: string;
    toolArgs?: string;
    wallAfter?: string;
    usageChunk?: string;
  } & Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--')) fail(`多余的位置参数 ${flag}`);
    if (value === undefined || value.startsWith('--')) fail(`${flag} 缺值`);
    const camel = flag.slice(2).replace(/-([a-z])/g, (_, c: string): string => c.toUpperCase());
    if (out[camel] === undefined) out[camel] = value;
    i += 1;
  }
  if (!out.port) fail('缺少 --port <p>');
  if (!out.scenario) fail('缺少 --scenario <名>');
  if (!SCENARIOS.includes(out.scenario as Scenario)) {
    fail(`未知剧本 ${out.scenario}（可选：${SCENARIOS.join(' | ')}）`);
  }
  if (out.toolArgs !== undefined) {
    try {
      JSON.parse(out.toolArgs);
    } catch {
      fail(`--tool-args 不是合法 JSON：${out.toolArgs}`);
    }
  }
  const wallAfter = out.wallAfter === undefined ? 3 : Number(out.wallAfter);
  if (!Number.isInteger(wallAfter) || wallAfter < 0) fail(`--wall-after 需为非负整数，得到 ${out.wallAfter}`);
  if (out.usageChunk !== undefined && out.usageChunk !== 'on' && out.usageChunk !== 'off') {
    fail(`--usage-chunk 只接受 on|off，得到 ${out.usageChunk}`);
  }
  return {
    port: out.port,
    scenario: out.scenario,
    record: out.record,
    toolCall: out.toolCall,
    toolArgs: out.toolArgs,
    wallAfter,
    usageChunk: out.usageChunk !== 'off',
  };
}

const args = parseArgs(process.argv.slice(2));

if (FORBIDDEN_PORTS.has(args.port)) {
  fail(`拒绝绑定端口 ${args.port}：8740/8741 是 llm-cpr 生产口（forward/admin），e2e 假上游必须用临时口`);
}
const port = Number(args.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`--port 非法：${args.port}`);

let recordFd: number | null = null;
if (args.record !== undefined) {
  const recordPath = path.resolve(args.record);
  const forbidden = FORBIDDEN_PREFIXES.some((prefix) => {
    if (!(recordPath === prefix || recordPath.startsWith(`${prefix}/`))) return false;
    return prefix !== '/root/.hermes' || !(recordPath === SANCTIONED_TMP || recordPath.startsWith(`${SANCTIONED_TMP}/`));
  });
  if (forbidden) fail(`--record 落点受保护，禁止写入 ${recordPath}`);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  recordFd = fs.openSync(recordPath, 'a');
}

function appendRecord(ts: string, method: string, url: string, headers: IncomingMessage['headers'], body: unknown): void {
  if (recordFd === null) return;
  fs.writeSync(recordFd, `${JSON.stringify({ ts, method, url, headers, body })}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorEnvelope(status: 429 | 403, scenario: string): string {
  const body =
    status === 429
      ? {
          error: {
            message: `fake-upstream/${scenario}: rate limited`,
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        }
      : {
          error: {
            message: `fake-upstream/${scenario}: forbidden`,
            type: 'invalid_api_key_error',
            code: 'forbidden',
          },
        };
  return JSON.stringify(body);
}

// 历史里是否已有 role:"tool"（工具结果已回灌 → 下一轮给最终文本）
function hasToolResult(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some((m: unknown) => isRecord(m) && m.role === 'tool')
  );
}

// 工具启发：给了 --tool-call 且 body.tools 非空且历史无 role:tool → 回 tool_calls；否则纯文本
function decideReply(parsed: unknown): { kind: 'tool_calls' | 'text'; text: string } {
  const wantsTool =
    args.toolCall !== undefined &&
    isRecord(parsed) &&
    Array.isArray(parsed.tools) &&
    parsed.tools.length > 0 &&
    !hasToolResult(parsed.messages);
  if (wantsTool) return { kind: 'tool_calls', text: '' };
  if (args.toolCall !== undefined && isRecord(parsed) && hasToolResult(parsed.messages)) {
    return { kind: 'text', text: TOOL_FINAL_TEXT };
  }
  return { kind: 'text', text: PLAIN_TEXT };
}

function sseFrame(id: string, delta: unknown, finishReason: string | null): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function usageChunk(id: string): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: CREATED,
    model: MODEL,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// OpenAI 线格式：先 id/type/name 帧，再 function.arguments 分片
function toolCallFrames(id: string, callId: string, toolName: string, toolArgs: string): string[] {
  const frames: string[] = [];
  frames.push(
    sseFrame(id, {
      role: 'assistant',
      content: null,
      tool_calls: [
        { index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } },
      ],
    }, null),
  );
  const slices = toolArgs.match(new RegExp(`[\\s\\S]{1,${ARG_SLICE}}`, 'g')) ?? [];
  for (const slice of slices) {
    frames.push(sseFrame(id, { tool_calls: [{ index: 0, function: { arguments: slice } }] }, null));
  }
  frames.push(sseFrame(id, {}, 'tool_calls'));
  return frames;
}

function textFrames(id: string, text: string): string[] {
  return [
    sseFrame(id, { role: 'assistant', content: '' }, null),
    sseFrame(id, { content: text }, null),
    sseFrame(id, {}, 'stop'),
  ];
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  };
}

// 额度日期相对当前时间动态生成（月窗口 + 下月重置点）
function usageJson(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const windowStart = new Date(Date.UTC(y, m, 1));
  const windowEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
  const resetsAt = new Date(Date.UTC(y, m + 1, 1));
  return JSON.stringify({
    generated_at: now.toISOString(),
    accounts: [
      {
        name: 'fake-account',
        monthly_percent: 10,
        month_progress: 30,
        exhausted: false,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        resets_at: resetsAt.toISOString(),
      },
    ],
  });
}

let requestNo = 0;
let chatCount = 0;
const server = http.createServer((req: IncomingMessage, res: ServerResponse): void => {
  void handle(req, res);
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('unexpected request chunk');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestNo += 1;
  const n = requestNo;
  const raw = await readBody(req);
  let parsedBody: unknown = null;
  if (raw.length > 0) {
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      parsedBody = raw;
    }
  }
  appendRecord(new Date().toISOString(), req.method ?? '', req.url ?? '', req.headers, parsedBody);

  const urlPath = (req.url ?? '').split('?')[0];
  const method = (req.method ?? 'GET').toUpperCase();

  // 任何 GET（含 /usage）：立即回 JSON，绝不回 SSE（上游快照轮询 GET origin/usage，回 SSE 会拖满超时）
  if (method === 'GET') {
    const json = urlPath === '/usage' ? usageJson() : JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } });
    const status = urlPath === '/usage' ? 200 : 404;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(json);
    console.error(`[fake-upstream] #${n} GET ${urlPath} -> ${status} json`);
    return;
  }

  // 聊天路径：/v1/chat/completions 或 /chat/completions
  const isChat = method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions');
  if (!isChat) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
    console.error(`[fake-upstream] #${n} ${method} ${urlPath} -> 404 json`);
    return;
  }

  chatCount += 1;
  const chatNo = chatCount;
  const id = `chatcmpl-fake-${String(chatNo).padStart(4, '0')}`;
  const parsed = isRecord(parsedBody) ? parsedBody : {};
  const streaming = parsed.stream !== false;
  const reply = decideReply(parsedBody);

  const sendWall = (status: 429 | 403): void => {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (status === 429) headers['retry-after'] = '1';
    res.writeHead(status, headers);
    res.end(errorEnvelope(status, args.scenario));
    console.error(`[fake-upstream] #${n} POST ${urlPath} chat#${chatNo} -> ${status} wall (${args.scenario})`);
  };

  const sendStream = (): void => {
    const callId = `call-fake-${String(chatNo).padStart(4, '0')}`;
    const frames =
      reply.kind === 'tool_calls'
        ? toolCallFrames(id, callId, args.toolCall ?? '', args.toolArgs ?? '{}')
        : textFrames(id, reply.text);
    const tail = args.usageChunk ? usageChunk(id) : '';
    if (!streaming) {
      // stream:false → 等价 JSON 回包（同内容、同 finish_reason）
      const message =
        reply.kind === 'tool_calls'
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-fake-${String(chatNo).padStart(4, '0')}`,
                  type: 'function',
                  function: { name: args.toolCall ?? '', arguments: args.toolArgs ?? '{}' },
                },
              ],
            }
          : { role: 'assistant', content: reply.text };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: CREATED,
          model: MODEL,
          choices: [{ index: 0, message, finish_reason: reply.kind === 'tool_calls' ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      console.error(`[fake-upstream] #${n} POST ${urlPath} chat#${chatNo} -> 200 json (${reply.kind})`);
      return;
    }
    res.writeHead(200, sseHeaders());
    for (const frame of frames) res.write(frame);
    res.end(`${tail}data: [DONE]\n\n`);
    console.error(
      `[fake-upstream] #${n} POST ${urlPath} chat#${chatNo} -> 200 sse (${reply.kind}${args.usageChunk ? '+usage' : ''})`,
    );
  };

  switch (args.scenario) {
    case 'ok':
      sendStream();
      return;
    case 'always-429':
      sendWall(429);
      return;
    case 'always-403':
      sendWall(403);
      return;
    case 'quota-wall-then-ok':
      if (chatNo <= args.wallAfter) sendWall(429);
      else sendStream();
      return;
    case 'midstream-cut': {
      // 2 个 chunk 后 destroy socket（正常流的前两帧：role 帧 + 文本/工具帧）
      const callId = `call-fake-${String(chatNo).padStart(4, '0')}`;
      const first = sseFrame(id, { role: 'assistant', content: '' }, null);
      const second =
        reply.kind === 'tool_calls'
          ? sseFrame(
              id,
              { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: args.toolCall ?? '', arguments: '' } }] },
              null,
            )
          : sseFrame(id, { content: reply.text.slice(0, 3) }, null);
      res.writeHead(200, sseHeaders());
      res.write(first);
      // 等第二帧真正 flush 到内核后再 destroy，确保下游能读到恰好 2 帧后被切断
      setTimeout((): void => {
        res.write(second, (): void => {
          setTimeout((): void => {
            res.socket?.destroy();
            console.error(`[fake-upstream] #${n} POST ${urlPath} chat#${chatNo} -> cut after 2 chunks`);
          }, 30);
        });
      }, 20);
      return;
    }
    case 'hang-ttft':
      // 收下不回应：请求体已记录，socket 悬挂（TTFT 超时探测用）
      console.error(`[fake-upstream] #${n} POST ${urlPath} chat#${chatNo} -> hang (no response)`);
      return;
  }
}

server.listen(port, '127.0.0.1', (): void => {
  const address = server.address();
  const actual = address && typeof address !== 'string' ? address.port : port;
  console.error(
    `[fake-upstream] listening http://127.0.0.1:${actual} scenario=${args.scenario}` +
      ` tool-call=${args.toolCall ?? '-'} wall-after=${args.wallAfter} usage-chunk=${args.usageChunk ? 'on' : 'off'}` +
      ` record=${args.record ?? '-'}`,
  );
});
