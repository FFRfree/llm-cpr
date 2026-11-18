import type { HeaderContext, Headers } from '../contracts.ts';
import { endToEndHeaders } from '../http/headers.ts';

export function requestHeaders({ headers, upstreamKey, identityHeader = 'x-session-id' }: HeaderContext): Headers {
  // Cross a credential/trust boundary with an allowlist, then install only the
  // selected subscription's credential. Providers own the session header policy.
  const allowed = new Set(['accept', 'user-agent', 'x-request-id', identityHeader.toLowerCase(), 'x-opencode-session']);
  const result = Object.fromEntries(Object.entries(endToEndHeaders(headers)).filter(([name]) => allowed.has(name.toLowerCase())));
  return { ...result, authorization: `Bearer ${upstreamKey}` };
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function item(value: unknown, ...keys: string[]): unknown {
  const source = object(value);
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}
// Providers expose ISO dates and millisecond timestamps; preserve both verbatim.
export function timestamp(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}
export async function getJson(fetchImpl: typeof fetch, url: string, headers: Headers): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Quota headers are constructed locally and contain only string values.
    const requestHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) if (typeof value === 'string') requestHeaders[name] = value;
    const response = await fetchImpl(url, { headers: requestHeaders, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    return value;
  } finally { clearTimeout(timer); }
}
