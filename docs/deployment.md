# 部署布局与回滚（v0.2.0 npm 视角）

> 本篇是 v0.2.0 的正式部署文档：npm 包分发 + 代码安装区固定（[ADR-0009](adr/0009-fixed-app-root.md)）。
> 文末「历史稿」原样保留 v0.1.0 的 clone + `git archive` release 机制，仅作回溯参考，不再用于新部署。

## 布局三地主（谁的东西放谁的地盘）

| 角色 | 路径 | 说明 |
| --- | --- | --- |
| 用户资产 | `~/.llm-cpr/` | policy.ts / `.env`（chmod 600）/ data.db / backups/ / patches/——拷走即完整备份，升级永不碰 |
| 代码安装区 | `~/.local/lib/llm-cpr/versions/<版本>/` + `current` 软链 | npm 只当下载器（`install -g --prefix`）；版本保留当前+上一版垫背，更老的升级成功即清 |
| 命令软链 | `~/.local/bin/cpr` → `current/bin/cpr` | 唯一免 sudo 默认进 PATH 的位置；不提供任何版本切换命令，`versions/` 是纯管道 |
| 服务 unit | `~/.config/systemd/user/llm-cpr.service` | 用户级 systemd（macOS `~/Library/LaunchAgents`，experimental） |

`~/.local/lib` 不是 XDG 规范目录，是本项目选定的用户级运行代码位置（与 Homebrew Cellar/opt、SDKMAN current 同款先例）；用户资产不用 XDG 三拆（`~/.config` + `~/.local/share`）而收进品牌点目录 `~/.llm-cpr`——理由见 ADR-0009「为什么不是别的」。

安装 / 升级 / 卸载全部由 `cpr` 命令代劳（`npx -y llm-cpr install` 首装，全程免 sudo）。日常口径：

```sh
cpr doctor                 # 体检：NODE/MODE/VERSION/APPROOT/BIN/UNIT/DB/POLICY/PATCH + NEXT
cpr upgrade                # 升级（语义见下节）
cpr upgrade --to <版本>     # 手动升/退到指定版本
cpr uninstall [--purge]    # --purge 才删 ~/.llm-cpr（显式确认）
```

## 升级与回滚语义

```
npm 下载新版 → 独立版本目录（current/服务全不动）
  → 打用户补丁（~/.llm-cpr/patches/*.patch；冲突 = 拒绝，current 未切换零动作）
  → 临时库冒烟（失败 = current 未切换，服务未动）
  → 翻转 current 软链 → systemctl --user restart → is-active 健康门
失败 → current 拨回上一版目录 + restart（零网络、瞬时；版本目录是验证过的完整品）
```

- **DB 备份/迁移的单一来源是引擎启动路径**（`core/store/migrate.ts`）：开库先 WAL checkpoint + 拷 `~/.llm-cpr/backups/<时间戳>/` + integrity check，再按 `PRAGMA user_version` 步骤表迁移；CLI 不重复做。只做加法迁移——加法保证「旧代码跑新库」，是软链回滚的救命绳。
- 手工排查口径：`journalctl --user -u llm-cpr -n 50`；数据回退 = 停服后从 `backups/<时间戳>/` 拷回（**会丢切换后写入**，先核行数与 `max(id)`）。

## systemd unit 要点（v0.2.0）

- 用户级：`systemctl --user` + `loginctl enable-linger`（登出/重启后照跑）；npm 产物零依赖，不需要 `node_modules`。
- unit 钉 `current` 软链（`WorkingDirectory`/`ExecStart` 指 `~/.local/lib/llm-cpr/current/…`）——版本无关，写一次，升级翻转软链后 restart 即用新版。
- `EnvironmentFile=~/.llm-cpr/.env`；显式传 `CPR_DB_FILE`/`CPR_CONFIG_DIR`/`CPR_DATA_DIR`（systemd 不继承安装命令的环境，缺了会静默加载另一份 policy）。

## 发布纪律（维护者视角）

1. 版本纪律：加法迁移打 minor；搬数/换表打 major。`package.json` 版本号与 `core/store/migrate.ts` 的 `SCHEMA_VERSION` 对齐推进。
2. 打 tag `v<x.y.z>` → `npm pack` 出 `.tgz`。
3. **对产物跑假上游冒烟**（验的即发布的字节）：`node scripts/xdg-deploy/smoke-release.ts llm-cpr-<版本>.tgz`——启动、鉴权、换 key 转发、SSE 直通、记账、看板、单库落位全绿才算数。
4. `npm publish`。介意第三方 registry 的自持路线：把自托管 Forgejo 挂成 npm registry，`--registry` 指过去即可，机制不变。

