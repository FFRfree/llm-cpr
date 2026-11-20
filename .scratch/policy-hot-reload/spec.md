# Policy 热更新：签名懒检查 + 坏文件保旧 + `cpr reload`

2026-11-20 设计稿定稿（`/root/ffr-scratch/2026-11-20-cpr-policy-hot-reload/design.md`，对话拍板：热加载分层 + CLI 反馈层）。

## 动机

配置即代码后改策略 = 改 `~/.llm-cpr/policy.ts` + `systemctl --user restart llm-cpr`。两个痛点：重启打断在途请求，而热区改动（decide/routing 参数）本不需要重启；改坏文件重启后服务拒启动、流量全断（0.3.1 火情即重启循环形态），且用户没有任何事前/事后反馈。

参照系（均源码核实）：Hermes `hermes_cli/config.py`——文件签名 `(mtime_ns, size, ino, ctime_ns)` 懒比对缓存、**坏文件绝不静默回落默认而是保旧（last-known-good，注释引 #31188：回落默认会丢光用户覆盖项含安全规则）**、失败显式告警；nginx `nginx -t` + `-s reload`（本机 nginx unit ExecReload 即此形态）。

## 方案

- **冷热分区**：每请求真正读取的 `decide`、`routing.*`（除 `snapshot_interval_ms`——启动定型进轮询器）、`identity_header` 是热区，换实例引用即生效；`backends`/`models`/`tenants`/`capture`/`db_file`/`sessions_db`/`master_key_env`/`listen`/`admin` 在 `createGatewayServers` 启动时已拆走定型（鉴权租户表 :325、快照轮询器 :365、capture :369-397），是冷区——**冷区有变更时整份拒绝热换**，提示重启才生效。冷区清单在 reload.ts 用常量数组集中定义（唯一长期维护点，契约加冷字段必须同步）。
- **触发**：不起 fs.watch、不轮询；每请求入口与管理口各做一次 stat 签名（mtimeMs+size）比对，变了才走重载（Hermes 同款懒检查；每请求一次 stat 微秒级）。
- **重载流程**：读文件 → sha256 → 动态 import（URL 加 `?v=<hash>` 破 Node ESM 模块缓存；旧模块记录被钉住，低频编辑量级接受）→ `new` → `validateConfig` → 冷区比对 → 全过才原子换引用。任何失败**保旧不换，绝不回落内置 mine.ts**（静默换内置 = 静默改路由，比保旧危险）；文件被删同样保旧。同一签名重复失败不再刷事件/日志（attemptSig 去重），改好文件自然重载。
- **审计三件套**：system_events 新增 `policy.reload`（成功：trigger + 新旧 sha256）与 `policy.reload.error`（失败：reason + error 摘要，不落文件全文防密钥进账本）；成功加载备份一份到 `dataDir/backups/policy/<ts>-<hash8>.ts`；启动行加 sha256。手动触发带 `trigger: 'manual'` 与自动拾取区分。
- **管理口**：`GET /api/policy`（source/sha256/loadedAt/lastError/最近冷区拒绝）只读 + `POST /api/policy/reload`（管理口第二个写操作）。
- **CLI `cpr reload`**：判定单源——CLI 不自己 import/validate，只调管理口，daemon 是唯一验真者；结果转成人话（生效了/语法错保旧了/冷区变了要重启）；冷区变更时打印清单并 y/N 确认后代跑 `systemctl --user restart`（既有 confirm 纪律，y/N 即逐次授权）。daemon 不可达如实报错，不做本地兜底判定。热区忘跑命令也不出错（懒检查兜底，下一条请求自然生效）。

## 边界（第一版不做）

- 不自动重启进程；unit 加 ExecReload 属生产改动，另行单独授权。
- 看板不加编辑器；`?v=` 模块缓存不做清理。
- decide 保持无状态（契约本无会话字段）；若将来扩实例级状态，热换语义需重议。

## 交付面改动清单

`core/policy/reload.ts`（新：reloader + 冷区清单常量 + sha256File）、`core/store/events.ts`（EventKind/明细扩两 kind）、`core/http/server.ts`（policyFile 选项、每请求懒检查、current() 化、两端点）、`core/main.ts`（sha256 进启动行、policyFile 下传）、`scripts/cpr.ts`（reload 子命令）、`test/policy-reload.test.ts`（新）、`test/user-scripts.test.ts`（CLI reload 测试，管理口用本地 stub server）、`docs/policy-guide.md` + `GLOSSARY.md`（热区/冷区词条）。
