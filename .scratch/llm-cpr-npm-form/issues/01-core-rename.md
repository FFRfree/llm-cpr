# 01 lib/ → core/ 机械改名

Status: ready-for-agent
Blocked by: (none)

## 验收

- [ ] `core/` 目录就位；`git grep -n "lib/"` 在 ts/文档源码中无残留（仅允许：`scripts/xdg-deploy/*` 里本机生产实况路径的历史注释、`docs/design.md` 历史稿）。
- [ ] 启动日志 policy 来源标签 `core/policy/mine.ts` 与 `test/user-scripts.test.ts` 断言同步。
- [ ] cpr.ts：unit 模板 `ExecStart`、repoRoot 探针；smoke-release.ts 的 release 结构断言；tsconfig `include`；README/AGENTS/`docs/policy-guide.md` 活文档引用全部同步。
- [ ] `npm run typecheck` 0 错 + `node --test` 全绿——纯改名轮，零行为变化（两轮纪律：本轮只动名字）。

## Comments
