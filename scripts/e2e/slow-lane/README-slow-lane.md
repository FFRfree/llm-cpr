# README-slow-lane.md — 场景 8：安装层 e2e（podman rootless 慢车道）

快车道（run-scenarios.ts 1–7）测的是**引擎运行面**；本慢车道测的是**安装层**：从 npm pack 产物出发，
把 `cpr install` 的完整用户流程（npm 下载 → 搬迁 → 补丁/冒烟 → current 翻转 → 软链 → 写 unit →
真 systemctl --user 启动）在一次性容器里跑通，再做健康验证与真转发冒烟。

## 设计拍板（与主会话一致）

- **rootless podman**（4.9.3，cgroup v2），专用非 root 用户 `e2e-cpr` 跑全流程。
- **镜像薄**：Ubuntu 24.04 + Node 22（NodeSource）+ systemd + dbus + libpam-systemd + git/curl/tar。
  故意不预装 llm-cpr——install 本身是被测对象。
- **pi/假上游/脚本运行时 bind-mount 进容器**（`/mnt/e2e` ro：fast lane 的 `fake-upstream.ts` + 本车道脚本；
  `/mnt/pkg` ro：主仓 npm pack 产物；`/mnt/run` rw：运行产物）。
- **不留端口到宿主**：容器 `--network=none`（只留 lo），全部组件（假 registry / 假上游 / 网关）在容器内
  127.0.0.1 互访；宿主只等容器退出 + 读 `/mnt/run` 产物。零外网由内核保证。
- **`--rm` 用完即弃**：容器内的 `~/.llm-cpr`、`~/.local/lib/llm-cpr`、`/tmp/cpr-bootstrap` 全部随容器销毁，
  与宿主同名路径完全是两套文件系统（硬红线：宿主 `/root/.llm-cpr`、`~/.hermes` 全程不碰）。

## 组件

| 文件 | 作用 |
|---|---|
| `Containerfile` | 薄镜像。systemd-as-PID1 纪律：STOPSIGNAL SIGRTMIN+3、/tmp 1777、/sbin/init 软链 |
| `image-files/etc/systemd/system/user@.service.d/10-xdg-runtime-dir.conf` | Ubuntu 24.04 的 user@.service 不自带 XDG_RUNTIME_DIR（上游 256+ 才有），不补这行 user manager 起不来 |
| `image-files/.../llm-cpr-e2e-driver.service` | 驱动 unit，镜像内预 enable（multi-user.target.wants 软链）；未挂 /mnt/e2e 时 Condition 不满足，裸容器照常启动 |
| `fake-registry.ts` | 本地假 npm registry（packument + tarball + /latest，SHA1/SHA512 现算）。让 `cpr install` 走真 npm 下载路径且零外网 |
| `run-install-e2e.ts` | 容器内驱动：17 步流水（见下），report 落 `/mnt/run/report.json` |
| `run-slow-lane.sh` | 宿主编排（root 跑）：用户/subuid 就位 → staging → 构建/产物 → N 遍容器跑 → 宿主生产 PID 比对 → 残留检查 |

## 驱动 17 步（run-install-e2e.ts）

artifact / version-parse / systemd-up（multi-user.target active）/ user-manager（user@0 + systemctl --user 可达）/
fake-registry / bootstrap-extract（tgz 解包成 bootstrap 副本）/ **cpr-install**（`node scripts/cpr.ts install --yes`，
npm_config_registry 指向假 registry）→ install-layout（current→versions/0.5.0、cpr 软链、unit 存在、is-active）/
admin-after-install（模板 policy 下 /api/route/status 200）/ **policy-restart**（按真实用户流程改写 policy.ts 指向假上游 +
systemctl --user restart）/ master-key（容器内随机生成，报告只留掩码）/ fake-upstream（复用 fast lane `fake-upstream.ts`，
scenario=ok，端口 8750——它对 8740/8741 的防撞守卫原样生效）/ admin-version / **forward-smoke**（POST 推理口 8741，
断言 200 + `e2e ok` + `data: [DONE]`）/ **upstream-ledger**（假上游 record 行：POST /chat/completions 且 model=test-model）/
**audit-ledger**（管理口 /api/audit/requests 含 test-model/fake-ocg）/ teardown。

