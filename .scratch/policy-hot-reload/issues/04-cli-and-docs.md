# 04 CLI `cpr reload` + 文档

Status: completed
Blocked by: 03

## 验收

- [x] `scripts/cpr.ts` 新子命令 `reload`：判定单源——只 POST `http://127.0.0.1:${CPR_ADMIN_PORT||8740}/api/policy/reload`，不本地 import/validate；连接失败如实报错退出 1，不做本地兜底判定。
- [x] 结果转述（人话）：reloaded → 「策略已热更新（sha256 …），下一条请求即生效」；unchanged → 「文件未变化」；kept(load-failed) → 「热更新失败，继续用旧策略：<error 摘要>」退出 1；kept(cold-zone-change) → 列出冷区差异字段 + 说明重启才生效。
- [x] 冷区变更时 y/N 确认（`confirm(question, yes)` 复用，`--yes` 直过）→ `serviceRestart()`（CPR_SYSTEMCTL/CPR_UNIT_NAME 接缝照常生效）；拒绝则提示手工口径。
- [x] USAGE 与入口 switch 更新。
- [x] 测试（user-scripts.test.ts 风格）：fixture 拷贝跑 CLI，管理口用本地 stub http server（CPR_ADMIN_PORT 指它）盖四态 + CPR_SYSTEMCTL stub 断言 restart argv；daemon 不可达态断言退出码与报错文案。
- [x] `docs/policy-guide.md`：新增「热更新」节——改完怎么生效（懒检查/cpr reload/什么时候必须重启）、审计去哪看（system_events 两 kind、backups/policy 快照、/api/policy）、错误处理语义（保旧不回落）。`GLOSSARY.md` 增「热区/冷区（hot/cold zone）」词条。README 若有「改 policy 要重启」的旧说法一并 grep 清理。

## Comments

- commit 4973024 + 712f0d0：cpr reload 子命令 + policy-guide/GLOSSARY/README 热更新口径；CLI 测试 5 例（stub 管理口 + CPR_SYSTEMCTL stub 断言 restart argv）。
- 验证：test/user-scripts.test.ts 28/28；review 探针 probe3 为 stub 罐头（旧期望），daemon 侧 reason 保真由 test/policy-reload.test.ts 的 deduped 冷区例覆盖，CLI 映射由「冷区变更 --yes 代跑重启」例覆盖。
- 没做的验证：unit ExecReload（属生产改动，单独授权）；macOS 真机（LaunchAgent reload 走同一 admin API，理论等效，未真机验证）。
