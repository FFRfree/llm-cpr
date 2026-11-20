# 02 e2e 接线 CI Actions

Status: completed

## 问题

e2e 套件与全量测试目前只靠人工收尾跑。仓库尚未接 Forgejo Actions（本机 Forgejo 16.0.6，runner 数 0），需要把验证变成推送即跑。

## 验收（拟）

- [x] workflow：`npm run typecheck` + `node --test` 全量（push master / pull_request / workflow_dispatch 触发）。
- [x] workflow：e2e 套件（`node scripts/e2e/run-scenarios.ts`）——CI 容器无宿主 systemd，`prodState()` 生产 PID 比对走显式 env `CPR_E2E_SKIP_PID_GUARD=1` 豁免（本地跑永不豁免）。
- [x] `pi-vendor` 首跑自装依赖网络：job 容器走 host 网络，npm registry 可达，实测自装成功。
- [ ] e2e 失败现场（runs/）作为 artifact 上传——留待需要时再做（本机排障看 runs/ 目录，CI 失败日志已够定位）。

## Comments

- 2026-11-20：套件进仓 commit 619adc0 已落（本机验证：e2e ×2 全绿 / typecheck 0 错 / node --test 206/206），本票待 CI 环境确认后开工；与 01-slow-lane 有依赖关系（先定隔离口径再定 CI 里的比对策略更稳）。
- 2026-11-20：**completed**——宿主侧先铺 Forgejo runner（forgejo-runner v13.2.2，登记卡 `vps-services/forgejo-runner.md`；job 容器 host 网络以够到 127.0.0.1:3001）。workflow 排障三轮真跑：①runner 不自带 clone（workspace 空，`git log` 128）→ 改用 job 自动注入的 GITHUB_TOKEN 自托管克隆，不经外部 actions；②容器无 node_modules，`tsc` 缺失 → 补 `npm ci`；③仓 HEAD 被指到 user-scripts 分支，默认分支克隆测错代码（run 2/3/4 测的是别人的分支，49 失败与"挂起"全是分支错配假象）→ clone 显式钉 `GITHUB_REF_NAME`。顺带修出真 bug：测试夹具临时目录硬编码本机 Hermes scratch 路径（换环境 ENOENT），统一改 `os.tmpdir()` 回退。最终 run 5 五步全绿（clone/typecheck/单测/e2e 场景 1/2/5），commits 链：c8c1dbf→4edd96f。
