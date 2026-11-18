# 03 — install：从 clone 到跑起来

**Status:** completed

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

- 2026-11-18 落地（commit ce8bf5b）。实现差异：测试命令可经 `CPR_TEST_CMD` 注入（接缝在 06 票统一登记）；unit 覆盖前自动备份为 `.bak-<时间戳>`；install 的 `runChecks` 只跑测试不跑冒烟（冒烟归 upgrade，install 场景刚 clone 本来就是干净 commit）。
- 验证：install 用例（unit 内容含 WorkingDirectory/EnvironmentFile/CPR_SESSIONS_DB、.env 权限 0600、master key 随机 48 hex、daemon-reload + enable --now stub 调用）+ 幂等用例（重复 install 不重置 .env/policy.local.ts）全过；全量 119/119。
- 没做的验证：真实 systemd 环境（非注入）从未跑过 install——按设计留给用户实测，本机生产 unit 不动。
