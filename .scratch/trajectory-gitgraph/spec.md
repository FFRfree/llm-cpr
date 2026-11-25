# 轨迹页 git-graph 前缀树（trajectory-gitgraph）

状态：实现完成待 review
下一步：全量自测 + 独立 review，之后才谈 MR/部署（逐次授权）

## 背景（2026-11-25 用户拍板）
轨迹页中列原为「线程内平铺列表」，重试/延续/分叉靠小标签区分，读不出结构。
用户在原型（/root/ffr-scratch/2026-11-25-cpr-trajectory-tree/proto/，v3 形态已拍板）确认：
- 形态 = git-graph：泳道圆点 + 贯穿轨道线 + 分叉曲线；节点 = 一个消息前缀（对话状态）。
- 同一前缀的重试收进 ×N 节点；主干 = 最长链，也算一条分支，可勾选隐藏。
- 左栏列出全部分支（含 ★ 主干），勾选决定渲染哪些链；隐藏主干后分支各自成轨。
- 引擎零新增概念：父子/泳道/分叉数据全部来自已有 cache-forensics。

## 票
- 01 引擎：cacheChain 条目带 refs（前端建树的单次数据源）— completed
- 02 前端：trajectory.html 中列改 git-graph + 分支栏 + ×N 尝试切换 — completed

## 决策记录
- refs 进链条目而非 listTurns：取证接口本来就是建树的单次调用，且 refs 与 turns/:id 同源无新增暴露面。
- contentText 结构化 content 改为拼接 text part：线程 label / 分支预览出原始 JSON 是噪声（真数据验证发现）。
- 泳道分配 = 「子孙最多的孩子继承父道」（主干连贯左轨，git graph 惯例）；原型阶段按 ts 首子继承会主干跳道。
- 节点第二行标签 = [角色] 第 N 条起 +K；预览文本懒加载（只 fetch 分支根/主干根的正文，≤12 个）。
- 状态点数据来自账本 requests（按 capture_id 分页对回），随会话加载二次渲染。
- 页面时区沿用现状（toLocaleTimeString 设备本地），本票不动时区口径。
