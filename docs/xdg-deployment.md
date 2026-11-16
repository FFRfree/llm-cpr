# 用户级 XDG 布局部署与回滚

本文描述 coding-plan-router 在当前机器上的实际部署位置、数据备份/恢复与回滚方式。
工单：`.scratch/coding-plan-router/issues/11-xdg-deployment-layout.md`。

## 分层

| 角色 | 路径 | 说明 |
| --- | --- | --- |
| 开发源码 + Git | `/root/workspace/services/coding-plan-router/` | 只在这里改代码；不是运行目录 |
| 正式运行代码 | `/root/.local/lib/coding-plan-router/releases/<日期>-<短sha>/` | 从 `git archive` 出的发布副本，带 `RELEASE.txt` |
| 当前生效版本 | `/root/.local/lib/coding-plan-router/current` | 软链指向某个 release 目录 |
| 运行配置 | `/root/.config/coding-plan-router/config.json` | 不含密钥，chmod 600 |
| 密钥环境变量 | `/root/.config/coding-plan-router/.env` | chmod 600，生产唯一一份 |
| 持久数据 | `/root/.local/share/coding-plan-router/sessions.db`、`usage.db`（含 `-wal`/`-shm`） | 唯一生效库 |
| 迁移备份 | `/root/.local/share/coding-plan-router/backups/<时间戳>/` | 迁移时的一致性快照 |
| 回滚材料 | `/root/.config/coding-plan-router/rollback/` | 旧 unit、旧 `.env` 副本 |

`~/.local/lib` 不是 XDG 规范目录，是本项目选定的用户级运行代码位置；配置与数据分别遵循 XDG 的 `~/.config` 与 `~/.local/share`。

源仓只保留不含密钥的示例：`config.example.json` 与 `.env.example`。本机开发时复制成 `config.json` / `.env`（两者都已被 `.gitignore` 排除）。生产机唯一生效的配置是上表里的 `/root/.config/coding-plan-router/config.json`；改源码仓库里的示例不会影响线上。运行代码可以是 TypeScript（`.ts`，靠 Node 原生类型擦除，无需构建），因此发布副本直接带 `lib/` 里的 `.ts` 文件即可，前提是 Node ≥ 22.18。

systemd 仍为**系统级** unit（`/etc/systemd/system/coding-plan-router.service`），用户级目录不意味着 user service。运行时零第三方依赖，发布副本不需要 `node_modules`。

## 为什么必须显式指定数据库路径

`lib/server.ts` 的默认值是「跟着代码走」：`CPR_SESSIONS_DB` → `config.sessions_db` → 代码目录上一层的 `sessions.db`，而 `usage.db` 取 sessions 所在目录。只把代码搬到 `~/.local/lib` 而不写路径，新进程会安静地开一套**空库**，服务照常 active。因此 unit 里固定写死：

```
Environment=CPR_SESSIONS_DB=/root/.local/share/coding-plan-router/sessions.db
Environment=CPR_USAGE_DB=/root/.local/share/coding-plan-router/usage.db
```

## 发布一份新版本（不停服也能做）

```bash
cd /root/workspace/services/coding-plan-router
git status --short            # 确认要发布的提交，别把未提交改动带进去
SHA=$(git rev-parse --short HEAD)
REL=/root/.local/lib/coding-plan-router/releases/$(date -u +%Y%m%d)-$SHA
mkdir -p "$REL"
git archive HEAD lib static package.json | tar -x -C "$REL"
printf 'commit=%s\nnode=%s\npublished_at=%s\n' "$(git rev-parse HEAD)" "$(node -v)" "$(date -u +%FT%TZ)" > "$REL/RELEASE.txt"
# 冒烟：本机假上游，临时目录，不碰真实订阅额度
node scripts/xdg-deploy/smoke-release.ts "$REL"
ln -sfn "$REL" /root/.local/lib/coding-plan-router/current   # 切换生效版本（重启后才真正生效）
```

`git archive HEAD lib static package.json` 只取运行所需文件；`test/`、`tsconfig.json`、`package-lock.json` 不需要，运行时不读它们。`package.json` 必须带上：运行代码是 `.ts`，Node 按最近的 `package.json` 的 `"type": "module"` 判定为 ESM——发布目录里没有它就只能靠 Node 的语法探测兜底，多一层不必要的隐式依赖。

## 数据备份与迁移

`scripts/xdg-deploy/migrate-dbs.ts` 做三件事：WAL checkpoint（把只在 `-wal` 里的已提交数据并回主库）、复制到备份目录与目标目录、逐项校验 `integrity_check` 与行数/`max(id)`/`max(ts)`/各订阅计数完全一致。它在源库仍有其他连接持锁时（`busy != 0`）会直接报错退出；目标文件已存在时拒绝覆盖。

