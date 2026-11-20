# 04 e2e 红线语义修正 + 部署文档 + unit 模板

Status: completed
Blocked by: 03

## 验收

- [x] e2e 硬红线断言修正：原「生产 PID 跑前记、跑后只读比对」改为「supervisor PID 不变 + worker PID 必变」——upgrade 不再动 systemd，但 worker 必须真的换了（防假成功）；CPR_E2E_SKIP_PID_GUARD 豁免路径同步修正。
- [x] 快车道 e2e 全绿：升级场景从「restart 后健康门」改为「swap 后健康门」，断言覆盖：换版本期间持续流量零失败（失败零损伤验收的真 e2e 版）、ready 超时回退、收据回滚。
- [x] `docs/deployment.md` 更新：supervisor 形态下的安装/升级/回滚布局；`scripts/xdg-deploy/smoke-release.ts` 适配（supervisor 模式冒烟）。
- [x] unit 模板更新（ExecStart 指 supervisor）**只在仓内改模板，不碰生产**——部署属生产改动，合并后逐次授权 + 与被替换生产 unit 逐行对拍沙箱行（NoNewPrivileges/PrivateTmp/ProtectSystem/ReadWritePaths）。
- [x] 仓库 AGENTS.md「当前状态」节按 supervisor 形态重写（该文档允许滞后，但结构性形态变更必须落）。
- [x] 全量 `node --test` + `npm run typecheck` 绿；慢车道 e2e（podman 安装层）不受影响（走 npm 包，形态无感知）。

## Comments

- commit `01cfe26`（分支 supervisor-upgrade）：e2e 场景 6 + runners/parseArgs 收 6、unit/plist 模板指 core/supervisor.ts + user-scripts 断言同步、smoke-release supervisor 形态段、docs/deployment.md 与仓库根 AGENTS.md 形态化、supervisor rig / 直跑用例 / e2e 实例钉 `CPR_REGISTRY_URL=http://127.0.0.1:9` 死口。
- 验证：`npm run typecheck` 绿；`node --test` 240/240；快车道 e2e `node scripts/e2e/run-scenarios.ts` 场景 1/2/5/6 全 PASS（生产 llm-cpr MainPID 只读比对全程一致、无残留进程/监听口）；`smoke-release.ts <worktree>` 全绿（含 supervisor 段：同版本 swap 换 worker，pid 变化 + 经交接口转发 200）。
- 偏离票面（按最贴近意图实现）：
  - 坏版本按「永不上报 ready」实现（`setInterval` 挂住），直接覆盖 ready 超时零损伤分支——票面括注「如 502」的 502 型版本能过 ready 门，swap 会成功，不是失败回滚的真分支。
  - 场景 6 内把 `CPR_DRAIN_TIMEOUT_MS`/`CPR_SUPERVISOR_READY_TIMEOUT_MS` 钉 3s（收摊恢复原值）：排水期旧 worker 不掐空闲 keep-alive（票 02 语义，防掐客户端连接池），默认 30s 会让旧 worker 拖满上限才退，swap 后 version 翻转改为轮询断言。测试提速，零断粮语义不变。
  - `pollAdmin`/`versionInfo` 加网络层抖动重试：排水收线会掐 undici 连接池里正在收线的 socket（偶发 fetch failed），只重试网络错误，4xx/5xx 照抛。
- 未做的验证：慢车道（podman 安装层）未实跑（票面判定形态无感知）；生产 unit 部署与生产 swap 未执行（属生产改动，逐次授权，本票只改仓内模板）。
- 实测发现（已写进 run-scenarios 文件头与 prodUnchanged 注释）：supervisor 形态下生产 MainPID = supervisor，worker swap 不改它；旧形态下 MainPID = 网关进程——「跑前记、跑后比对不变」两形态都成立；「worker PID 必变」只在 e2e 自建实例（场景 6 经 /api/version 的 workerPid）断言，不适用于生产。
