# 整体 review（第二轮）findings 与修复

时间：2026-11-19；审阅人：独立 subagent（只出 findings 不改码）；范围：`git diff 3a46ab2..HEAD`（工单 05/06/09/10/07/08 全部新机器）；基线：typecheck 0 错 + `node --test` 158/158。
用户拍板：不再逐票 review，一把整体审。

## Findings（5 P2 / 0 P1）与修复

| # | 发现 | 修复 |
| --- | --- | --- |
| 1 | `cpr upgrade --to <版本>` 未校验就参与路径拼接：`../evil` 可把 npm `--prefix` 落到 versions/ 之外、把 current 指向安装区之外 | 新增 `VERSION_RE`/`versionId()` 白名单（semver 形态、无路径分隔符）；`--to`、registry 来的 latest、install 的自版本、flipCurrent 入参四道全过检 |
| 2 | install 先切 current 后打补丁/冒烟：失败返回时 current 已指向未验证版本，下次重启服务悄悄跑上没验过的代码 | flip + 命令软链整体后置到冒烟通过之后；失败 = current 未切换；与升级路径同纪律（过门才拨链） |
| 3 | uninstall 只在 active 时 disable：服务 inactive 但仍 enabled 时，删 unit 文件会留下 `default.target.wants` 自启链 | inactive 分支补一次 disable（unit 文件存在时），报错容忍（可能本就未启用） |
| 4 | 05 重写丢掉 v0.1.0 生产 unit 的沙箱四行（NoNewPrivileges/PrivateTmp/ProtectSystem/ReadWritePaths）——已对拍 `/etc/systemd/system/coding-plan-router.service` 坐实 | unit 模板恢复四行，`ReadWritePaths` 改指新数据目录 `~/.llm-cpr`；install 测试加四行断言防再丢 |
| 5 | flipCurrent 毫秒时间戳临时链名：并发 install/upgrade 可撞名互踩、rename 到别人的链 | 临时名改 `crypto.randomUUID()`；翻转后 readlink 核对 basename 与期望一致，不一致 die |

## 验证

- 新增测试 3 例：`--to ../evil` 白名单拒绝零动作、install 补丁冲突 current 不切（伪造 0.3.0 bootstrap 副本端到端复现）、unit 沙箱四行断言。
- 全量：typecheck 0 错 + `node --test` 160/160。

## 审阅人核对无恙的不变量（摘要）

- 用户补丁探测语义（GNU patch 方向自翻转坑、纯新增型幂等）实现与测试一致；`--batch` 全程。
- 测试接缝全集钉 tmp，不摸真实家目录/生产服务；fixture 跑拷贝里的 cpr.ts。
- 版本端点缓存窗口与降级、看板只在交互时请求。
- uninstall 数据红线（--purge 显式确认）、密钥不打印。