## 本机生产切换（阶段 3，逐次授权）

生产当前仍跑 v0.1.0 形态：系统级 unit `coding-plan-router.service`、`/root/.local/lib/coding-plan-router/current` release 软链、DB 在 `/root/.local/share/coding-plan-router/`。切到 v0.2.0 产品同款时：固定位置装包、数据经 `scripts/xdg-deploy/migrate-dbs.ts` 合并进 `~/.llm-cpr/data.db`、换用户级 `llm-cpr` unit（root 跑 user unit 的 linger 姿势届时单独拍板）、旧 unit 与旧目录退役。切换步骤届时时单独立票、逐次授权执行。

---

# 历史稿：v0.1.0 XDG release 机制（已被 ADR-0009 取代，原样留档）

> ⚠️ 以下内容描述 v0.1.0 的 clone + `git archive` 发布机制，自 v0.2.0 起不再用于新部署；保留仅作回溯参考。文中 `coding-plan-router` 旧名与旧路径按历史原样，未随改名更新。

用户级部署布局：源码、运行代码、密钥、数据四层分离。文中路径用 `~` 占位，按自己的用户目录展开。

## 分层

| 角色 | 路径 | 说明 |
| --- | --- | --- |
| 开发源码 + Git | 任意仓库目录（下文 `$SRC`） | 只在这里改代码；不是运行目录 |
| 正式运行代码 | `~/.local/lib/coding-plan-router/releases/<日期>-<短sha>/` | 从 `git archive` 出的发布副本，带 `RELEASE.txt` |
| 当前生效版本 | `~/.local/lib/coding-plan-router/current` | 软链指向某个 release 目录 |
| 运行声明（配置即代码） | 仓库 `core/policy/mine.ts`，随 release 发布 | 改声明 = 改代码，走发布流程 |
| 密钥环境变量 | `~/.config/coding-plan-router/.env` | chmod 600，生产唯一一份 |
| 持久数据 | `~/.local/share/coding-plan-router/data.db`（含 `-wal`/`-shm`） | 唯一生效库：requests + system_events 双表 |
| 迁移备份 | `~/.local/share/coding-plan-router/backups/<时间戳>/` | 迁移时的一致性快照 |
| 回滚材料 | `~/.config/coding-plan-router/rollback/` | 旧 unit、旧 `.env` 副本（本机自管） |

`~/.local/lib` 不是 XDG 规范目录，是本项目选定的用户级运行代码位置；配置与数据分别遵循 XDG 的 `~/.config` 与 `~/.local/share`。

配置即代码（见 [ADR-0001](adr/0001-configuration-as-code.md)）：订阅声明与路由策略在仓库 `core/policy/mine.ts`，随 release 发布；仓库只放不含密钥的 `.env.example`，部署机复制成 `.env`（已被 `.gitignore` 排除）。部署机上唯一生效的声明是运行副本里随 `git archive` 发布的 `core/policy/mine.ts`；在仓库改声明不影响线上，直到发布切换。运行代码是 TypeScript（`.ts`，靠 Node 原生类型擦除，无需构建），发布副本直接带 `core/` 的 `.ts` 文件即可，前提 Node ≥ 22.18。

systemd 用**系统级** unit（`/etc/systemd/system/coding-plan-router.service`）即可，用户级目录不意味着 user service。运行时零第三方依赖，发布副本不需要 `node_modules`。

## 为什么必须显式指定数据库路径

引擎的默认值是「跟着代码走」：`CPR_DB_FILE` → `policy.db_file` → 代码目录上两层的 `data.db`（旧名 `CPR_SESSIONS_DB`/`policy.sessions_db` 仍兼容读取）。只把代码搬到 `~/.local/lib` 而不写路径，新进程会安静地开一套**空库**，服务照常 active。因此 unit 里固定写死：

```
Environment=CPR_DB_FILE=$HOME/.local/share/coding-plan-router/data.db
```

## 发布一份新版本（不停服也能做）

