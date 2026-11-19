# 14 bin 软链改指 JS 引导器（修执行位）

Status: completed
Blocked by: 12, 13

背景：真机 `cpr upgrade` 后敲 `/root/.local/bin/cpr` 报 Permission denied——软链指向的 cpr.ts 在仓里从未带 +x（一直 `node cpr.ts` 跑），npm 如实保留无执行位权限，shebang 链条断在第一环。

## 验收
- [x] 版本内 bin 软链（cpr.js bootstrap 与 cpr.ts relocate 两处）改指 `../app/scripts/cpr.js`——JS 引导器可执行且任何环境能跑，不再依赖 .ts 的执行位；顺手仓内两脚本 chmod +x（npm 保真传递）。
- [x] bootstrap 回归测试加断言：bin 软链目标 = '../app/scripts/cpr.js'。
- [x] 161/161 + typecheck 0 错；版本 0.2.3。
