import type { ChatBody } from '../contracts.ts';

// 观测层协议归一化（observability 票 01，spec .scratch/observability/spec.md）：
// 四家协议「一条消息」形状各异（消息/工具调用/工具结果/缓存线索），统一 item 模型 +
// 每协议一个转换器。第一版只有 chat-completions（core/protocols/ 唯一在用协议），
// 其余协议有订阅再补——非 chat-completions 请求不捕获，不猜格式。
//
// 存储单元 = 协议里的「一条消息」（prompt cache 的去重边界正是消息：系统提示与历史
// 每轮重发，内容寻址按消息哈希只存一份）。chat-completions 的工具调用长在 assistant
// 消息的 tool_calls 里，随所属消息一起存储，names 提升到 item 上供票 05 统计；
// 独立成条的 tool_call 实体留给把它们单列的协议。
export type CaptureItemKind = 'message' | 'tool_call' | 'tool_result' | 'cache_hint';

export interface CaptureItem {
  kind: CaptureItemKind;
  // message role（user/assistant/system/tool/developer）；独立实体类（tool_call/cache_hint）为 null。
  role: string | null;
  // 本条消息内发起的工具调用名列表（assistant tool_calls[].function.name，按序）。
  tool_calls?: string[];
  // 协议显式缓存断点线索（chat-completions 的 prompt_cache_breakpoint 等），无则不带字段。
  cache_hint?: unknown;
  // 原始消息对象：哈希与还原的正本（票 03 逐条前缀对比按它算，还原逐字节一致按它拼）。
  raw: unknown;
}

export interface NormalizedBody {
  items: CaptureItem[];
  // 请求体去掉 messages 后的顶层字段（含 messages 占位空数组，键序与原 body 一致），
  // 还原时 parse 后回填 messages，JSON.stringify 与原始 body 逐字节一致。
  meta: string;
}

// chat-completions 转换器。body 形状非常规（缺 messages / 消息缺 role / 消息不是对象）
// 返回 null——捕获层据此整轮跳过，绝不猜格式硬拆。
export function chatCompletionsItems(body: ChatBody): NormalizedBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const items: CaptureItem[] = [];
  for (const entry of body.messages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const message = entry as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role : null;
    if (role === null) return null;
    const item: CaptureItem = { kind: role === 'tool' ? 'tool_result' : 'message', role, raw: message };
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const names: string[] = [];
      for (const call of message.tool_calls) {
        const fn = call !== null && typeof call === 'object' && !Array.isArray(call)
          ? (call as Record<string, unknown>).function
          : undefined;
        if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
          names.push(String((fn as Record<string, unknown>).name));
        }
      }
      if (names.length) item.tool_calls = names;
    }
    if (message.prompt_cache_breakpoint !== undefined) item.cache_hint = message.prompt_cache_breakpoint;
    items.push(item);
  }
  const meta: Record<string, unknown> = { ...body, messages: [] };
  return { items, meta: JSON.stringify(meta) };
}
