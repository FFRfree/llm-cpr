import { StringDecoder } from 'node:string_decoder';
import type { ChatUsage, Headers, PrepareChatRequest, UsageCollector } from '../contracts.ts';
import { providerFor } from '../providers/index.ts';

function jsonUsage(text: string): ChatUsage | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && 'usage' in value && value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
      return value.usage as ChatUsage;
    }
  } catch {}
  return null;
}

function responseUsage(text: string): ChatUsage | null {
  const direct = jsonUsage(text);
  if (direct) return direct;
  let usage: ChatUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    const value = jsonUsage(data);
    if (value) usage = value;
  }
  return usage;
}

// Audit is a bounded side channel, never a retained copy of the forwarded stream.
// Oversized/malformed events are skipped; subsequent valid usage events still count.
function usageCollector(streaming: boolean): UsageCollector {
  const limit = 256 * 1024;
  const decoder = new StringDecoder('utf8');
  let pending = '', event = '';
  let usage: ChatUsage | null = null;
  let droppingLine = false, droppingEvent = false, afterCR = false;
  const parse = (text: string) => {
    const value = jsonUsage(text);
    if (value) usage = value;
  };
  const line = () => {
    if (droppingLine) droppingEvent = true;
    else if (pending === '') {
      if (!droppingEvent && event) parse(event);
      event = ''; droppingEvent = false;
    } else if (pending.startsWith('data:') && !droppingEvent) {
      let data = pending.slice(5);
      if (data.startsWith(' ')) data = data.slice(1);
      if (event.length + data.length + 1 > limit) { event = ''; droppingEvent = true; }
      else event += `${data}\n`;
    }
    pending = ''; droppingLine = false;
  };
  const consume = (text: string) => {
    if (!streaming) {
      if (pending.length + text.length > limit) { pending = ''; droppingLine = true; }
      else if (!droppingLine) pending += text;
      return;
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (afterCR) { afterCR = false; if (char === '\n') { start = i + 1; continue; } }
      if (char !== '\r' && char !== '\n') continue;
      if (!droppingLine) {
        const part = text.slice(start, i);
        if (pending.length + part.length > limit) { pending = ''; droppingLine = true; }
        else pending += part;
      }
      line(); afterCR = char === '\r'; start = i + 1;
    }
    if (!droppingLine) {
      const rest = text.slice(start);
      if (pending.length + rest.length > limit) { pending = ''; droppingLine = true; }
      else pending += rest;
    }
  };
  return {
    write(chunk) { consume(decoder.write(chunk)); },
    end() {
      consume(decoder.end());
      if (streaming) { if (pending || droppingLine) line(); if (!droppingEvent && event) parse(event); }
      else if (!droppingLine) parse(pending);
      return usage;
    },
  };
}

// A concrete Chat implementation, not a speculative protocol adapter hierarchy.
// Responses/Messages belong beside this module once implemented and verified;
// nothing here translates one protocol to another.
export const chatCompletions = {
  matches(method: string | undefined, url: string | undefined): boolean {
    return method === 'POST' && url === '/v1/chat/completions';
  },
  isStreaming(headers: Headers): boolean {
    return String(headers['content-type'] ?? '').includes('text/event-stream');
  },
  target(baseUrl: string): URL {
    const base = new URL(baseUrl);
    while (base.pathname !== '/' && base.pathname.endsWith('/')) base.pathname = base.pathname.slice(0, -1);
    const apiPath = base.pathname === '/v1' || base.pathname.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
    base.pathname = `${base.pathname === '/' ? '' : base.pathname}${apiPath}`;
    return base;
  },
  prepareRequest({ config, body, headers, backend, upstreamKey, identity, identityHeader = config.identityHeader || 'x-session-id' }: PrepareChatRequest) {
    const model = config.models.find((entry) => entry.id === body.model);
    if (!model) throw Object.assign(new Error(`model not allowed: ${body.model ?? ''}`), { statusCode: 400 });
    const translatedModel = model.backends[backend.family];
    if (!translatedModel) throw Object.assign(new Error(`model ${model.id} is not available on ${backend.family}`), { statusCode: 400 });
    return {
      body: { ...body, model: translatedModel },
      headers: providerFor(backend).requestHeaders({ headers, upstreamKey, identity, identityHeader }),
    };
  },
  usageCollector,
  responseUsage,
};
