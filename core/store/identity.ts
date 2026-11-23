import { createHash } from 'node:crypto';
import type { ChatBody, Identity } from '../contracts.ts';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content) ?? String(content); } catch { return String(content); }
}

export const DEFAULT_IDENTITY_HEADER = 'x-session-id';

export interface IdentityQuery {
  headers?: Record<string, string | string[] | undefined>;
  body?: ChatBody;
  identityHeader?: string;
}

// 两级解析（2026-11-23 起无第三级）：①统一会话头（默认 x-session-id；老 x-opencode-session 也认）
// → kind 'session'；②头缺失但 body.messages 可指纹化（数组且含 user 消息）→ sha256(system+首条 user)
// → kind 'fingerprint'。两者皆不可得 → null：调用方（server.ts）必须本地 400 拒绝，绝不转发/记账。
// address（客户端 IP）兜底已砍——OCG 上游强制会话头，无身份转发也是死；生产 address 身份仅垃圾流量。
export function resolveIdentity({ headers = {}, body = {}, identityHeader = DEFAULT_IDENTITY_HEADER }: IdentityQuery = {}): Identity | null {
  // 主头（默认 x-session-id，业界通用）优先；老客户端直接发 x-opencode-session 也认
  const primary = (identityHeader || DEFAULT_IDENTITY_HEADER).toLowerCase();
  let session = headers[primary];
  if ((typeof session !== 'string' || session.trim().length === 0) && primary !== 'x-opencode-session') {
    session = headers['x-opencode-session'];
  }
  if (typeof session === 'string' && session.trim().length > 0) return { kind: 'session', key: session };

  // 指纹分支：messages 非数组 / 空数组 / 无 user 消息都算「无可解析身份」→ null
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const entries = messages.filter((message): message is { role?: unknown; content?: unknown } => Boolean(message) && typeof message === 'object');
    const systemMessages = entries.filter((message) => message.role === 'system');
    const firstUser = entries.find((message) => message.role === 'user');
    if (firstUser) {
      const prompt = systemMessages.map((message) => contentText(message.content)).join('\n');
      const user = contentText(firstUser.content);
      const digest = createHash('sha256').update(JSON.stringify([prompt, user])).digest('hex');
      return { kind: 'fingerprint', key: digest };
    }
  }
  return null;
}

// 会话归属（亲和）的持久化在 events.ts：一次归属变更 = 一条 system_events 行，
// 不再有独立的状态表（session_routes / identity_migrations 已随 data.db 双表模型退役）。
// createIdentityStore / IdentityStore / RouteMapping 已于 2026-11-18 随之删除。
// address 身份（kind 'address'）已于 2026-11-23 随「无身份 400 拒绝」删除。
