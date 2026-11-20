# 02 e2e 接线 CI Actions

Status: open

## 问题

e2e 套件与全量测试目前只靠人工收尾跑。仓库尚未接 GitHub Actions（仓 remote 已有，origin 同步 master），需要把验证变成推送即跑。

## 验收（拟）

- [ ] workflow：`npm run typecheck` + `node --test` 全量（PR 与 push master 触发）。
- [ ] workflow：e2e 套件（`node scripts/e2e/run-scenarios.ts`）——CI 环境无生产 llm-cpr，跑前需处理 `prodState()` 生产 PID 比对的无生产可读情形（读不到 unit 时跳过比对而非判失败，或先落 01 慢车道再接线）。
- [ ] `pi-vendor` 首跑自装依赖网络：确认 CI 网络策略，必要时缓存 npm 安装。
- [ ] e2e 失败现场（runs/ 保留目录）作为 artifact 上传，便于排查。

## Comments

- 2026-11-20：套件进仓 commit 619adc0 已落（本机验证：e2e ×2 全绿 / typecheck 0 错 / node --test 206/206），本票待 CI 环境确认后开工；与 01-slow-lane 有依赖关系（先定隔离口径再定 CI 里的比对策略更稳）。
