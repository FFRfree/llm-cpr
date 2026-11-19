# 03 policy 加载点外置 ~/.cpr/policy.ts

Status: ready-for-agent
Blocked by: 02

## 验收

- [ ] 加载顺序：`~/.cpr/policy.ts` 存在则优先，否则内置 `core/policy/mine.ts`；local 存在但 import 失败一律原样抛（不静默回落——沿 v0.1.0 纪律）。
- [ ] `~/.cpr/policy.example.ts` 模板由 `cpr install` 落盘；`~/.cpr/tsconfig.json` 指路类型补全（指向已安装包内 contract）。
- [ ] 启动日志报 policy 来源与版本可见性。
- [ ] 测试：local 优先 / 缺失回落 / 坏 local 拒启动（validateConfig 报错带来源前缀）。

## Comments