```bash
cd "$SRC"
git status --short            # 确认要发布的提交，别把未提交改动带进去
SHA=$(git rev-parse --short HEAD)
REL=$HOME/.local/lib/coding-plan-router/releases/$(date -u +%Y%m%d)-$SHA
mkdir -p "$REL"
git archive HEAD core static package.json | tar -x -C "$REL"
printf 'commit=%s\nnode=%s\npublished_at=%s\n' "$(git rev-parse HEAD)" "$(node -v)" "$(date -u +%FT%TZ)" > "$REL/RELEASE.txt"
# 冒烟：本机假上游，临时目录，不碰真实订阅额度
node scripts/xdg-deploy/smoke-release.ts "$REL"
ln -sfn "$REL" $HOME/.local/lib/coding-plan-router/current   # 切换生效版本（重启后才真正生效）
```

`git archive HEAD core static package.json` 只取运行所需文件；`test/`、`tsconfig.json`、`package-lock.json` 不需要，运行时不读它们。`package.json` 必须带上：运行代码是 `.ts`，Node 按最近的 `package.json` 的 `"type": "module"` 判定为 ESM——发布目录里没有它就只能靠语法探测兜底。

## 数据备份与迁移（双库 → data.db 合库）

`scripts/xdg-deploy/migrate-dbs.ts`（2026-11-18 起为合库迁移器）：把旧的双库（`sessions.db` + `usage.db`）合并成单个 `data.db`（`requests` + `system_events` 双表，见 `.scratch/affinity-events/spec.md`）。它做四件事：源库 WAL checkpoint、复制备份副本、按新 schema 建目标库并搬数据（requests 原样保留 id、session_routes → route.bind 事件、identity_migrations → route.rebind 事件且 reason 从配对账本行回溯）、逐项计数验收（requests 行数/`max(id)` 一致、bind/rebind 事件数与旧表行数一致）。它在源库仍有其他连接持锁时（`busy != 0`）会直接报错退出；目标文件已存在时拒绝覆盖。

必须停服后执行，因为两个旧库各自拍快照不保证业务时点一致；在线只复制主库会漏掉 `-wal` 里已提交的数据。

```bash
systemctl stop coding-plan-router
TS=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/xdg-deploy/migrate-dbs.ts \
  --sessions-db $HOME/.local/share/coding-plan-router/sessions.db \
  --usage-db    $HOME/.local/share/coding-plan-router/usage.db \
  --dest-db     $HOME/.local/share/coding-plan-router/data.db \
  --backup-dir  $HOME/.local/share/coding-plan-router/backups/$TS
```

迁移后把 unit 的数据库环境变量换成 `CPR_DB_FILE`（见上节）再启动。源位置的旧库原地保留 + 备份目录各有一份副本（只复制不删除），不要把它们当作当前数据。

## systemd unit 要点（历史）

`WorkingDirectory` 指 `current` 软链；`EnvironmentFile` 指 `~/.config/coding-plan-router/.env`；`CPR_DB_FILE` 显式写绝对路径；`ReadWritePaths` 限 `~/.local/share/coding-plan-router`；`ExecStart` 为 `node core/main.ts`。配置即代码之后没有 `CPR_CONFIG_FILE`——声明随 release 走。

## 切换与验证（历史）

切换软链（或首次安装 unit 后 `daemon-reload && start`）会中断在途请求，客户端重试即可。验证项：

```bash
systemctl is-active coding-plan-router
PID=$(systemctl show -p MainPID --value coding-plan-router); ls -l /proc/$PID/fd | grep -E '\.db'
curl -s http://127.0.0.1:8740/api/route/status | head -c 300
curl -s 'http://127.0.0.1:8740/api/audit/requests?limit=1'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8740/          # 看板
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8741/v1/models # 无 key 应 401
ls "$SRC"/*.db*                    # 不应出现新库/新 WAL
```

必须同时确认：进程打开的 fd 指向 `~/.local/share/coding-plan-router/`、亲和事件数与账本行数不少于迁移前、源码目录没有新生成空库。只看 `systemctl is-active` 不够——空库也能 active。

## 回滚（代码回退 ≠ 数据恢复，历史）

代码回退（不丢数据，最常用）：

```bash
ln -sfn $HOME/.local/lib/coding-plan-router/releases/<旧版本> $HOME/.local/lib/coding-plan-router/current
systemctl restart coding-plan-router
```

数据恢复（会丢数据）：把 `backups/<时间戳>/` 里的库复制回目标路径，**切换之后写入的亲和与账本会丢失**。回滚代码不会自动恢复数据，恢复数据也不等于回滚代码；恢复前先停服，恢复后核对行数与 `max(id)`。
