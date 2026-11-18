import type { Headers } from '../contracts.ts';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export function endToEndHeaders(headers: Headers): Headers {
  const blocked = new Set([...HOP_BY_HOP, ...String(headers.connection ?? '').toLowerCase().split(',').map((name) => name.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())));
}
