# 04 e2e 红线语义修正 + 部署文档 + unit 模板

Status: ready-for-agent
Blocked by: 03

## 验收

- [ ] e2e 硬红线断言修正：原「生产 PID 跑前记、跑后只读比对」改为「supervisor PID 不变 + worker PID 必变」——upgrade 不再动 systemd，但 worker 必须真的换了（防假成功）；CPR_E2E_SKIP_PID_GUARD 豁免路径同步修正。
- [ ] 快车道 e2e 全绿：升级场景从「restart 后健康门」改为「swap 后健康门」，断言覆盖：换版本期间持续流量零失败（失败零损伤验收的真 e2e 版）、ready 超时回退、收据回滚。
- [ ] `docs/deployment.md` 更新：supervisor 形态下的安装/升级/回滚布局；`scripts/xdg-deploy/smoke-release.ts` 适配（supervisor 模式冒烟）。
- [ ] unit 模板更新（ExecStart 指 supervisor）**只在仓内改模板，不碰生产**——部署属生产改动，合并后逐次授权 + 与被替换生产 unit 逐行对拍沙箱行（NoNewPrivileges/PrivateTmp/ProtectSystem/ReadWritePaths）。
- [ ] 仓库 AGENTS.md「当前状态」节按 supervisor 形态重写（该文档允许滞后，但结构性形态变更必须落）。
- [ ] 全量 `node --test` + `npm run typecheck` 绿；慢车道 e2e（podman 安装层）不受影响（走 npm 包，形态无感知）。

## Comments

- （实现时回填）
- 坑提示：e2e 夹具日期相对真实时间的铁律不变；supervisor 化后「重启」类断言（journal 启动行）要区分 supervisor 启动与 worker swap 两种事件。
