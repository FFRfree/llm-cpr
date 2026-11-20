# 01 热加载器核心：core/policy/reload.ts

Status: ready-for-agent
Blocked by: (none)

## 验收

- [ ] `createPolicyReloader({ policy, policyFile, validate?, backupDir? })`：`policyFile` 为空时 `maybeReload()` 恒 `unchanged`（直传实例的测试零感知）。
- [ ] 懒检查：stat 签名（mtimeMs+size）与已加载版本相同 → `unchanged`；不同才走读文件+import。
- [ ] 破缓存：`import(pathToFileURL(file).href + '?v=' + sha256)`——同内容不重复执行模块（Node ESM 同 URL 只跑一次）。
- [ ] `new` → `validateConfig`，错误带 `<source>:` 前缀（与 main.ts 口径一致）。
- [ ] 冷区比对：常量数组 `COLD_POLICY_FIELDS`（backends/models/tenants/capture/listen/admin/db_file/sessions_db/master_key_env/masterKeyEnv/routing.snapshot_interval_ms），支持点路径；有差异 → 整份拒绝（decide/routing 也不生效），结果带差异路径清单。
- [ ] 失败保旧：语法错/validate 失败/冷区差异/读错误 → 不换实例，结果带 reason 与 error 摘要（截断，不含文件全文）；文件 ENOENT → 保旧 + reason 'file-missing'。
- [ ] 成功：换引用、记 loadedAt/reloads、`backupDir` 存在时拷贝一份 `<ISO时间>-<hash8>.ts`（备份失败不影响换新，结果带 backupError）。
- [ ] 同一签名重复触发不重复报错（attemptSig 去重：上次失败后文件没再变 → kept 且标记 deduped）。
- [ ] 并发合流：in-flight 期间再触发复用同一 Promise。
- [ ] `sha256File(path)` 工具导出（main.ts 启动行用）。

## Comments
