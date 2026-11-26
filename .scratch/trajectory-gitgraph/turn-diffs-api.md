# 轨迹页取数聚合：turn-diffs 批量接口（设计，2026-11-26）

状态：设计完成，待用户拍板后实施。相关：trajectory.html 气泡流（c2c0684/5f34539）。

## 现况与代价（实测 gwk_1745，240 轮）

- 页面每轮打一次 `GET /api/capture/turns/<id>`（fillAll 5 并发 → 240 个请求）。
- 每个请求返回该轮**完整请求体**（全量 messages）——同会话轮次共享前缀，等于把整段对话重复下载 N 次。
- 逐轮全文总量 **543.4 MB**（平均 2.3 MB/轮）；气泡 UI 实际只需要每轮**新增段**（相对父轮多出来的消息），diff 口径总量 **13.8 MB**（平均 59 KB/轮），约 **39×** 缩减。最大单轮 diff 2.8 MB（工具结果带文件全文的轮）。
- 服务端 `turnBody()` 现对每条 hash 逐条 SELECT（N+1）；批量化后改每页一次 IN 查询。

## 接口

```
POST /api/capture/turn-diffs
{ "tenant": "hermes", "items": [{ "turn_id": 3332, "parent_len": 2 }, ...] }
→ 200 { "items": [{ "turn_id": 3332, "start": 2, "messages": [msg|null, ...] }],
         "missing": [1234],            // turn_id 不在库（过 TTL）
         "content_miss": [{turn_id, index}] }  // 某条 hash 正文被清理（半截降级）
```

- `parent_len` 由客户端给——树结构（父轮/重试分支）是页面 buildForest 的产物，服务端不重复建模；服务端只按 `refs[parent_len..]` 取 content。`parent_len > refs.length` → 400。
- `messages` 里 null = 该条正文已被 TTL 清理：客户端渲染「[正文已被清理]」占位气泡，**半截降级**好过现在整轮 404。
- tenant 守卫与现有接口一致（turns.tenant 过滤）。

## 服务端分页上限

单页最多 **60 轮** 且累计新增消息 **2 MB**，先到即停，剩余由客户端对列表继续发下一页（游标=客户端自己的 items 下标）。两条守护：

- 处理严格按请求 items 顺序，保证游标推进无歧义。
- **孤轮豁免**：某轮 diff 独自超过 2MB 时单独成页返回（否则客户端永远拉不到它，死循环）。

## 客户端（trajectory.html）

- `state.bodies`(Map<turnId, full body>) → `state.addedByTurn`(Map<turnId, {start, messages}>)；`renderBubbles` 直接用 messages，不再 slice。
- renderStream 后把全部「轮 × parentLen」对切成页，**串行**逐页 POST（渐进：占位行随页落地逐行换气泡）；每页到达 → 对应行 renderBubbles + 工具条进度 chip「气泡填充 120/480」。
- 失败降级：某页失败 → 该页轮次回退旧的单轮 `getBody` 路径（接口保留），行不空白。
- ×N 尝试切换：每个 turn id 各有一条 diff 记录进缓存，切尝试直读。
- `roleByHash` 回填逻辑保持（diff 消息同样带 role）。
- fillRun 式 run-token 竞态防线保留：分支显隐触发 renderStream 重跑时重启取数序列，已缓存的跳过。

## 兼容与验证

- `GET /api/capture/turns/<id>` 保留：单轮深链、降级路径、老客户端。
- 核心测试（admin-backend.test.ts 增补）：正常批量、parent_len 越界 400、content 缺失半截降级、60 轮截断、2MB 截断、孤轮豁免、missing 上报。
- traj-probe 增补：页面网络里 turn-diffs POST 次数 ≤ ceil(对数/60)+1；常规路径 0 次单轮请求；气泡行数与现版一致。
- 实测验收：dev 实例打开 gwk_1745（240 轮），进度 chip 跑完、页可滚动、无卡死；DevTools 网络面板对比瀑布。

## 可选后续（不进本期）

- gzip（node:zlib，按 Accept-Encoding）——SSO 代理若已开压缩则收益有限，实测后定。
- 骨架期只拉每轮前 2 条 diff（收起态只露 2 条气泡）——省得更多但复杂度高，先看本版实测卡不卡。
