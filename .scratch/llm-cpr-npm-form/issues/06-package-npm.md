# 06 npm 包化与发布纪律

Status: completed
Blocked by: 01, 05

## 验收

- [x] `package.json`：`bin: { cpr: scripts/cpr.ts }`、`engines.node >= 22.18`、`files` 圈 `core/ static/ scripts/cpr.ts policy.example.ts .env.example package.json`（test/、scripts/xdg-deploy 不进包）。
- [x] `smoke-release.ts` 改吃 `npm pack` 产物（.tgz 自动解包冒烟；目录形态仍兼容）。
- [x] 发布纪律：tag `v0.2.0` 前全量测试 + npm 包假上游冒烟通过——已实测（见 Comments）；实际打 tag/publish 等用户授权。

## Comments

- commit 7e485b4：version 0.2.0（package.json + package-lock 两处）+ 去掉 `private: true`（publish 会被它挡）+ description/bin/files；`.gitignore` 加 `*.tgz`。
- 实测验证（不是纸面）：`npm pack` 产物 `llm-cpr-0.2.0.tgz` 内容清单核对——core/ 22 个文件、static/dashboard.html、scripts/ 只有 cpr.ts、模板与 package.json 齐全，test/ 与 xdg-deploy 不在包里；`smoke-release.ts llm-cpr-0.2.0.tgz` 假上游冒烟全绿（启动/鉴权/转发换 key/SSE 直通/账本/看板/单库落位），验的即发布的字节。回归 `npm run typecheck` 0 错 + `node --test` 149/149。
- 没做的验证：`npm publish` 本身（等用户授权 + tag 纪律：打 tag 前 `npm pack` 快照冒烟一遍，发布侧脚本流程照 ADR-0008 的「tag → npm pack 冒烟 → publish」）。
