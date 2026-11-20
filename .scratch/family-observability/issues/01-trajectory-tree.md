# 01 轨迹页树形（deleg 家族视角）

Status: completed

## 背景

trajectory.html 中列把一个身份的轮次按时间平铺。deleg 家族（多个 subagent 共享父会话
身份）的轮次交错落库，平铺后看不出哪轮属于哪个孩子。树形（父会话 → 线程 → 轮次）与
家族结构同构。

## 方案

数据源用 02 的 `/api/capture/cache-forensics` 新增 `threads` 输出（不做第二个端点）。
中列改为：

1. 根行：会话（家族）徽标——线程数、总轮数、时间跨度（`threads` 汇总可得）。
2. 线程行：彩色圆点 + 线程 label（`threads[].label`，goal 开场白截断）+ 轮数 + 起止时间 +
   bytes，可折叠；默认全部展开。
3. 轮次行：挂在线程下，时间 + 消息数 + bytes；flag 改用线程内口径
   （`common_prefix_in_thread`/`first_diff_in_thread_*`）标「新增/断裂」，
   跨线程边界（`boundary: 'thread-switch'`）不显示断裂警示。
4. 右列单轮正文渲染逻辑不变；轮次点击行为不变；URL 参数（identity/capture_id 定位）行为不变。

单线程会话（绝大多数普通会话）显示为「根 + 1 线程」的退化树，不得比现在难读：
根行与线程行合并为一行展示（无线程徽标、无折叠层）。

## 验收

- [x] 交错落库的两个线程在树中各归各的分支（label 可读、互不串行）
- [x] 单线程会话退化为单行，不出现多余的折叠层
- [x] 轮次 flag 用线程内口径；切孩子边界渲染「↩ 切线」小标、不显示「前缀断裂」
- [x] capture_id URL 参数直定位行为保持
- [x] node --test 全绿（admin-dashboard.test.ts 覆盖静态分发不回归）

## Comments

- 2026-11-20：立项。树形交互原型已经用户过目认可（批次目录 trajectory-proto-tree.html）。
- 完成 commit：e6dca52（初版）+ review 修复批（本提交）。中列栅格 200→260px；
  轮次行缩进 + 引导线；紧凑 HH:MM:SS（fmtClock 带全日期会撑出横向滚动，视觉复查后修）。
- 验证：`node --test` 218/218、`npm run typecheck` 过、trajectory.html 内联脚本
  `node --check` 过；**真浏览器 UI 冒烟 13/13 全过**（无头 Chrome + CDP，探针
  `/root/ffr-scratch/2026-11-20-llm-cpr-subagent-capture/ui-probe.mjs`，截图
  ui-smoke-trajectory.png）——覆盖树形分组/label/切线/线程内断裂标记/折叠/正文展开/
  单线程退化/效率条/零运行时错误；截图复查确认无横向溢出、层级清晰。
- 独立 review findings 正本：`/root/ffr-scratch/2026-11-20-llm-cpr-subagent-capture/review-findings.md`。
- 没做的验证：生产真实数据下的视觉走查（冒烟为合成三会话夹具）；手机视口（桌面后台页）。
