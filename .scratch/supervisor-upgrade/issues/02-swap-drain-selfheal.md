# 02 换版本编排 + 排水 + 自愈回滚

Status: completed
Blocked by: 01

## 验收

- [x] 换版本入口（supervisor 内部 API，票 03 接线）：从指定版本目录 spawn 新 worker（旧的不动）→ 等 ready → 交 handle → 新旧短暂并存 → 旧 worker 收排水指令 → 在途跑完退出 → 完成。
- [x] 排水语义：SIGTERM/SIGINT 处理器=停接新请求→在途跑完→退出；排水上限默认 30s（可配），超时强切，强切时账本收尾行为与今日 systemd 硬切一致（对照 test/client-cancel.test.ts 口径写断言）。
- [x] 失败零损伤：新 worker ready 超时/启动即崩 → 杀之、旧 worker 未受影响（并发压力测试：换版本失败期间持续打假上游，请求数与成功数不减）。
- [x] 自愈：新 worker 就绪后 crash-loop（连续 N 次快速退出）→ supervisor 读升级收据（版本/时间戳）→ 拨回上一版软链 → 重拉旧 worker；收据切换时落盘、消费即作废；无收据或已消费 → 不回退只拉起（防无关崩溃连环回滚）。
- [x] 并发防线：换版本进行期间第二个换版本请求被拒绝（不留磁盘锁文件）。
- [x] system_events 落 `upgrade.swap`（成功：新旧版本）与 `upgrade.rollback`（自愈触发：原因+新旧版本）事件，tenant 恒 'default'（对齐 policy.reload 口径）。
- [x] 双 worker 并存窗口的行为清点：快照轮询新 worker ready 后才开（单探活）；`policy.reload` 事件不双记。

## Comments

- commit 98a1f53；验证：`npm run typecheck` 绿、`node --test` 236/236（新增 test/supervisor-swap.test.ts 12 例全绿，覆盖以上每条验收）。
- 偏离票面：收据字段含 fromRoot/toRoot（回滚重拉与软链拨回需要绝对路径，CLI 传 root 时一并落收据）；「连续 N 次快速退出」N=2、快速判定窗口 10s、收据窗口 15min（SupervisorOptions 可调）。
- 排水实现与票面「关掉自己那份 server 引用」不同（实测教训，见 core/main.ts 注释）：`http.Server.close()`（Node ≥19 自带 idle keep-alive 清理）会把客户端连接池的空闲 socket 掐掉，复用即被 reset——压测 16 条挂 4 条。改为 net 层只关 listening handle（存活连接不动）+ 排水期响应标 `Connection: close` + 响应一结束就 end() 连接 + 上限时最后扫一次 idle。压测换版本全程零失败。
- 两个实现期踩坑（都有回归测试盖住）：换版本窗口内新 worker 自我退场时 exit 事件无人接（收养尸体）→ adoptWorker 转正后核对存活；stop() 撞上在途编排会漏掉接任 worker（孤儿占口）→ stop 先等编排收尾。
- 换版本失败时软链回拨由 supervisor 自己做（先翻后换、失败回拨）；`connection: close` 收线等私有面（server._handle、request 包装）都收口在 worker 模式内，直 bind 模式零影响。
- 没做的验证：真实 systemd 下 SIGTERM 停 supervisor 的全链路（unit 属票 04）；SSE 长流 >30s 的生产值排水（测试用 0.5s 上限验证了强切口径）。
