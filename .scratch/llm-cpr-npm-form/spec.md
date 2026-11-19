# v0.2.0 npm 形态改造：llm-cpr 分发

2026-11-18/19 三轮对话 + grilling 拍板。决策正本 = `docs/adr/0008-llm-cpr-rebrand-npm-form.md` + 决策票 `/root/ffr-scratch/2026-11-18-llm-cpr-npm-form/TICKET.md`（grilling 已定/执行记录）；本文为工单化 spec。

## 动机

v0.1.0 clone + git 升级对普通用户门槛高（要懂 git、systemd、XDG 布局）。目标用户扩展到「买了 coding-plan 订阅、在终端用 agent 的人」；Linux 一等公民，macOS 随版但 experimental。改名与品牌串已先行执行（Forgejo/本地仓/技能/hub/登记卡，见票执行记录）。

## 方案

- **npm 单轨**（包 **`@ffrfree/llm-cpr`**——2026-11-19 scoped 化（工单 11）：scope = 用户 npm 用户名 `ffrfree`，无需建 org；裸名 `llm-cpr` 留 npmjs 不占；发布必须 `--access public`。bin 仍 `cpr`）+ clone 留给引擎开发者；v0.1.0 视为零真人用户，v0.2.0 破坏性重来，不写 clone→npm 迁移。
- **`~/.llm-cpr` 单目录**（policy.ts / .env / data.db / backups/ / patches/；`os.homedir()` 三端同构；2026-11-19 从 `~/.cpr` 改名，ADR-0009）；`CPR_CONFIG_DIR`/`CPR_DATA_DIR` 接缝保留。
- **代码安装区固定**（工单 10，ADR-0009）：`~/.local/lib/llm-cpr/versions/<v>/` + `current` 软链 + `~/.local/bin/cpr`；npm 只当下载器（`install -g --prefix`），与用户 node 装法解耦、单实例有构造保证；升级 = 下载新目录 → 打补丁 → 冒烟 → flip → 健康门，失败 = 软链拨回（零网络）；版本保留当前+上一版；unit 钉 current 永不随版本重写。
- **用户级服务免 sudo**：Linux `systemctl --user` + install 顺手 `loginctl enable-linger`；macOS LaunchAgent。
- **升级 = `cpr upgrade`**：npm 装新版 → 迁移前备份 → y/N 重启 → 启动路径自动迁移 → 健康检查，**失败自动装回旧版**；`--to <版本>` 手动退版。
- **迁移三件套**：`PRAGMA user_version` 有序步骤表内建启动路径（fail-fast）；**只做加法迁移**（破坏性走离线工具）；迁移前 WAL checkpoint + 备份 + integrity check。
- **探新版只在用户交互时**：看板打开经管理口现查 npm registry（缓存 1h）、`cpr doctor`/`upgrade` 现查；进程绝不定期轮询。
- **policy 落点外置**：`~/.cpr/policy.ts` 存在则优先，否则内置 `mine.ts`；policy 文件对引擎仅 `import type` 依赖（运行时零依赖已核实）。
- **用户补丁（工单 09，已完成 9e2a21c）**：`~/.cpr/patches/*.patch` 是 policy 契约之外的逃生门——install/upgrade 自动打到 npm 包上（探测式幂等），打不上=升级失败走回滚，doctor 显性报四态；零 npm 依赖走系统 patch 二进制。**实现坑留档：GNU patch 会自作主张翻转方向（四种方向组合全 exit 0），幂等判定必须读输出标记 `Reversed (or previously applied)`，退出码不可用**。正门仍是 policy 钩子，补丁只救契约表达不了的引擎级诉求。
- 本机 VPS 终态切产品同款；**生产切换逐次授权**（含 root 跑 user unit 的 linger 姿势、看板域名换名，届时单独拍板）。

## 边界（第一版不做）

- Windows 不做；macOS 无真机，launchd 不实测、标 experimental。
- 单文件二进制押后（bun compile 默认拒绝运行时加载外部 TS，会逼「配置即代码」退回「配置即数据」；届时策略层先做 TS→JSON 降级）。
- 进程不做 registry 定期轮询；管理口仍只绑回环。
- `backends[].name` 身份键绝不改；`.scratch/` 历史工单原样保留。