## 命令

```sh
# 全流程（默认连跑两遍）：root 执行
bash scripts/e2e/slow-lane/run-slow-lane.sh        # [遍数] 默认 2

# 只跑一遍
bash scripts/e2e/slow-lane/run-slow-lane.sh 1

# 重建镜像（改了 Containerfile/image-files 后）
su - e2e-cpr -c 'cd /home/e2e-cpr/llm-cpr-e2e-stage/slow-lane && podman build -t localhost/llm-cpr-e2e:24.04 .'
```

staging 说明：`/root` 对 e2e-cpr 不可见，编排器把套件文件镜像到 `/home/e2e-cpr/llm-cpr-e2e-stage/`（e2e/、
slow-lane/、artifacts/、runs/）；每次绿跑的产物自动拷回批次目录 `runs/run-<i>-<时刻>/`。

## 验收口径

1. **连跑两遍全绿**：两遍 `report.json` ok=true、17 步全 PASS（绿跑产物：`runs/run-1-105859/`、`runs/run-2-105905/`，
   早前单遍绿跑 `runs/run-1-105843/`；失败迭代证据在 `.failed-attempts/`）。
2. **无残留**：`su - e2e-cpr -c 'podman ps -a'` 为空（`--rm` + 驱动结束 `systemctl --no-wall poweroff` 收容器）。
3. **宿主生产零干扰**：跑前后 `XDG_RUNTIME_DIR=/run/user/0 systemctl --user show llm-cpr -p MainPID,ActiveState`
   逐字比对，两遍全程 MainPID=2056785 / ActiveState=active 未变。

## 踩到的坑（都已在镜像/脚本里消化）

- **rootless podman 需要 RunRoot**：e2e-cpr 无登录会话 → `loginctl enable-linger` + 手建 `/run/user/1001`。
- **镜像缺 dbus**：`user-runtime-dir@0.service` 连不上 system bus 直接失败 → user@0 起不来；装 dbus 解决。
- **Ubuntu 24.04 user@.service 无 XDG_RUNTIME_DIR**：drop-in `Environment=XDG_RUNTIME_DIR=/run/user/%i` 补上。
- **`--systemd=always` + 命令覆盖不生效**（podman 4.9.3，PID1 仍是命令本身）→ 改走「CMD=/sbin/init + 镜像预 enable 驱动 unit」。
- **`/sbin/init --unit=X` 不会随 unit 结束退出 systemd**（oneshot 成败都不退）→ 驱动自己 poweroff 收容器。
- **rootless 容器内无 CAP_KILL**：`kill -9 1` 无效 → 成败裁决以 report.json 为准（容器退出码恒 0，
  驱动崩溃/超时由编排器 timeout -k 15 720 兜底判红）。
- **驱动 is-system-running 自锁**：驱动本身是 boot 的一部分，is-system-running 永远停在 "starting"（blame 里
  1min 的就是驱动自己）；就绪口径改成 `multi-user.target active`。
- **Node type-strip 不认 `#` 注释行**（fast lane 文件里能用是因为…单文件 `#!` shebang 才合法）→ fake-registry.ts 注释全 `//`。
- **容器内 enable-linger 失败属预期**（无 logind 设备），cpr install 自身容忍，不影响流程。
- **current 软链读出来是 `versions/0.5.0`**（不是裸版本号），断言按 endsWith 判。

## 红线清单（宿主侧）

- 绝不读写 `/root/.llm-cpr`、`~/.hermes`；对生产 llm-cpr 只做只读查询（systemctl --user show）。
- 容器内一切写入都在容器文件系统，随 `--rm` 销毁；staging 区 `/home/e2e-cpr/llm-cpr-e2e-stage/` 是唯一宿主侧中间产物。
- 构建镜像需要外网（apt/NodeSource），**运行期容器 `--network=none` 零外网**；`cpr install` 的 npm 流量全部落在假 registry。