必须停服后执行，因为两个库（`sessions.db` 是 `journal_mode=delete`，`usage.db` 是 WAL）各自拍快照不保证业务时点一致；在线只复制主库会漏掉 `-wal` 里已提交的数据。

```bash
systemctl stop coding-plan-router
TS=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/xdg-deploy/migrate-dbs.ts \
  --sessions-db /root/workspace/services/coding-plan-router/sessions.db \
  --usage-db    /root/workspace/services/coding-plan-router/usage.db \
  --dest-dir    /root/.local/share/coding-plan-router \
  --backup-dir  /root/.local/share/coding-plan-router/backups/$TS
```

注意：`--dest-dir` 里已有库时脚本会拒绝，重复迁移请先确认目标确实是空的或先另行归档。

迁移后，源码目录中的旧 DB 文件会原样保留到 `/root/.local/share/coding-plan-router/backups/<时间戳>/source-retired/`（只移动不删除，权限 700/600），不留在源码树里；它们是离线副本，不再生效。迁移工具另存一份经过一致性校验的主备份文件在该时间戳目录根下。排查时不要把这两套旧副本当作当前数据。

## 切换 unit 与验证

新 unit 见 `/root/.config/coding-plan-router/rollback/coding-plan-router.service.new`，与旧 unit 的差别只有四处：`WorkingDirectory` 指 `current`、`EnvironmentFile` 指 `~/.config`、新增 `CPR_CONFIG_FILE`/`CPR_SESSIONS_DB`/`CPR_USAGE_DB` 三个 `Environment=`、`ReadWritePaths` 换成 `~/.local/share/coding-plan-router`。

```bash
cp /etc/systemd/system/coding-plan-router.service /root/.config/coding-plan-router/rollback/coding-plan-router.service.old
install -m 644 /root/.config/coding-plan-router/rollback/coding-plan-router.service.new /etc/systemd/system/coding-plan-router.service
systemctl daemon-reload && systemctl start coding-plan-router
```

切换后会中断在途请求，客户端重试即可。验证项：

```bash
systemctl is-active coding-plan-router
PID=$(systemctl show -p MainPID --value coding-plan-router); ls -l /proc/$PID/fd | grep -E '\.db'
curl -s http://127.0.0.1:8740/api/route/status | head -c 300
curl -s 'http://127.0.0.1:8740/api/audit/requests?limit=1'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8740/          # 看板
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8741/v1/models # 无 key 应 401
ls /root/workspace/services/coding-plan-router/*.db*                    # 不应出现新库/新 WAL
```

必须同时确认：进程打开的 fd 指向 `~/.local/share/coding-plan-router/`、会话钉死条数与账本行数不少于迁移前、源码目录没有新生成空库。只看 `systemctl is-active` 不够——空库也能 active。

## 回滚（代码回退 ≠ 数据恢复）

代码回退（不丢数据，最常用）：

```bash
ln -sfn /root/.local/lib/coding-plan-router/releases/<旧版本> /root/.local/lib/coding-plan-router/current
systemctl restart coding-plan-router
```

整体退回旧部署（unit + 旧配置路径 + 源码目录里的库）：

```bash
install -m 644 /root/.config/coding-plan-router/rollback/coding-plan-router.service.old /etc/systemd/system/coding-plan-router.service
cp /root/.config/coding-plan-router/rollback/env-before-move /root/workspace/services/coding-plan-router/.env
chmod 600 /root/workspace/services/coding-plan-router/.env
systemctl daemon-reload && systemctl restart coding-plan-router
```

数据恢复（会丢数据）：把 `backups/<时间戳>/` 里的库复制回目标路径，**切换之后写入的会话钉死与账本会丢失**，这是没办法的事——回滚代码不会自动恢复数据，恢复数据也不等于回滚代码。恢复前先停服，恢复后核对行数与 `max(id)`。

## 引用同步清单

改这些路径时，以下位置的绝对路径要一起改（`AGENTS.md` 的规矩）：

- `/etc/systemd/system/coding-plan-router.service`
- 技能 `coding-plan-router` 的 `scripts/probe-upstream-speed.mjs`、`scripts/stream-passthrough-probe.mjs`（默认读生产 `.env`）
- 技能 `vps-services` 的服务表、`service-diagnostics` 的会话归属参考
- 本仓 `README.md`、`AGENTS.md`、`.scratch/coding-plan-router/` 里的部署记述
