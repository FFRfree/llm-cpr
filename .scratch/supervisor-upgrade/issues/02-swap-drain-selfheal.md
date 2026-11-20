# 02 换版本编排 + 排水 + 自愈回滚

Status: ready-for-agent
Blocked by: 01

## 验收

- [ ] 换版本入口（supervisor 内部 API，票 03 接线）：从指定版本目录 spawn 新 worker（旧的不动）→ 等 ready → 交 handle → 新旧短暂并存 → 旧 worker 收排水指令 → 在途跑完退出 → 完成。
- [ ] 排水语义：SIGTERM/SIGINT 处理器=停接新请求→在途跑完→退出；排水上限默认 30s（可配），超时强切，强切时账本收尾行为与今日 systemd 硬切一致（对照 test/client-cancel.test.ts 口径写断言）。
- [ ] 失败零损伤：新 worker ready 超时/启动即崩 → 杀之、旧 worker 未受影响（并发压力测试：换版本失败期间持续打假上游，请求数与成功数不减）。
- [ ] 自愈：新 worker 就绪后 crash-loop（连续 N 次快速退出）→ supervisor 读升级收据（版本/时间戳）→ 拨回上一版软链 → 重拉旧 worker；收据切换时落盘、消费即作废；无收据或已消费 → 不回退只拉起（防无关崩溃连环回滚）。
- [ ] 并发防线：换版本进行期间第二个换版本请求被拒绝（不留磁盘锁文件）。
- [ ] system_events 落 `upgrade.swap`（成功：新旧版本）与 `upgrade.rollback`（自愈触发：原因+新旧版本）事件，tenant 恒 'default'（对齐 policy.reload 口径）。
- [ ] 双 worker 并存窗口的行为清点：快照轮询新 worker ready 后才开（单探活）；`policy.reload` 事件不双记。

## Comments

- （实现时回填）
- 坑提示：共享监听口上旧 worker「停接新请求」的实现是关掉自己那份 server 引用而非整口；SSE 长流在排水上限内跑完则无损、超时强切按现状语义落账。
