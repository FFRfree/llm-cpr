# 06 npm 包化与发布纪律

Status: ready-for-agent
Blocked by: 01, 05

## 验收

- [ ] `package.json`：`bin: { cpr: ... }`、`engines.node >= 22.18`、`files` 圈 `core/ static/ package.json`（test/、scripts/xdg-deploy 不进包）。
- [ ] `smoke-release.ts` 改吃 `npm pack` 产物（验的即发布的字节）。
- [ ] 发布纪律：tag `v0.2.0` 前全量测试 + npm 包假上游冒烟通过；旧 tag/旧机制文档留档。

## Comments
