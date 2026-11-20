# 03 cpr upgrade / reload 接线改造

Status: completed
Blocked by: 02

## 验收

- [x] `cpr upgrade` 流程改为：下载→补丁→临时库冒烟（现有门全保留）→ 调 supervisor「换到 <v>」→ 透传换版本进度/结果 → 完成后健康门（/api/version 报新版 + 假上游冒烟不再需要——真门即活门）。不再调用 `systemctl --user restart`。
- [x] 失败语义（hermes 纪律「失败绝不假成功」）：换版本被拒/失败 → 明确报「升级未完成」+ exit 非零；软链由 supervisor 决定是否回拨（票 02 收据逻辑），CLI 不自己拨。
- [x] `cpr upgrade --to <版本>` 与 registry 传播轮询行为不变；`--yes` 非交互确认保留（TTY 判定坑已有回归测试）。
- [x] `cpr reload` cold-zone 分支：从「打印变更清单 + y/N + 代跑 systemctl restart」改为「换一次同版本 worker」（编排复用票 02 入口）；热区分支不变。unit 不可达/非 supervisor 形态部署（旧版共存的过渡期）→ 如实报错并提示走 restart 兜底。
- [x] 升级收据落盘位置对齐 `~/.llm-cpr/`（收据含：旧/新版本、切换时间戳、supervisor 是否自愈成功——看板与排障认收据不认输出）。
- [x] 测试：CLI 与 supervisor 的接缝用本地 stub HTTP/IPC（对齐 user-scripts 测试接缝纪律：spawn 异步收 exit、不跑仓里原版脚本）。

## Comments

- commit 3f598e9；验证：`npm run typecheck` 绿、`node --test` 240/240（user-scripts.test.ts 升级/冷区用例全部改走 swap stub 并新增 in-progress/failed/501/健康门不过/同版本换五类接缝断言）。
- 收据由 supervisor 落盘（dataDir/upgrade-receipt.json，票 02 实现），字段 from/to/fromRoot/toRoot/switchedAt/windowMs/selfHealed/rollbackAt/rollbackReason；CLI 只在完成/失败输出里指收据路径（「看板与排障认收据不认输出」）。
- swap HTTP 超时 180s（ready 门 + 排水上限 + 富余；supervisor 先答话后排水，正常远小于此）；健康门轮询复用 CPR_HEALTH_DELAY_MS。
- 接缝测试在 user-scripts.test.ts 内完成（同文件 fixture + adminRoutesStub 双路由 /api/supervisor/swap + /api/version + /api/policy/reload）；真实 CLI→supervisor→worker 的端到端归票 04 快车道 e2e（场景 6）。
- 没做的验证：真实 npm registry 传播轮询（--to 直装路径已测，registry 轮询行为未改动）。
