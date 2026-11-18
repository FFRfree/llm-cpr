# 06 — 测试基建：临时 clone + 可注入 systemctl，不用 Docker

**Status:** completed

**目标：** 02-05 的测试全部不触碰本机生产服务与真实 unit。结论先行：**不需要 Docker**——脚本操作面只有文件系统、git、systemctl 三样，前两样用临时目录天然隔离，第三样用注入。

## 手段

- **git 隔离**：`node --test` 里程序化造 fixture——临时目录建 bare remote + 若干工作 clone，按用例摆出五种状态（干净/领先/脏/又脏又领先/路径冲突）。全部落在 os.tmpdir，用完即删。
- **systemctl 注入**：脚本所有 systemd 调用走单一入口，`CPR_SYSTEMCTL` 环境变量可指向 stub 脚本（记录收到的 argv 到文件）；`CPR_UNIT_DIR` 指向临时目录。生产路径不受影响（未设变量 = 真 systemctl）。
- **端口**：冒烟用 `smoke-release.ts` 假上游（回环 + 自选端口），与生产 8740/8741 无交集。
- **交互**：测试下 stdin 非 TTY + `--yes` 或预写管道喂回答。

## 用例矩阵（最少集）

| 用例 | 断言 |
|---|---|
| 干净+领先0 | ff 完成、测试跑过、未注入 restart（默认 N） |
| 干净+领先N+yes | rebase 成功、restart stub 收到一次 |
| rebase 撞冲突 | abort、退出非零、工作树逐字节还原、冲突清单打印 |
| 脏跟踪文件 | 拒绝、文件点名列出、零写操作（stub 零调用） |
| uninstall | unit 删、数据 mtime 不变；--purge 无确认不动 |

## 验收

- 全套测试在无 systemd 权限环境（CI 语义）也能跑（注入生效时根本不调真 systemctl）。
- 跑完测试后本机 `systemctl list-units | grep coding-plan-router` 与跑前一致。

## Comments

- 2026-11-18 落地（commit ce8bf5b）。实现差异：fixture 用「最小仓 + 拷贝 scripts/」构造而非整仓 clone（fixture 只需 repoRoot 检查项 + 被跟踪文件，避免测试套件递归跑自身）；systemd 走 `CPR_SYSTEMCTL` stub（argv 记日志）+ `CPR_UNIT_DIR/CPR_CONFIG_DIR/CPR_DATA_DIR` 注入；`CPR_TEST_CMD/CPR_SMOKE_CMD` 接缝让 install/upgrade 检查秒回。
- 12 条用例（doctor / install ×2 / upgrade ×5 / uninstall / main.ts ×3）全过；跑测试前后本机 `coding-plan-router.service` 无任何真实调用（stub 记账断言零 restart 未授权分支）。
- 没做的验证：CI 语义（无 systemd 权限机器）未实测，但注入生效时不调真 systemctl，理论可跑。
