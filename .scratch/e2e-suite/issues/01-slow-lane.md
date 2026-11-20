# 01 e2e 慢车道：podman 容器化隔离

Status: completed

## 问题

套件当前直接在宿主机跑：靠「生产 PID 只读比对 + 端口保留断言 + CPR_SYSTEMCTL stub + 路径护栏」四层软护栏保证不扰动生产。打样已证护栏有效，但护栏本质是约定，不是隔离。

## 验收（拟）

- [x] e2e 安装链路在 podman 容器内跑通（宿主机生产 llm-cpr 与容器零共享：`--network=none`、install 的 npm 流量落在容器内假 registry、宿主仅只读快照比对）。实况为**独立入口**而非把三场景塞进容器：快车道（场景 1/2/5）保持软护栏形态，慢车道专测安装层 17 步（install→真 systemctl 起 unit→健康→转发冒烟→report.json 判绿）。
- [x] 独立入口一键跑：`bash scripts/e2e/slow-lane/run-slow-lane.sh [遍数]`（默认 2 遍）；支持 `CPR_E2E_REPO` 覆盖被测仓。
- [x] 生产 PID 比对在慢车道保留但语义为「零干扰证明」而非护栏（容器内无生产进程可碰，跑前后快照必须逐字一致）。
- [x] README-run-scenarios.md 补慢车道用法与适用场景（动引擎→快车道；动 install/升级/回滚或发版前→慢车道）。

## Comments

- 2026-11-20：套件进仓 commit 619adc0 已落（打样+进仓均直跑全绿 ×2），本票为后续隔离化待办，未开工。
- 2026-11-20：**completed**——慢车道进仓（本 commit），批次打样阶段验证：连跑两遍 17 步全 PASS、宿主生产 MainPID=2056785 全程一致、无残留容器；进仓版亲跑 1 遍 GREEN。踩坑与镜像/验收口径见 `scripts/e2e/slow-lane/README-slow-lane.md`。专用用户 e2e-cpr（uid 1001，subuid 165536:65536）与镜像为宿主一次性设置，不随仓走。
