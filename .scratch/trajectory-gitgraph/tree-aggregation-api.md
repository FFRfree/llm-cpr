# 轨迹页聚合下沉：tree + tree-diffs 两接口（设计 v2，2026-11-26）

状态：设计完成，待用户拍板后实施。取代 turn-diffs-api.md 的 v1（客户端报 parent_len 的方案作废——
树归后端后，客户端不再需要知道 parent_len，v1 的 POST 清单就没有存在必要了）。

## 前后端分工（用户定调：后端聚合、前端轻展示）

**后端拿走的（重活）**：
- buildForest——O(n²) refs 前缀比对找爸爸、×N 重试归并、thread_key、压缩续段/线程起点判定；
- 新增段角色（added_roles）——content 表按需批量查，前端不再拉正文才知道第一条是 assistant；
- 家族摘要（效率/浪费/重读/tok 数）——复用 core 已有 cacheEfficiency + usageByCaptureIds；
- 新增段的正文组装——content IN 批查（顺带把现 turnBody 的逐 hash N+1 一并解决）。

**前端保留的（展示态）**：
- 分支显隐（chips 开关是 UI 状态，buildBranches 留在前端做纯 O(n) 树遍历；不涉及 refs 比对）；
- 泳道几何（drawRail）、气泡渲染、展开/收起、×N 切换、深链定位。

前端从此**不再持有 refs 哈希数组**：树接口只回 parent/parent_len/added_count/added_bytes/thread_key/roles，
元数据载荷反而变小（240 轮 × 上百个 64 位哈希 ≈ 1.5MB 的哈希清单不再出网），隐私面也小了。

## 接口 1：GET /api/capture/tree

```
GET /api/capture/tree?identity=gwk_…&tenant=hermes&limit=500
→ 200 {
  "nodes": [
    { "id": 0,
      "turns": [ { "turn_id": 3332, "capture_id": "chatcmpl-…", "ts": 1730000000000,
                   "model": "…", "message_count": 39, "bytes": 2345678,
                   "status": 200, "ms": 1234, "ttft_ms": 89 } ],   // ×N 重试收进来，ts 升序
      "parent": 3 | null,          // 树归后端的核心产物
      "parent_len": 8,
      "added_count": 2,
      "added_bytes": 5432,         // content.bytes 求和（正文被 TTL 清掉的条 null）
      "thread_key": "fc505c5cf6cf39",
      "added_roles": ["assistant","user",null,null] }  // 新增段前 4 条的 role，之后的 null
  ],
  "roots": [0, 7],
  "order": [0, 1, 2, …],           // 时间/拓扑序（前端按此画行）
  "summary": { "turns": 240, "threads": 2, "efficiency": 0.716, "waste": 0.284,
               "reread": 54, "tokens": 853445, "no_usage": 2 },
  "out_of_window": 0,
  "max_ts": 1730000000000          // 见接口 2 的 upto_ts
}
```

- 状态（status/ms/ttft）由后端按 capture_id join audit 账本（现在前端也是这么对的，只是搬到后端）。
- added_roles 只查每节点新增段前 4 条（全页一次 IN 批查 + 至多几百次小 JSON.parse），占位行和
  回答/输入判别够用；正文本身仍走接口 2。
- 树算法与现前端 buildForest 同口径：时间序逐轮找「refs 是其前缀」的更早轮取最长者为父；refs 完全
  相同的相邻轮并进同一节点（×N）。前缀比对 O(n²) 在 500 轮量级为毫秒级，先不优化（如成瓶颈再上
  指纹 trie）。

## 接口 2：GET /api/capture/tree-diffs

```
GET /api/capture/tree-diffs?identity=gwk_…&tenant=hermes&after=3332&upto_ts=1730000000000&limit_turns=60
→ 200 {
  "items": [ { "turn_id": 3332, "start": 8, "messages": [msg | null, …] }, … ],
  "next_after": 3355 | null,       // null = 本树取完了（done）
  "done": false
}
```

- **无请求体、纯游标 GET**（v1 的 POST 之辩就此了结：树在服务端后，游标翻页是天然的 GET 形状）。
- 服务端按**自己的树**以 order 序展平逐节点逐尝试吐新增段，`after` = 上页最后一个 turn_id 续传。
- `upto_ts` = 客户端树快照的 max_ts：保证 diff 流恰好覆盖客户端手里那棵树，活会话中途进新轮次
  也不会串页（新轮次要新数据就重拉 tree，刷新即可）。
- 分页守护沿用 v1：单页 ≤ limit_turns（默认 60）且累计新增正文 ≤ 2MB，先到即停；
  **孤轮豁免**——单轮新增独自超 2MB 时该轮单独成页返回（否则客户端永远拿不到它）。
- 正文缺失（TTL 半截清理）：该条 message=null，客户端渲染「[正文已被清理]」占位气泡；turn 整条
  不在库 → 不出现在 items（客户端该行保持占位并按树里的 status 呈现）。
- 服务端一次 `SELECT body FROM content WHERE hash IN (本页全部新增哈希)`，消灭 N+1。

## 客户端改造（trajectory.html）

- loadTurns：`/api/capture/turns?…` + 本地 buildForest → 改为一次 `GET /api/capture/tree`；
  state 里 refs/parentLen/roleByHash 相关逻辑退役，占位行用 tree 的 added_roles。
- fillAll（逐轮 getBody）→ 改为循环 `GET /api/capture/tree-diffs`（after=next_after）直到 done，
  每页落地 → 对应行 renderBubbles + 进度 chip「气泡填充 120/240」；页失败 → 该页轮次回退
  `GET /api/capture/turns/<id>` 单轮兜底（接口保留）。
- buildBranches 留前端，输入从「refs 数组」换成「parent 指针 + thread_key」。
- 摘要行直接用 tree.summary，前端效率计算退役。

## 兼容与验证

- `GET /api/capture/turns`、`/turns/<id>`、`/cache-efficiency` 等全部保留不动（老客户端/深链/兜底）。
- 核心测试（admin-backend.test.ts / capture.test.ts 增补）：
  tree——父指针正确性（线性/分叉/×N 归并/压缩续段无父）、thread_key 口径、added_roles 前 4 条、
  summary 数值与 cache-efficiency 一致、limit 窗口与 out_of_window；
  diffs——游标续传、两守护截断、孤轮豁免、message null 半截降级、upto_ts 过滤。
- traj-probe 增补：常规路径网络 = 1 次 tree + ceil(轮数/60)+1 次 tree-diffs，0 次 /turns/<id>；
  行数/气泡/chips 断言与现版一致。
- 实测验收：dev 实例开 gwk_1745（240 轮），瀑布应只剩 ~6 个请求，总传输 ~14MB（gzip 前）。

## 实施顺序（拍板后）

1. core：capture.buildTree / treeDiffs + admin 两路由 + 测试；
2. dashboard：trajectory.html 切换 + 探针口径更新；
3. 实测对比（网络瀑布前后截图）→ 独立 review → push + MR + 发版（逐次授权）。
