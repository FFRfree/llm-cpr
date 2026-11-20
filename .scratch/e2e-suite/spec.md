# e2e 套件进仓（scripts/e2e/）

## 目标

把打样批次（/root/ffr-scratch/2026-11-20-cpr-policy-hot-reload/e2e/）里全绿的四件套（fake-upstream.ts / cpr-instance.ts / pi-driver.ts / run-scenarios.ts）+ README 进仓到 `scripts/e2e/`，做到「每次改动收尾跑一行」：

```
cd /root/ffr-projects/llm-cpr && node scripts/e2e/run-scenarios.ts
```

## 已完成（completed）

- [x] 四件套 + 4 份 README（fake-upstream / cpr-instance / pi-driver / run-scenarios）进仓 `scripts/e2e/`。
- [x] 适配：cpr-instance 打包源参数 `worktreeDir` → `repoDir`（run-scenarios 的 `--repo-dir` 可选参，缺省=仓根自身；`--worktree` 保留覆盖能力）。
- [x] `npm run typecheck` 过（tsconfig include 本就覆盖 `scripts/**/*.ts`；fake-upstream.ts 参数累加器补 `& Record<string, string|undefined>` 过严格索引检查，未放宽 include）。
- [x] `node --test` 发现规则不受影响：套件文件名不含 `.test.`、不在 `test/` 目录，全量仍 206/206。
- [x] `package.json` `files` 白名单不含 `scripts/e2e/`——e2e 不进 npm 包（npm pack 产物实证不含）。
- [x] `pi-vendor/` 不进仓：`.gitignore` 排除 `scripts/e2e/pi-vendor/`（与 `scripts/e2e/runs/` 运行产物一起），套件首跑时 `ensurePiVendor` 自装锁定版 `@mariozechner/pi-coding-agent@0.73.1`，README 写清。
- [x] 打样批次留仓外：selftest.ts / selftest-fake-upstream.mjs / probe-* 留批次（批次工装，README 已注明出处）。

## 验证（进仓当日，master 工作树为打包对象）

- e2e 全跑两遍全绿：`node scripts/e2e/run-scenarios.ts` ×2，场景 1/2/5 全 PASS、无残留进程/监听口、生产 PID 全程一致。
- `npm run typecheck` → 0 错。
- `node --test` → 206/206。
- `python3 /root/ffr-projects/workspace-lint/lint.py` → 0 ERROR。

## 待办（issues/）

- `01-slow-lane.md` — podman 慢车道（completed：独立入口 `scripts/e2e/slow-lane/run-slow-lane.sh`，安装层 17 步容器内真跑）。
- `02-actions.md` — 接线 CI Actions（completed：Forgejo runner 本机铺好，workflow 推 master 即跑，run 5 全绿）。

## 状态

两条票均已 completed（2026-11-20）。套件三车道齐活：本机快车道（一行命令）、CI 快车道（推 master 即跑）、慢车道（安装层/发版前）。

## Comments

- commit（e2e 套件进仓 + .gitignore）：619adc0（本 spec 随票回写 commit 落库，不记自身 hash）。
