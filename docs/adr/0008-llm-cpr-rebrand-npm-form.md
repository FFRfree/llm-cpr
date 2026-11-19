# 改名 llm-cpr 与 v0.2.0 分发形态：npm 单轨 + ~/.cpr 单目录

背景：v0.1.0 以私有 Forgejo 仓 clone + git 升级分发，正式身份沿用全名 coding-plan-router（曾拍板“正式身份不改”）。2026-11-19 用户重新拍板：项目正名 **llm-cpr**，并把分发形态从“clone 门槛”升级为面向 Linux/macOS 普通用户的产品（grilling 四问四答，票 `/root/ffr-scratch/2026-11-18-llm-cpr-npm-form/TICKET.md`）。

决定：**npm 包 `llm-cpr` 是普通用户的唯一分发轨道，clone 保留给引擎开发者**；配置与数据统一进 `~/.cpr` 单目录（policy.ts / .env / data.db / backups/）；服务一律用户级（Linux `systemctl --user` + `loginctl enable-linger`，macOS LaunchAgent），安装不需要 sudo。

- 名称：包名/仓库名/unit 名统一 `llm-cpr`（`llm-cpr.service`），用户目录用短名 `~/.cpr`，命令行 `cpr`；`CPR_*` 环境变量前缀与 CPR 称呼保留。
- policy 落点从「仓库根 policy.local.ts」改为「`~/.cpr/policy.ts` 存在则优先，否则内置 `mine.ts`」——policy 文件对引擎只有 `import type` 依赖（运行时被类型擦除抹掉），住哪都能加载；从此 npm 升级/重装不再可能冲掉用户定制。
- 升级 = `cpr upgrade`：npm 换代码 → 迁移前自动备份 → y/N 确认重启 → 健康检查，**失败自动装回旧版**；DB 迁移内建启动路径：`PRAGMA user_version` + 有序步骤表，**只做加法迁移**（加列/加表/加索引），破坏性变更走离线工具或“新表+搬数+换读”；加法纪律保证“旧代码跑新库”可回滚。
- 探新版只在用户交互时发生（`cpr doctor`/`cpr upgrade` 现查、打开看板经管理口现查并缓存），进程不做定期 registry 轮询。
- 「配置即代码」（ADR-0001 一系）不翻案：policy 仍是 TS 类、冷启动加载、坏声明拒绝启动；变的只是加载落点。
- 本机 VPS 终态与外部用户同款（`~/.cpr` + npm 全局包 + 用户级服务，root 跑 user unit 的 linger 姿势切换前单独拍板）；生产切换逐次授权。

否决的替代方案：预编译二进制（编译产物默认拒绝运行时加载外部 TS，policy 钩子被掐死，等价把配置逼回 JSON 数据）；看板常驻轮询 npm registry（无人交互零流量原则）；XDG 三层照搬到三端（Windows/macOS 上同为“外来户”，不如家目录单点统一，git `~/.gitconfig` 与 Claude Code `~/.claude` 先例）。
