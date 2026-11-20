# 01: 六模块拆分，行为零变化

Status: completed

## 验收

- [x] server.ts 944 → 482 行；新增 respond/perf/health/forward/admin 五模块（18/61/49/167/235 行）。
- [x] 全部新文件在 core/http/ 同层，STATIC_ROOT 与 package.json 相对解析深度不变。
- [x] `npm run typecheck` 干净；全量 `node --test` 190/190。
- [x] `node scripts/perf-overhead.ts` 三档开销与拆分前一致（≈7/23/62ms），管道行为零变化。
- [x] admin 鉴权边界保持：createAdminServer 不做鉴权，隔离仍靠 127.0.0.1 绑定（文件头注明）。

## Comments

- 验证命令：`npm run typecheck` + `node --test` + `node scripts/perf-overhead.ts --runs 8`。
- 没做的验证：生产（远端 TLS）链路——同分支打点上线后由真实流量覆盖。
