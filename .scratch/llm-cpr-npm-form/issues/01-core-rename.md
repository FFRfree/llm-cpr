# 01 lib/ → core/ 机械改名

Status: completed
Blocked by: (none)

## 验收

- [x] `core/` 目录就位；`git grep -n "lib/"` 在 ts/文档源码中无残留（仅允许：`scripts/xdg-deploy/*` 里本机生产实况路径的历史注释、`docs/design.md` 历史稿）。
- [x] 启动日志 policy 来源标签 `core/policy/mine.ts` 与 `test/user-scripts.test.ts` 断言同步。
- [x] cpr.ts：unit 模板 `ExecStart`、repoRoot 探针；smoke-release.ts 的 release 结构断言；tsconfig `include`；README/AGENTS/`docs/policy-guide.md` 活文档引用全部同步。
- [x] `npm run typecheck` 0 错 + `node --test` 全绿——纯改名轮，零行为变化（两轮纪律：本轮只动名字）。

## Comments

- commit dc5eb67：`git mv lib core` 保历史；35 个文件引用同步（import 说明符 68 处、`lib/main.ts` 字面量 10 处、`lib/policy/mine.ts` 15 处、path.join 分段 `'lib'` 12 处、archive 命令 3 处、测试正则单反斜杠形态 3 处、tsconfig include、domain.md 目录树）。改名脚本留档 `/root/ffr-scratch/2026-11-18-llm-cpr-npm-form/rename-lib-core.py`。
- 验证：`npm run typecheck` 0 错；`node --test` 136/136（含 user-scripts fixture 全套：repoRoot 探针认 core/、ExecStart 模板、boot 日志断言）。
- 没做的验证：本机生产未动（unit 仍指旧 release 的 lib/main.ts，属阶段 3 切换）；`docs/deployment.md` 里的 `~/.local/lib/coding-plan-router` 是生产实况路径，留待 08 号票随 npm 形态整体重写。
