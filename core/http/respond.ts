// HTTP 响应与错误辅助：转发口与管理口共用的小件。
// messageOf/statusOf 的口径：error 是 unknown，状态码只认 number 且非零。
import type { ServerResponse } from 'node:http';

export function json(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
  res.end(bytes);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function statusOf(error: unknown, fallback: number): number {
  const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' && status ? status : fallback;
}
