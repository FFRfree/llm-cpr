// core/swap.ts — 换版本请求/结果的接缝契约（supervisor-upgrade 票 02/03）。
// worker 的 admin 面收到 POST /api/supervisor/swap 后经本契约 IPC 转发 supervisor 编排；
// CLI（scripts/cpr.ts）与测试只认响应形状，不关心转发细节。
export interface SwapRequest {
  root?: string;    // 目标版本包根；缺省 = 当前 worker 的根（同版本换一次 worker，cpr reload 冷区分支复用）
  version?: string; // 目标版本号（缺省读目标根的 package.json）
  appRoot?: string; // 安装区根（current 软链所在目录）；缺省由 supervisor 从 root 布局推（versions/<v>/app 才翻链）
}

export type SwapOutcome =
  | { ok: true; fromVersion: string; toVersion: string; workerPid: number }
  | { ok: false; status: 'in-progress' | 'failed'; error: string };

// 换版本编排的入口抽象：worker 桥（main.ts --worker）实现它；admin 面只依赖接口。
export interface SwapCoordinator {
  swap(request?: SwapRequest): Promise<SwapOutcome>;
}
