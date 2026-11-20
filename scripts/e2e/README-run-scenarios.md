# README-run-scenarios.md — e2e 场景运行器（套件入口）

`run-scenarios.ts` 把 `fake-upstream.ts`（假上游）+ `cpr-instance.ts`（独立 llm-cpr 实例）+ `pi-driver.ts`（真 coding agent 驱动）拼成四个真跑场景，从仓根一行跑通：

```
cd /root/ffr-projects/llm-cpr && node scripts/e2e/run-scenarios.ts
```

## CLI 参数

| 参数 | 说明 |
|---|---|
| `--scenario=1\|2\|5\|6` | 可选，逗号分隔多选（如 `--scenario=1,5`）；缺省全跑 1/2/5/6 |
| `--repo-dir=<路径>` | 可选，npm pack 源目录；**缺省 = 仓根自身**（套件住在 `scripts/e2e/` 下，相对自身上两级推导）——“每次改动收尾跑一行”即零参数直跑 |
| `--worktree=<路径>` | 可选，覆盖 `--repo-dir`：指向别的工作树/检出（打样批次就是用它指向批次 worktree 的） |

打包对象始终经 `npm pack`（只含 `package.json` `files` 白名单），e2e 不 import 仓内代码、不直接跑仓内进程。

## 场景

- **1 冒烟+工具调用**：ok 剧本 + write 工具参数 + 1 实例；pi 建 `hello.txt`，内容/JSONL 工具事件/上游 record/账本/`route.bind` 全断言。已知偏差（文件头声明）：真实工具回路必然两轮 POST（工具轮+回灌轮），「恰 1 条」按「带工具调用的首轮恰 1 条」校验。
- **2 亲和粘住**：同实例同 `sessionId` 两轮 pi，都打 be-a；`route.bind` 恰 1 条、无 `route.rebind`，be-b 零聊天请求。
- **5 热更新三连**：(a) 首轮过 be-a → (b) decide 钉 be-b（热区，`policy.reload` 落账）→ (c) 语法坏文件保旧（`policy.reload.error`，错误摘要 ≤400 字符且不含文件全文/哨兵）→ (d) 冷区加 be-c，`cpr reload` CLI 喂 N 拒重启，随后仍走 be-b；`CPR_SYSTEMCTL` stub 记账断言零 systemctl 调用。
- **6 supervisor 换版本**（supervisor-upgrade 票 04）：pack → 版本根 9.0.0/9.9.9（+坏版本 9.9.8）+ `current` 软链 → 起 supervisor 实例。(a) swap 9.0.0→9.9.9 期间流量泵持续打推理口**零失败**，`/api/version` 的 version 与 workerPid 必变、收据落盘、`upgrade.swap` 落账、软链翻转；(b) 坏版本（永不上报 ready）swap 502 失败零损伤——软链回拨、旧 worker PID 不动、无收据无事件；(c) 9.9.9 注入 400ms 自灭 → 同版本换 worker → crash-loop 达标 → 收据自愈拨回 9.0.0 + `upgrade.rollback` 事件 + 回拨后服务正常。排水上限/ready 门在场景内钉短（`CPR_DRAIN_TIMEOUT_MS`/`CPR_SUPERVISOR_READY_TIMEOUT_MS`=3s，测试提速，零断粮语义不变）。

## 硬红线（脚本内强制）

- 端口断言避开生产保留口 `{8740, 8741}`（`pickPort` + 两个启动器双层各查一遍）。
- 绝不读写 `/root/.llm-cpr`、`/root/.config`、`/root/.hermes`（合规 TMPDIR scratch 区除外）：所有落盘路径 `assertPathSafe` 断言在套件 `runs/` 或 TMPDIR 下；CLI 进程再垫 `CPR_CONFIG_DIR`/`CPR_DATA_DIR` 改道。
- 绝不调用 systemctl 启停：唯一允许只读生产 PID 比对（`systemctl --user show llm-cpr -p MainPID,ActiveState`）；每轮 pi/CLI 跑前记生产 MainPID、跑后验不变，变了整套判失败。supervisor 形态下 MainPID = supervisor（worker swap 不改它）、旧形态下 MainPID = 网关进程——两种形态「跑前记、跑后比对不变」都成立；「worker PID 必变」只在 e2e 自建实例（场景 6）上断言。
- 收尾断言：无残留进程、所有用过的端口已关闭。

## pi-vendor（不进仓）

`pi-driver.ts` 首跑时自动 `npm install @mariozechner/pi-coding-agent@0.73.1` 到 `<仓根>/scripts/e2e/pi-vendor/`（需网络，约 1-2 分钟；之后版本一致即零安装复用）。该目录被 `.gitignore` 排除（`scripts/e2e/pi-vendor/`），不在 npm `files` 白名单里，永不进仓/进包。

## 运行产物

现场根 = `<仓根>/scripts/e2e/runs/<时间戳>/`（`.gitignore` 排除）：通过的场景现场即删，失败场景保留现场供排查；`--record` JSONL、systemctl stub 日志都在现场内。

## 验证协议（套件进仓时跑过）

从仓根位置连续两遍全绿（打包对象 = master 工作树）：

```
cd /root/ffr-projects/llm-cpr && node scripts/e2e/run-scenarios.ts   # 两遍，全 PASS
npm run typecheck                                                    # 过（tsconfig include 覆盖 scripts/**/*.ts）
node --test                                                          # 206/206（套件文件名不含 .test.、不在 test/，不影响发现）
```

## 慢车道（场景 8 安装层，`slow-lane/`）

快车道（本文件）隔离靠软护栏约定；**安装链路**（`cpr install`/真 systemctl/回滚）的回归走慢车道——rootless podman 容器内跑真安装，宿主零共享（`--network=none`，install 的 npm 流量落在容器内假 registry）。用法见 `slow-lane/README-slow-lane.md`：

```
bash scripts/e2e/slow-lane/run-slow-lane.sh   # 连跑 2 遍，每遍 17 步 report.json 判绿
```

何时用哪个：改引擎/路由/策略代码 → 快车道够用；动 `scripts/cpr.ts` 安装/升级/回滚逻辑或发布版本前 → 跑慢车道。
