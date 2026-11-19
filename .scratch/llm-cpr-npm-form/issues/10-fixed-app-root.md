# 10 代码安装区固定 + 目录统一 ~/.llm-cpr（ADR-0009）

Status: completed
Blocked by: 05, 09

背景（2026-11-19 用户提出）：npm -g 装进用户 node 环境的全局目录——位置不固定（nvm/apt/Homebrew 各不同）、多副本无构造防线（nvm 切版本丢命令、多包管理器可各装一份）、目录名分裂（包 llm-cpr vs 目录 ~/.cpr）。用户拍板「统一成 llm-cpr」。

## 验收

- [x] 目录字面量 `~/.cpr` → `~/.llm-cpr` 全仓改名（paths.ts/main.ts/server.ts/cpr.ts/policy.example.ts/两测试/AGENTS.md；历史记录 ADR-0008 与 .scratch 原样保留，翻案写进 ADR-0009）。
- [x] 代码安装区固定：`~/.local/lib/llm-cpr/versions/<v>/` + `current` 软链（flipCurrent 先建新链再 rename，原子）；`~/.local/bin/cpr` → `current/bin/cpr`；npm 只当下载器（`install -g --prefix`，实测落点已验证）；接缝 CPR_APP_ROOT/CPR_BIN_DIR。
- [x] install：npm 下载自版本号目录 → flip current → 命令软链（已有异指软链/实体文件拒绝改）→ bootstrap 副本退役提示 → 补丁打版本目录 → 冒烟 → unit 钉 current（版本无关，永不重写）→ linger → 启动。
- [x] upgrade：下载新版本目录（current/服务全不动）→ 补丁打目标目录（冲突=拒绝，current 未切换零回滚动作）→ 切换前冒烟（失败=current 未动）→ flip → 健康门；失败回滚=软链拨回（零网络），成功后 prune（保留当前+上一版）。
- [x] uninstall：删 unit + 命令软链（只删指向自家的）+ 代码安装区整体移除；数据/密钥仍永不静默删。
- [x] doctor：MODE 三态（clone/固定位置/bootstrap）、VERSION=软链 basename、BIN 三态（没链/PATH 缺/就位）+ NEXT 链。
- [x] 测试夹具换机制：npm stub 模拟真 --prefix 落盘（拷 CPR_NPM_SOURCE + 建 bin 软链）、systemctl stub 按真实 current 软链判活（CPR_VERSION_STATE 退役）；回滚用例断言「零 npm 重下」、冲突用例断言「软链未动」、uninstall 用例先 install 建立真实状态。

## Comments

- ADR-0009 已落（docs/adr/0009-fixed-app-root.md），含「为什么不是别的」三段（不回 XDG 三拆 / 不全塞点目录 / 位置选 lib 的诚实理由）。
- 验证：`npm run typecheck` 0 错；`node --test` 20/20（user-scripts）+ 全量 156/156。
- 没做的验证：真 systemd 一次性 e2e（发布前照惯例现场构造，工单 11 待立）；macOS LaunchAgent 仍 experimental。
