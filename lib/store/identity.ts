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
  remoteAddress?: string;
  identityHeader?: string;
}

export function resolveIdentity({ headers = {}, body = {}, remoteAddress = 'unknown', identityHeader = DEFAULT_IDENTITY_HEADER }: IdentityQuery = {}): Identity {
  // 主头（默认 x-session-id，业界通用）优先；老客户端直接发 x-opencode-session 也认
  const primary = (identityHeader || DEFAULT_IDENTITY_HEADER).toLowerCase();
  let session = headers[primary];
  if ((typeof session !== 'string' || session.trim().length === 0) && primary !== 'x-opencode-session') {
    session = headers['x-opencode-session'];
  }
  if (typeof session === 'string' && session.trim().length > 0) return { kind: 'session', key: session };

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
  return { kind: 'address', key: typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown' };
}

// 会话归属（亲和）的持久化在 events.ts：一次归属变更 = 一条 system_events 行，
// 不再有独立的状态表（session_routes / identity_migrations 已随 data.db 双表模型退役）。
// createIdentityStore / IdentityStore / RouteMapping 已于 2026-11-18 随之删除。
