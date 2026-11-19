# ADR-0009：代码安装区固定 + 目录统一 ~/.llm-cpr（工单 10）

日期：2026-11-19
状态：已接受（v0.2.0 未发布窗口内实施，零兼容包袱）
部分取代：ADR-0008 的「用户目录用短名 ~/.cpr」与「npm 全局包」两处结论；其余（npm 单轨、用户级服务、policy 外置）不变。

## 背景

v0.2.0 原 design：npm 包走 `npm install -g` 装进用户 node 环境的全局目录。三个问题（用户提出）：

1. **位置不固定**：全局目录由用户装 node 的方式决定（nvm/apt/Homebrew 各不同），doctor 虽能打出来，但「代码在哪」没有稳定答案。
2. **多副本无构造防线**：nvm 多 node 版本各有一份全局目录（切版本丢命令），多包管理器并存可各装一份——「一台机器最多只需要一个 cpr」没有结构性保证。
3. **目录名分裂**：包名 llm-cpr、目录 ~/.cpr，用户认知成本（两次把 ~/.llm-cpr 写成目录名的直觉信号）。

## 决定

**npm 只是下载器，位置我们自己定**（`npm install -g --prefix <我们的目录>`，实测落点 `<prefix>/lib/node_modules/llm-cpr` + npm 自建 `<prefix>/bin/cpr` 软链）：

```
~/.llm-cpr/                     归用户：policy.ts / .env / data.db / backups/ / patches/
~/.local/lib/llm-cpr/            归安装器：versions/<版本>/ + current 软链
~/.local/bin/cpr                 归 PATH 惯例：→ current/bin/cpr
~/.config/systemd/user/llm-cpr.service   归 systemd（macOS: ~/Library/LaunchAgents）
```

- **目录名统一 llm-cpr**（原 ~/.cpr 废弃）：包/仓库/unit/用户目录全同名；命令仍 `cpr`、环境变量仍 `CPR_*`（使用面短名、身份面全名，claude-code→claude 先例）。
- **versions + current 软链**（Homebrew Cellar/opt、SDKMAN current 同款）：切换原子（先建新链再 rename）、回滚零网络瞬时（拨回上一版目录）、单实例有构造保证（一根 current、一个 bin 软链）。版本保留当前+上一版，更老的升级成功后顺手清。**不提供任何用户侧版本切换命令**——这是升级机器的可靠性零件，不是功能。
- **升级顺序**：下载新版本目录（不动 current）→ 打用户补丁 → 临时库冒烟 → 全过才翻转 current → 重启健康门；补丁冲突/冒烟失败 = current 未切换、服务未动；健康门失败 = 软链拨回（零网络）。
- **bootstrap**：`npx -y llm-cpr install` 首装，npx 副本用后即弃；npm 全局目录从头到尾不出现我们的副本。
- **unit 钉 current 软链**：写一次永不随版本重写，升级翻转软链后 restart 即用新版。

## 为什么不是别的

- **不回 XDG 三拆**（~/.config + ~/.local/share）：XDG 是 Linux 一家规矩；受众方言是点目录（claude/codex/gemini）；一个目录的备份/迁移/--purge 故事值钱。XDG 最值钱的部分已收编：bin 进 ~/.local/bin（XDG 规范原话背书）、代码进 ~/.local/lib。
- **不全塞进 ~/.llm-cpr**：「一切在一个目录」物理上做不到（PATH 软链、systemd unit 是 OS 钉死的外挂）；归位原则是「谁的东西放谁的地盘」（用户/安装器/OS 三个地主），git/npm/claude 全是这个形状。代码混进用户目录还弄脏两件事：备份快照混入可再生的死重、民间「rm -rf ~/.xxx 重来」会连程序一起删。
- **位置选 ~/.local/lib 而非 ~/.local/share**：行业主流其实谁也不住 lib（老一代 SDKMAN/nvm/rustup 用自家点目录，新一代 uv/mise 用 share）——这个选择优化的唯一真实读者是本 VPS 巡检：与 fleet 既有约定「运行码 ~/.local/lib/<服务>、数据 ~/.local/share/<服务>」同框，生产切换零新地图。

## 后果

- cpr.ts install/upgrade/uninstall/doctor 四条路重写；测试夹具 npm stub 改模拟真 --prefix 落盘、systemctl stub 按真实 current 软链判活（版本状态文件机制退役）。
- 回滚从「npm 重新下载旧版」变为「软链拨回」，升级失败不再赌网络。
- 本机 VPS 生产切换终态：`~/.llm-cpr`（资产）+ `~/.local/lib/llm-cpr`（代码）+ 用户级 unit；切换仍逐次授权。
