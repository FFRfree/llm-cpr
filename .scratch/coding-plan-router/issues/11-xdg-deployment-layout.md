# 11 — Coding Plan Router 用户级 XDG 目录与发布隔离

**Status:** completed

**目标：**将开发源码、正式运行代码、实际配置与持久数据分开，按用户明确选择的用户级布局部署，避免编辑工作树或意外重启时将未发布改动直接带入生产。先仅处理 Coding Plan Router；其他服务须另行评估及授权，不做批量迁移。

## 目标布局

- 开发源码与 Git：`/root/workspace/services/coding-plan-router/`。
- 正式运行代码：`/root/.local/lib/coding-plan-router/`（内部版本/回滚方式采用足够轻量的设计）。
- 实际运行配置及密钥：`/root/.config/coding-plan-router/config.json`、`/root/.config/coding-plan-router/.env`。
- 持久数据：`/root/.local/share/coding-plan-router/sessions.db`、`/root/.local/share/coding-plan-router/usage.db`，SQLite 的 `-wal`/`-shm` 随数据库在同目录运行。
- 系统级 `coding-plan-router.service` 与 systemd journal 可维持现状；用户级目录不意味着必须改成 user service。

XDG 默认区分用户配置 `~/.config` 与持久数据 `~/.local/share`；`~/.local/lib` 是本项目选定的用户级运行代码位置，并非 XDG 强制目录。维持当前用户及权限模型，不顺带引入 Docker、CI、专用用户或大规模重构。源仓保留不含密钥的可用示例配置，生产配置以新目录为准；避免留下两个会被误认为实际生效的配置。

## 前置与安全边界

- 重新读取 `/root/workspace/AGENTS.md`、项目 `AGENTS.md`、技能 `devops:coding-plan-router`，实时核实 `git status`、unit、进程、配置路径、DB 文件及引用；不读取或输出密钥值。
- 本票创建时工作树已有未提交的可靠性与 TypeScript 架构改动，运行中的进程不一定对应当前工作树或 HEAD。**不得覆盖、丢弃、自动提交或夹带这些改动上线**；先核实并与用户确定本次要发布的确切版本。不能简单把 `git archive HEAD` 或整个工作树称为现有线上版本。
- 此前可靠性改造仍有待用户决定的费用策略：额度快照未知时是阻断还是继续尝试；不得借目录迁移擅自改变、上线或宣称解决该行为。
- systemd、生产配置、数据库路径切换或服务重启均须向用户**逐次明确征得同意**；此票不是实施或上线授权。明确说明重启可能中断在途请求；不同意或无答复则停在只读/本地准备阶段。
- 保持 `backend.name`、端口、鉴权、SSO 路由及既有会话/缓存行为；不调用真实推理或消耗订阅额度，除非用户单独授权。测试使用临时目录与本机假上游。
- 数据库是实际业务数据，尤其会话钉死与用量账本均需保留。SQLite WAL 在线只复制主库可能漏已提交数据；使用 SQLite 官方一致性备份或停写并安全关闭后的迁移，备份两库并验证可恢复。两个独立库的在线快照不自动保证业务时点一致；需要一致切换窗口。旧数据与备份不擅自删除。
- 避免路径变更引发空库：确认当前 `CPR_SESSIONS_DB`、`CPR_USAGE_DB`、`CPR_CONFIG_FILE` 实际支持及优先级，显式指定绝对路径并确保父目录和权限可用。不能只检查 `systemctl active`：会话库和审计库均须独立核实。

## 验收

- [x] 开发树与正式运行副本隔离，运行版本可追溯、可回退；发布副本包含运行所需静态资源及依赖，使用适合本机 Node 版本的已确认代码。
- [x] 环境与配置路径显式指向 `/root/.config/coding-plan-router/`；真正生效的配置清晰唯一，密钥未进入 Git 或日志，权限限制合理。
- [x] 两个数据库和 SQLite 相关文件使用 `/root/.local/share/coding-plan-router/`；迁移前后验证会话映射和审计历史保留，保留可恢复备份并验证其完整性；同时确认未意外新建空库。
- [x] 本机假上游测试验证聊天转发、会话粘性、账本写入与管理接口；`node --test`、类型检查（若所选版本支持）及必要文档检查通过。
- [x] 明确代码回退与数据库恢复不是同一件事；记录恢复旧数据可能丢失切换后的写入。上线获授权后检查实际进程入口、开放数据库路径、服务状态和对应管理接口；不以工作树 diff 代替运行验证。
- [x] 文档记录部署、数据备份、恢复与回滚方式，以及确切权限和必要配置；实际结果与未验证项写入本票 Comments。

## Comments

