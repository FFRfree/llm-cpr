# 03 cpr upgrade / reload 接线改造

Status: ready-for-agent
Blocked by: 02

## 验收

- [ ] `cpr upgrade` 流程改为：下载→补丁→临时库冒烟（现有门全保留）→ 调 supervisor「换到 <v>」→ 透传换版本进度/结果 → 完成后健康门（/api/version 报新版 + 假上游冒烟不再需要——真门即活门）。不再调用 `systemctl --user restart`。
- [ ] 失败语义（hermes 纪律「失败绝不假成功」）：换版本被拒/失败 → 明确报「升级未完成」+ exit 非零；软链由 supervisor 决定是否回拨（票 02 收据逻辑），CLI 不自己拨。
- [ ] `cpr upgrade --to <版本>` 与 registry 传播轮询行为不变；`--yes` 非交互确认保留（TTY 判定坑已有回归测试）。
- [ ] `cpr reload` cold-zone 分支：从「打印变更清单 + y/N + 代跑 systemctl restart」改为「换一次同版本 worker」（编排复用票 02 入口）；热区分支不变。unit 不可达/非 supervisor 形态部署（旧版共存的过渡期）→ 如实报错并提示走 restart 兜底。
- [ ] 升级收据落盘位置对齐 `~/.llm-cpr/`（收据含：旧/新版本、切换时间戳、supervisor 是否自愈成功——看板与排障认收据不认输出）。
- [ ] 测试：CLI 与 supervisor 的接缝用本地 stub HTTP/IPC（对齐 user-scripts 测试接缝纪律：spawn 异步收 exit、不跑仓里原版脚本）。

## Comments

- （实现时回填）
- 坑提示：upgrade 期间 supervisor 拒绝并发换版本 → CLI 要把拒绝转成人话（「上一次升级还在进行中」）；npm 传播 1-3 分钟 ETARGET 轮询已有，别动。
