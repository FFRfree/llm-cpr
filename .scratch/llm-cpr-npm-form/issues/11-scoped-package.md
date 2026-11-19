# 11 包名 scoped 化：@ffrfree/llm-cpr

Status: completed
Blocked by: 10, 08

背景（2026-11-19 用户 npm login 后拍板）：用户 npm 账号名即 `ffrfree`（whoami 实测），`@ffrfree/llm-cpr` 是其用户名 scope——npm 允许用户直接以自己的用户名作命名空间发包，无需建 org（npm 也不允许 org 与现有用户名重名）。与 Forgejo 组织 `ffrfree/llm-cpr` 同构；裸名 `llm-cpr` 留在 npmjs 不占。bin 名保持 `cpr`（与包名无关，实测 npm 自动建好软链）。

## 验收

- [x] `package.json`/`package-lock.json` name → `@ffrfree/llm-cpr`；bin `cpr` 不动。
- [x] cpr.ts：`BRAND`（身份面：unit 名/label）与 `PKG`（registry 面：scoped 包名）拆分；npmInstall/npmLatest/重装提示/报错口径全部用 PKG；`versionRoot`/`enginePath` 落点改 `lib/node_modules/@ffrfree/llm-cpr`（scoped 落盘形状已实测）。
- [x] server.ts registry 查询 URL 用 `encodeURIComponent`（scoped 名带 `/`，registry 规范形态 `@scope%2Fname`）。
- [x] 类型补全别名 `import type ... from 'llm-cpr'` → `'@ffrfree/llm-cpr'`（policy.example.ts、仓 tsconfig paths、install 生成的用户 tsconfig 三处同源）。
- [x] migrate.ts 拒启报错从 `npm i -g llm-cpr@latest` 改为产品口径 `cpr upgrade`。
- [x] 测试：npm stub 解析/落盘路径、engineOf/engineLink、全部 `llm-cpr@x.y.z` 断言 → scoped；version.test.ts 假 registry 匹配 `llm-cpr/latest` 后缀（兼容 %2F 编码形态）。
- [x] 文档：README/deployment/ADR-0009 安装命令改 scoped；deployment 发布纪律加 `npm publish --access public`（scoped 包默认按私有收费语义处理，公开发布必须显式声明——忘了直接报错）。
- [x] 重打真包 + 对产物假上游冒烟全绿（验的即发布的字节）。

## Comments

- 实测留档（/tmp 一次性探针）：scoped tgz 名 `ffrfree-llm-cpr-0.2.0.tgz`；`npm install -g --prefix` 落点 `lib/node_modules/@ffrfree/llm-cpr`；bin 软链 npm 自动指 `../lib/node_modules/@ffrfree/llm-cpr/scripts/cpr.ts`；`npm whoami` = `ffrfree`。
- 不改的：`~/.llm-cpr` 目录名、`~/.local/lib/llm-cpr` 安装区名、unit 名 `llm-cpr.service`——身份面继续用 llm-cpr 全家桶，scoped 只发生在 registry 面。
