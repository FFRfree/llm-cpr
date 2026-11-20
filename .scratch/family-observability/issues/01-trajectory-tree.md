# 01 轨迹页树形（deleg 家族视角）

Status: ready-for-agent

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

- [ ] 交错落库的两个线程在树中各归各的分支（label 可读、互不串行）
- [ ] 单线程会话退化为单行，不出现多余的折叠层
- [ ] 轮次 flag 用线程内口径；切孩子边界不显示「前缀断裂」警示
- [ ] capture_id URL 参数直定位行为保持
- [ ] node --test 全绿（admin-dashboard.test.ts 覆盖静态分发不回归）

## Comments

- 2026-11-20：立项。树形交互原型已经用户过目认可（批次目录 trajectory-proto-tree.html）。
