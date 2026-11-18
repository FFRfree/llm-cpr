# 03 — install：从 clone 到跑起来

**Status:** ready-for-agent

**目标：** `scripts/cpr.ts install`，用户零文档装完（脚本本身在仓内，先 clone 后跑，无 curl|sh）。

## 流程

1. Node 版本检查（不满足直接拒，给安装指引一句话）。
2. `cp policy.example.ts policy.local.ts`（已存在则跳过并提示）。
3. 写 systemd unit（`/etc/systemd/system/coding-plan-router.service`；测试经 `CPR_UNIT_DIR` 注入临时目录）：`ExecStart=node lib/main.ts`、用户目录布局照 `docs/deployment.md` 占位；`systemctl daemon-reload`。
4. `node --test` 全量。
5. 交互确认「现在启动？（y/N）」默认 N；y → `systemctl enable --now coding-plan-router`。
6. 末尾打印：管理/推理端口、看板反代提示、doctor 命令。

## 边界与坑

- 幂等：重复执行先报现状（unit 已存在→比对差异；local 已存在→跳过），不静默覆盖。
- 服务名 `coding-plan-router.service` 是 install 立下的契约，04/05 依赖它。
- 单文件脚本，零运行时依赖；交互用 node:readline。

## 验收

- 全流程在临时 unit 目录 + fixture clone 上走通；默认回答 N 时服务未启动、unit 已写。
- 已装环境重跑：报现状、零副作用。

## Comments
