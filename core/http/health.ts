// 后端健康观察：两件互相独立的观测件。
// ① healthyBackend：TCP 探活——只证明「端口可连」，不证明认证与额度可用（这是已知边界，
//    移除或改变失败迁移策略前先核对实际客户端与现有 pin 行为）。
// ② createHealthTracker：内存失败环——record() 记账路径顺手喂入，decide ctx 的
//    candidates[].recent 从这里取。只在内存里（重启归 undefined = 窗口内没观察到失败 ≠ 健康，
//    观察盲区语义同快照未知）；零查询成本。
import net from 'node:net';
import type { Backend } from '../contracts.ts';
import type { BackendRecent } from '../policy/contract.ts';

export function healthyBackend(backend: Backend, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };
    const target = new URL(backend.base_url);
    const socket = net.connect({ host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80) });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const HEALTH_WINDOW_MS = 10 * 60_000;
const HEALTH_RING_CAP = 50;

export function createHealthTracker() {
  const rings = new Map<string, { ts: number; status: number }[]>();
  return {
    note(name: string, status: number, now = Date.now()): void {
      // 499 = 客户端取消，与后端服务质量无关，不计入。
      if (status < 400 || status === 499) return;
      const ring = rings.get(name) ?? [];
      ring.push({ ts: now, status });
      if (ring.length > HEALTH_RING_CAP) ring.splice(0, ring.length - HEALTH_RING_CAP);
      rings.set(name, ring);
    },
    view(name: string, now = Date.now()): BackendRecent | undefined {
      const windowed = (rings.get(name) ?? []).filter((entry) => now - entry.ts < HEALTH_WINDOW_MS);
      if (!windowed.length) return undefined;
      const last = windowed[windowed.length - 1];
      return { fails: windowed.length, lastStatus: last.status, lastErrorAt: last.ts };
    },
  };
}
