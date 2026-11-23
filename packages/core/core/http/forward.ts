// 转发管道：一条「网关→上游」的流式透传，结果交回调用方（server.ts 路由环）决定重试/改绑。
// 职责边界：把 body/headers 发出去、把响应 pipe 回客户端、按时序判 499/504/502、
// 403/429 先攒满 body 再交回（额度墙语义由路由环消费）。选路与重试策略不在本模块。
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { endToEndHeaders } from './headers.ts';
import { json } from './respond.ts';
import { chatCompletions } from '../protocols/chat-completions.ts';
import type { Backend, ChatUsage, Headers } from '../contracts.ts';

export interface ForwardTimings {
  ttftMs: number | null;
  streamMs: number | null;
}
export type CompleteHandler = (status: number, payload: string | ChatUsage | null, timings?: ForwardTimings) => void;

export interface ForwardOptions {
  res: ServerResponse;
  backend: Backend;
  body: string;
  headers: Headers;
  startedAt: number;
  onComplete?: CompleteHandler;
  timeoutMs: number;
}

export interface ForwardedResult {
  status: number;
  forwarded: true;
}
// 403/429 攒完 body 交回：重试与透传的判定（retry-after、quota wall）是路由环的事。
export interface QuotaResult {
  status: number;
  forwarded: false;
  headers: IncomingHttpHeaders;
  responseHeaders: Headers;
  body: Buffer;
}
export type AttemptResult = ForwardedResult | QuotaResult;

export function retryAfterMs(value: unknown, now = Date.now()): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function sleep(ms: number, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve(false);
    const finish = (active: boolean) => { clearTimeout(timer); res.off('close', cancel); resolve(active); };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(!res.destroyed), ms);
    res.once('close', cancel);
  });
}

export function forwardAttempt({ res, backend, body, headers, startedAt, onComplete, timeoutMs }: ForwardOptions): Promise<AttemptResult> {
  return new Promise((resolve) => {
    if (res.destroyed) {
      try { onComplete?.(499, null); } catch {}
      return resolve({ status: 499, forwarded: true });
    }
    const target = chatCompletions.target(backend.base_url);
    const transport = target.protocol === 'https:' ? https : http;
    const outgoingHeaders = endToEndHeaders(headers);
    outgoingHeaders['content-type'] = 'application/json';
    outgoingHeaders['content-length'] = Buffer.byteLength(body);
    let finished = false;
    let incoming: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => { clearTimeout(timer); res.off('close', cancel); };
    const fail = (error: Error & { code?: string }) => {
      if (finished) return;
      finished = true;
      cleanup();
      const status = error.code === 'ECANCELED' ? 499 : error.code === 'ETIMEDOUT' ? 504 : 502;
      try { onComplete?.(status, null); } catch {}
      incoming?.unpipe(res);
      incoming?.destroy();
      upstream.destroy(error);
      if (!res.destroyed) {
        if (!res.headersSent) json(res, status === 499 ? 502 : status, { error: { message: `upstream request failed: ${error.message}`, type: 'gateway_error' } });
        else res.destroy(error);
      }
      resolve({ status, forwarded: true });
    };
    // Header wait is absolute (includes connection establishment); successful
    // bodies use inactivity, not total lifetime, so active long SSE is untouched.
    const armTimeout = (ms = timeoutMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })), ms);
      timer.unref?.();
    };
    // A single terminal path owns audit and teardown. Response abort/error and the
    // request error can all fire for one failure; none may turn it into a false 499.
    const cancel = () => {
      if (res.writableEnded || res.writableFinished) return;
      fail(Object.assign(new Error('client cancelled'), { code: 'ECANCELED' }));
    };
    const upstream = transport.request(target, { method: 'POST', headers: outgoingHeaders }, (response) => {
      incoming = response;
      response.on('aborted', () => fail(new Error('upstream response aborted')));
      response.on('error', fail);
      const status = response.statusCode || 502;
      const responseHeaders = endToEndHeaders(response.headers);
      if (status === 403 || status === 429) {
        // Quota bodies gate retries: a drip must not cause an error while the body is still open.
        armTimeout(Math.min(timeoutMs, 5000));
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) return fail(new Error('upstream quota response too large'));
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (finished) return;
          finished = true; cleanup();
          resolve({ status, forwarded: false, headers: response.headers, responseHeaders, body: Buffer.concat(chunks) });
        });
        return;
      }
      armTimeout();
      // pipe() pauses this readable when the client applies backpressure. While
      // paused we cannot observe upstream activity, so it is not an idle period.
      // Resume starts a fresh idle window; cancellation/abort still use fail().
      response.on('pause', () => clearTimeout(timer));
      response.on('resume', () => { if (!finished) armTimeout(); });
      let firstByteAt: number | null = null;
      const streaming = chatCompletions.isStreaming(response.headers);
      const collector = chatCompletions.usageCollector(streaming);
      response.on('data', (chunk: Buffer) => {
        if (finished) return;
        armTimeout();
        // Until a body byte arrives, keep the option of a structured 502/504.
        if (firstByteAt === null) { firstByteAt = Date.now(); res.writeHead(status, responseHeaders); }
        collector.write(chunk);
      });
      response.on('end', () => {
        if (finished) return;
        finished = true; cleanup();
        if (!res.headersSent) res.writeHead(status, responseHeaders);
        const timings: ForwardTimings = {
          ttftMs: firstByteAt !== null ? firstByteAt - startedAt : null,
          streamMs: streaming && firstByteAt !== null ? Math.max(0, Date.now() - firstByteAt) : null,
        };
        try { onComplete?.(status, collector.end(), timings); } catch {}
      });
      response.pipe(res);
      resolve({ status, forwarded: true });
    });
    upstream.on('error', fail);
    res.once('close', cancel);
    armTimeout();
    upstream.end(body);
  });
}

// 403/429 原样透传（保留上游字节与头），并把失败笔喂给账本回调。
export function passthroughError(res: ServerResponse, result: QuotaResult, onComplete?: CompleteHandler): void {
  res.writeHead(result.status, result.responseHeaders);
  res.end(result.body);
  try { onComplete?.(result.status, result.body.toString('utf8')); } catch {}
}
