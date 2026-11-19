# 12 逃离 node_modules：cpr.js 引导器 + 引擎落位 versions/<v>/app

Status: completed
Blocked by: 11

背景（2026-11-19 真机切换时炸出的雷，只有真机 e2e 能抓到）：Node 拒绝对 **node_modules 路径下**的 .ts 做类型擦除（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，本机 v22.22.3 实测）——npm/npx 的一切落盘都在 node_modules 树里，v0.2.0 的 .ts 入口在那里一条命令都跑不起来（npx 缓存 ~/.npm/_npx/…/node_modules、npm -g --prefix lib/node_modules 全中招）。测试夹具从不在 node_modules 路径下跑 cpr.ts，所以 158 例全绿也没照见这团火。**0.2.0 是装不活的版本**，发 0.2.1 替代并 deprecate 0.2.0。

## 验收

- [x] bin 改纯 ESM JS 引导器 `scripts/cpr.js`（JS 在任何路径都能跑）：包未就位时 npm 下载 → rename 原子搬离 node_modules 到 `versions/<v>/app` → 清 npm 空壳、版本内 bin 重指 `../app/scripts/cpr.ts` → 从 app/ 拉起真正的 .ts CLI 转发退出码。
- [x] cpr.ts：`versionRoot`/`enginePath` 改 `versions/<v>/app` / `current/app`；新增 `relocateFromNodeModules`，install/upgrade 每次下载后立刻搬离（空壳 lib/ 与旧 bin 软链一并清）。
- [x] `package.json`：bin `cpr` → `scripts/cpr.js`；files 加 `scripts/cpr.js`；版本 0.2.1。
- [x] 回归测试（真机火情）：对照组——node_modules 路径下直接跑 .ts 必须**失败**（断言 Node 拒绝）；实验组——cpr.js 从同一位置引导必须成功（PKGROOT=app、MODE=bootstrap、node_modules 空壳已清）。install 断言补「下载后无 lib/ 残留」。
- [x] 0.2.1 产物 `ffrfree-llm-cpr-0.2.1.tgz` 假上游冒烟全绿；161/161 + typecheck 0 错。

## Comments

- 引擎最终形态：`~/.local/lib/llm-cpr/versions/<v>/app/`（路径里没有 node_modules，.ts 直接跑）；`versions/<v>/bin/cpr` → `../app/scripts/cpr.ts`；`~/.local/bin/cpr` → `current/bin/cpr`。npm 仍只是下载器，落盘位置全程我们说了算。
- 教训留档：**发 .ts 源码包就必须让运行路径躲开 node_modules**——Node 的类型擦除刻意排除 node_modules（视其为已编译产物区），没有绕过旗标；任何 npm 通道拿到的 .ts 都跑不起来。同因别犯：npx bootstrap 也中招，这就是 bin 必须是 .js 的原因。
