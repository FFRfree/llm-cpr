// perf 打点（spec .scratch/perf-instrumentation/spec.md）：转发路径分段计时，每请求一行 [perf]。
// 只测「我们自己的代码开销」：startedAt（选路完成、开始连上游）之前的 read/parse/identity/snapshot/
// route（probe 另计，route−probe=纯决策）/prepare/capture 各段 + forward{ttft,stream}。不含身份明文、
// 会话 id、正文（journal 可读，纪律同账本的 identity_hash）；401/404/本地 400 走 suppress 不发行。
// 形态 = OpenTelemetry 手动插桩的简化版（startActiveSpan + finally span.end 的包裹式）：
// per-request span 不串号，try/finally 保证抛错/早退也封口。
import type { ServerResponse } from 'node:http';
import type { Logger } from '../contracts.ts';
import type { ForwardTimings } from './forward.ts';

export function createPerfSpan(res: ServerResponse) {
  const marks: Record<string, number> = {};
  let routeT0: number | null = null;
  let attempts = 0;
  let forward: { ttft: number | null; stream: number | null } | null = null;
  let bytes: number | null = null;
  let model: string | null = null;
  let tenant: string | null = null;
  let done = false;
  const round = (value: number | undefined): number | null => value === undefined ? null : Math.round(value * 10) / 10;
  return {
    add(key: string, ms: number): void { marks[key] = (marks[key] ?? 0) + ms; },
    run<T>(key: string, fn: () => T): T {
      const t0 = performance.now();
      try { return fn(); } finally { marks[key] = (marks[key] ?? 0) + (performance.now() - t0); }
    },
    async runAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try { return await fn(); } finally { marks[key] = (marks[key] ?? 0) + (performance.now() - t0); }
    },
    routeStart(): void { routeT0 = performance.now(); },
    routeEnd(): void { if (routeT0 !== null) { marks.route = (marks.route ?? 0) + (performance.now() - routeT0); routeT0 = null; } },
    countAttempt(): void { attempts += 1; },
    setForward(timings: ForwardTimings | undefined): void { if (timings) forward = { ttft: timings.ttftMs, stream: timings.streamMs }; },
    meta(input: { bytes: number; model: string; tenant: string }): void { bytes = input.bytes; model = input.model; tenant = input.tenant; },
    suppress(): void { done = true; },
    finish(logger: Logger): void {
      if (done) return;
      done = true;
      const view: Record<string, unknown> = {
        ts: Date.now(),
        ms: {
          read: round(marks.read), parse: round(marks.parse), identity: round(marks.identity), snapshot: round(marks.snapshot),
          route: round(marks.route), probe: round(marks.probe), prepare: round(marks.prepare), capture: round(marks.capture),
        },
        attempts,
        forward,
        status: res.statusCode,
        bytes, model, tenant,
      };
      if (!res.writableFinished) view.aborted = true;
      logger.log?.(`[perf] ${JSON.stringify(view)}`);
    },
    // 正常完成在 'finish'（响应写完）即发射——keep-alive 客户端下 'close' 要等连接断开，
    // 日志会延迟数秒甚至攒到连接池回收；'close' 只兜 aborted（客户端取消/半截流，无 finish）。
    attach(logger: Logger): void {
      res.once('finish', () => this.finish(logger));
      res.once('close', () => this.finish(logger));
    },
  };
}
