# 01 worker 模式 + supervisor 骨架

Status: ready-for-agent
Blocked by: (none)

## 验收

- [ ] `lib/main.ts` 支持 `--worker` 模式：不自 bind，经 IPC 接收监听 handle（8741/8740 两个）；`server.listen(handle)` 路径可用，`core/http/server.ts` 的 listen 逻辑参数化（handle 可注入，直 bind 模式行为不变——现有测试零改动通过）。
- [ ] worker 开库成功 + 两口就绪后经 IPC 发 `ready`；开库失败照旧 fail fast 拒启动（supervisor 侧可见退出原因）。
- [ ] `core/supervisor.ts` 骨架：启动时 bind 两口 → spawn worker → handle 交接 → 等 ready → 就绪态。ready 超时（默认 15s）→ 杀 worker、supervisor 报错退出（交给 systemd Restart=always 兜底，语义=「起来就没就绪过」）。
- [ ] fd 引用边界：旧 worker `server.close()` 只减自身 fd 引用，supervisor 持有的监听口不受影响（测试：worker 退出后新连接仍可达）。
- [ ] roles 清单进 supervisor 配置（默认 `[{role:'all'}]` 单 worker 跑两口）；结构按角色抽象，但不实现拆分（spec「角色接缝」节）。
- [ ] journal 启动行报 supervisor/worker 两级版本与角色（版本可见性惯例）。
- [ ] GLOSSARY：Supervisor / Worker / Drain 三词条。

## Comments

- （实现时回填 commit + 验证命令 + 没做的验证）
- 坑提示：fd 交接后 worker 内 `process.send` 通道与业务 IPC 共存要分命名；`--worker` 模式下 snapshot 轮询定时器等 ready 后才开（防与旧 worker 双跑窗口翻倍探上游）。
