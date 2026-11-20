# Supervisor 常驻外壳：agent 自升级零断粮

2026-11-20 规划（批次 `/root/ffr-scratch/2026-11-20-cpr-supervisor-upgrade/`，对话拍板：pm2 风格 socket 壳 + 角色接缝先行）。背景拍板句：**"想让一个在用 cpr 的 running agent，自己安全地去升级 cpr"**——agent 既是升级发起人又依赖被升级的服务，升级断粮 = 医生在手术台上麻倒自己。

## 动机

现行 `cpr upgrade` 过门即 `systemctl --user restart`：切换瞬间在途请求被腰斩（发起升级的那条 agent 请求最常中招）；升级"成功"上线后 crash-loop 时 agent 已断网，回滚依赖一个会说话的东西——死锁（0.3.0 型失败：门内全绿、上线才炸）。三道防线缺口：

1. **门内**：真实环境预检不足（隔离冒烟测不出吃不下真配置/真库的版本）→ 已另议，不属本批（见「非目标」）。
2. **切换**：硬切掐断在途请求 → 本批以 worker 排水解决。
3. **门后**：无自愈 → 本批以内建 supervisor 自解决，不依赖 systemd 钩子、不依赖任何进程活着。

## 业界对照（源码/文档核实，2026-11-20）

- **hermes**（本机源码）：升级收据落盘、语法门禁、坏则自动回滚、「失败绝不假成功」+ 启动链自愈。已学。
- **Claude Code**：versions/ 目录 + 软链 + 保留当前和上一版（quick rollback）；staging 校验后原子切换；**不重启运行中进程**（工具类特权，下次启动才生效）；PID 锁防并发升级/清理；服务端 kill switch 封坏版本；**无自动回滚**。
- **Tailscale**：也无单机自动回滚；招在发布侧——新版观察约一周稳定性才进 auto-update 通道。对 CPR 无意义：部署面就一台机器，没人替我们踩雷，验证必须做在自己门里。
- **pm2**：服务类标准解——master 持监听 socket，reload 逐个换 worker：起新→等 `process.send('ready')` 才算 online（`wait_ready`，防"进程起了但没就绪"）→旧的收排水信号→`kill_timeout` 内跑完在途→退出。fork 模式明确承认做不到零中断。
- **结论**：原子切换+留旧版业界一致；「进程自己死了谁拉回上一版」业界普遍没有机制化——本场景（唯一实例、agent 唯一用户）恰是自动回滚收益最大的位置。

## 方案

- **形态**：systemd unit 改跑 **supervisor**（唯一新增常驻组件）。supervisor 开机 bind 8741/8740 两监听 socket（此后终生持有——端口不空窗的全部秘密）；派生 worker（现 `lib/main.ts` 加 `--worker` 模式，接收 IPC handle 交接而非自 bind，其余 boot 逻辑不动）；worker 开库成功并就绪后经 IPC 发 `ready`（pm2 `wait_ready` 同义）。
- **换版本编排**：`cpr upgrade` 冒烟过门后不改调 systemctl，改调 supervisor「换到 <v>」——supervisor 从新版目录起新 worker（旧的照常服务）→ 等 ready → 交 socket handle → 新旧短暂并存（共享监听口由内核仲裁，cluster 模式标准行为）→ 通知旧 worker 排水（停接新请求、在途跑完）→ 旧 worker 退出，升级完成。
- **失败语义**：新 worker ready 超时/起不来 → 杀之，旧 worker 全程未停，升级如实报失败（零损伤）；ready 后 crash-loop → supervisor 依升级收据（版本/时间戳，切换时落盘）自动拨回上一版软链并重拉旧 worker；收据窗口外或已消费 → 不回退（防无关崩溃连环回滚老版本），仅照常拉起。自愈不依赖 systemd 钩子。
- **`cpr reload` 统一**：cold-zone 变更从「代跑 systemctl restart」改为「同版本换一次 worker」——换 worker 即新 boot，冷区自然生效，重启语义与升级语义合一。
- **角色接缝（先行设计，不实现拆分）**：supervisor 配置天生带 roles 清单，默认 `[{role:'all'}]` 单 worker 跑两口。未来拆 `[{role:'relay'},{role:'admin'}]` 时零架构返工。归属规则预先钉死：快照轮询/`policy.reload` 事件记账每个 kind 只归一个角色（默认 relay）；admin worker 打开同一 data.db（WAL 多进程已支持，cpr CLI 并发访问即先例）。明确的收益是事件循环隔离（看板重查询不再与转发抢 CPU），非吞吐。
- **排水细节**：SIGTERM/SIGINT 处理器=停接新请求→在途跑完→退出，上限可配（默认 30s，防 SSE 长流挂死）；超时强切语义对齐今日硬切（账本收尾行为不变）。Node ≥19 的 `server.close()` 自带 idle keep-alive 清理，活跃请求正常完成。

## 设计取舍记录

- **不用 SO_REUSEPORT 做并存**：macOS 语义不同（无内核负载均衡保证）、Node 22 可用性不确定、双 worker 双写窗口多一类账本噪音——handle 交接方案全部绕开。
- **不用 systemd `OnFailure=` 钩子做自愈**：需要独立防误伤机制（收据+窗口+消费标记）与 supervisor 内部逻辑重复；且钩子只在 unit 进 failed 状态时触发，语义与 supervisor 的 worker 级监控对不上。systemd 保留兜底职责（Restart=always、supervisor 自身崩溃时全量重启=现行为）。
- **不学 Claude Code 的 PID 锁**：CPR upgrade 是显式 CLI 动作不是后台自动检查，agent 手滑连发两次的防线由「升级期间 supervisor 拒绝第二个换版本请求」覆盖（同 fd 锁语义），不留磁盘锁文件。
- **服务端 kill switch / stable 延迟通道**：单用户自托管无意义，发布侧把关 = MR review + 冒烟门（现行流程）。

## 边界（非目标）

- **不做** cluster 多 relay 横向扩展（吞吐非瓶颈、recent-quality 内存态会分叉）；roles 接缝为将来留门，今天不建。
- 真实环境预检（真配置 + data.db 快照开库）不在本批——它属于「门内防线」，与 supervisor 正交，可另立一批。
- unit 模板改写（ExecStart 换 supervisor）属生产改动，**实现合并后部署时逐次授权**，并按惯例与被替换的生产 unit 逐行对拍沙箱行。
- Windows 不支持（沿袭 npm 形态拍板）；macOS 走 handle 交接方案，不依赖 reuseport。

## 交付面改动清单

`core/supervisor.ts`（新：bind/spawn/handle 交接/ready/换版本编排/收据与自愈）、`lib/main.ts`（`--worker` 模式：接收 handle 而非 bind）、`core/http/server.ts`（listen 路径参数化：handle 可注入）、`scripts/cpr.ts`（upgrade/reload 接线）、unit 模板（部署时）、`test/`（supervisor/编排/自愈/排水，含假上游冒烟扩展）、`scripts/e2e/`（PID 红线语义修正）、`docs/deployment.md` + `GLOSSARY.md`（Supervisor/Worker/Drain 词条）。

## 未来方向（记录，不排期）

- 角色拆分（admin/relay 双 worker）——事件循环隔离，代价是共享状态归属清点（快照轮询、事件记账、policy 重载去重）。
- 门内真实环境预检（另批）：真 policy.ts + `.env` 只读装配冒烟 + data.db `VACUUM INTO` 快照开库迁移预检。
- 若将来真要多 relay：SO_REUSEPORT（Linux-only）或 supervisor 代收分发，前置要求是 recent-quality 状态入库或改单源裁决。
