# 13 启动版本行换正源（package.json）

Status: completed
Blocked by: 12

背景：真机切换时启动日志打 `llm-cpr unknown`——main.ts 的 bootVersion 还是 v0.1.0 机制（读 RELEASE.txt 的 commit= / clone 里跑 git rev-parse），npm 形态两者皆无。README 口径「启动日志报当前版本」与代码不符（05 重写覆盖了 cpr.ts，漏了 main.ts 这处）。

## 验收
- [x] bootVersion 改读包内 package.json 的 version（与 /api/version 端点同源）；RELEASE.txt/git 机制退役；顺手清 main.ts 未用 import（spawnSync/fileURLToPath）。
- [x] makeMainCopy 夹具补 name/version，启动行断言收紧为 `llm-cpr 0.1.0 —`（unknown 不再蒙混过关）。
- [x] 161/161 + typecheck 0 错；版本 0.2.2。
