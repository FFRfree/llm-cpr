# 01 worker 模式 + supervisor 骨架

Status: completed
Blocked by: (none)

## 验收

- [x] `lib/main.ts` 支持 `--worker` 模式：不自 bind，经 IPC 接收监听 handle（8741/8740 两个）；`server.listen(handle)` 路径可用，`core/http/server.ts` 的 listen 逻辑参数化（handle 可注入，直 bind 模式行为不变——现有测试零改动通过）。
- [x] worker 开库成功 + 两口就绪后经 IPC 发 `ready`；开库失败照旧 fail fast 拒启动（supervisor 侧可见退出原因）。
- [x] `core/supervisor.ts` 骨架：启动时 bind 两口 → spawn worker → handle 交接 → 等 ready → 就绪态。ready 超时（默认 15s）→ 杀 worker、supervisor 报错退出（交给 systemd Restart=always 兜底，语义=「起来就没就绪过」）。
- [x] fd 引用边界：旧 worker `server.close()` 只减自身 fd 引用，supervisor 持有的监听口不受影响（测试：worker 退出后新连接仍可达）。
- [x] roles 清单进 supervisor 配置（默认 `[{role:'all'}]` 单 worker 跑两口）；结构按角色抽象，但不实现拆分（spec「角色接缝」节）。
- [x] journal 启动行报 supervisor/worker 两级版本与角色（版本可见性惯例）。
- [x] GLOSSARY：Supervisor / Worker / Drain 三词条。

## Comments

- commit 68d7f58；验证：`npm run typecheck` 绿、`node --test` 224/224（基线 218 + 新增 test/supervisor.test.ts 6 例全绿）。
- 偏离票面：仓库无 `lib/main.ts`，worker 模式落在 `core/main.ts`（全仓 .ts 布局正本就是 core/，验收语义不变）。
- fd 交接机制经探针实测定型：supervisor 用 `net._createServerHandle` 只 bind 不 listen（Node cluster SharedHandle 同款，无 uv poll → 不 accept → 不丢连接）；「net.Server 挂 onconnection=null」路子实测丢连接（uv__server_io 先 accept 再 close），弃用。worker 侧 `server.listen({ handle })` 复用交接 fd，首个 worker 的 `listen()` 把共享 socket 送进 LISTEN 态。
- `CPR_WORKER_READY_DELAY_MS`（worker 测试接缝：ready 前拖延）与 `CPR_SUPERVISOR_READY_TIMEOUT_MS`（ready 门禁上限覆盖，默认 15s）为新增接缝，测试显式钉死。
- `/api/version` 响应新增 `workerPid`（票 04 e2e「worker PID 必变」红线锚点）。
- 没做的验证：真实 systemd unit 下拉起 supervisor（unit 模板属票 04，且生产改动逐次授权）；macOS launchd 形态。