- 2026-11-16：用户确认采用上述用户级布局；此时尚未迁移。当前 systemd 直接从源码目录启动，生产进程打开项目目录下的 `sessions.db` 与 `usage.db`（含 WAL）。已知看板资源按请求读取，直接修改生产所指目录中的静态文件也可能即时影响线上。所有现场事实执行时须重新核实。
- 2026-11-16：用户授权完整实施。再次核实服务当时运行进程 793774 的启动时间为 18:25:22 UTC，HEAD `252f72361acbb07fb59fa0c831bfaba6229892a5` 提交时间为 18:25:11 UTC；全部未提交源码改动 mtime 晚于进程启动。本次只发布此 HEAD，不带入工作树的未提交 TS/可靠性改动。
- 2026-11-16：上线前在 `/root/.local/lib/coding-plan-router/releases/20261116-252f723/` 建立 `git archive HEAD lib static` 发布副本，`current` 软链指向该版本；记录在 `RELEASE.txt`。本机假上游冒烟成功：进程启动、鉴权/模型列表、JSON 聊天转发、会话粘性、SSE 字节直通、管理口 route/status、账本与会话聚合、看板、显式 DB 路径全部通过，发布目录未生成数据库。
- 2026-11-16：停服窗口迁移前计数：`session_routes=88`、`requests=813`、`max(id)=813`。停服后 WAL checkpoint 并复制到 `/root/.local/share/coding-plan-router/backups/20261116T195106Z/` 与目标数据目录；迁移工具对两个库均检查 `integrity_check=ok`，逐项核对计数/最大 id/时间/订阅分布完全相同。目标迁移后仍为 88 个会话钉死、813 条账本，`max(id)=813`。一致性备份保留在备份目录根下；源码树里的旧 DB 也只移动未删除，存入 `source-retired/` 供离线恢复。
- 2026-11-16：新 systemd unit 已生效。运行进程 PID 830020 的 cwd 是 `/root/.local/lib/coding-plan-router/releases/20261116-252f723`；打开的两个 DB 与 WAL/SHM fd 全部指向 `/root/.local/share/coding-plan-router/`。8740/8741 仍仅监听 `127.0.0.1`；`/api/route/status`、`/api/audit/requests?limit=1`、`/api/audit/sessions`、看板均 HTTP 200；无 key 的 `/v1/models` 返回 401；源码目录没有出现新 DB。实际 `.env` 与配置权限为 600，配置目录和数据目录为 700。
- 2026-11-16：验证命令结果：工作树 `node --test` 通过（97 tests，0 fail），`npm run typecheck` 通过，迁移/冒烟脚本 `node --check` 通过，`systemd-analyze verify` 通过；请注意这些完整测试包含未发布工作树改动，本次运行的生产版本仍是 HEAD `252f723`，已对发布副本单独跑假上游冒烟。未调用真实推理、未消耗订阅额度。部署文档见 `docs/xdg-deployment.md`；技能中的默认 `.env` / 服务目录引用已同步。
- 2026-11-16：回滚材料为旧 unit `/root/.config/coding-plan-router/rollback/coding-plan-router.service.old`、旧 env 副本 `/root/.config/coding-plan-router/rollback/env-before-move` 和额外保留的 `/root/.config/coding-plan-router/rollback/env-in-source-before`。回滚旧代码只需切换 `current` 后重启；数据恢复需停服，恢复备份将丢失切换后新写入，二者不是同一操作。费用策略未改动；额度快照未知时仍沿用现有行为。

- 参考：[XDG Base Directory](https://specifications.freedesktop.org/basedir/latest/)、[SQLite WAL](https://sqlite.org/wal.html)、[SQLite Backup API](https://www.sqlite.org/backup.html)。
- 2026-11-16（后续整理，用户要求）：仓库里的配置改成示例文件 `config.example.json`（本机 `config.json`、`.env` 均进 `.gitignore`），与 `.env.example` 一致，避免仓库里放一份长得像生效配置的文件。类型文件后缀从 `.mts` 统一为 `.ts`：`package.json` 已是 `type: module`，Node ≥22.18 原生类型擦除即可运行，`.mts` 只是显式声明 ESM、并非必需；改名后 `node --test` 97 项通过、`npm run typecheck` 通过、发布副本假上游冒烟通过。
- 2026-11-16：工作树已提交，树干净。`78009ba` 架构（provider/protocol 分层 + 可靠性加固 + `.ts` 后缀）；`3b310f0` 部署（示例配置改名、部署文档、迁移与冒烟脚本、本票记录）。生产仍在跑 `252f723` 的发布副本，未发布这两笔提交——需要另行授权才能把它们发上线。
