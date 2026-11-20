# 01 e2e 慢车道：podman 容器化隔离

Status: open

## 问题

套件当前直接在宿主机跑：靠「生产 PID 只读比对 + 端口保留断言 + CPR_SYSTEMCTL stub + 路径护栏」四层软护栏保证不扰动生产。打样已证护栏有效，但护栏本质是约定，不是隔离。

## 验收（拟）

- [ ] e2e 三场景在 podman 容器内跑通（宿主机生产 llm-cpr 与容器零共享：无 systemctl 依赖、无共享端口命名空间）。
- [ ] `node scripts/e2e/run-scenarios.ts --slow-lane`（或独立入口）一键起容器跑套件；宿主侧只读比对降级为可选。
- [ ] 生产 PID 比对断言在慢车道下不再必要（容器内无生产进程可碰），记录口径变化。
- [ ] README-run-scenarios.md 补慢车道用法与适用场景（何时该用慢车道、何时直跑够用）。

## Comments

- 2026-11-20：套件进仓 commit 619adc0 已落（打样+进仓均直跑全绿 ×2），本票为后续隔离化待办，未开工。
