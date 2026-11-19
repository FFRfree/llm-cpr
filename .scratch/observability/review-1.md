# 观测层批 review（2026-11-19，findings-only 子代理，commit 45e8626 + c87b87b）

审查范围：c7f4175 → HEAD；不变量十条 + 历史踩坑探针清单（SQLite 触发器拒写、持锁竞争、
null-prototype 行、INSERT 列数、tsconfig include、模板反引号、json_each(NULL)、夹具日期）。

## Findings 与处置

- P1 `core/store/capture.ts` cacheChain：limit 不限 SQL 行数（全量读取后内存 slice），
  长会话下 /api/capture/cache-forensics 会同步拖住同进程转发 → DoS 面。
  **已修**：SQL 层 `ORDER BY ts DESC, id DESC LIMIT ?` 取最新 N 轮再逆序恢复升序；
  回归测试 test/observability.test.ts（limit=3 取最新 3 轮、升序、窗口外首条 prev=null）。
- P2 `core/store/capture.ts` toolStats：ASC+LIMIT 截断保留的是窗口内最旧轮次，
  报告却标注完整窗口 → 分析失真。**已修**：取最新 cap 条再正序聚合；报告新增
  `turns_truncated` 与 `covered_since`（实际覆盖起点）；回归测试（max_turns=10 /
  11 轮夹具：early_tool 被截掉、late_tool 全保留、truncated=true）。

## 不变量核查结论（子代理逐条）

十条设计不变量全部核过：正文/原文不落 data.db 与日志、未 opt-in 零痕迹、热路径预算、
降级锁存、TTL 引用保护、ctx 同源（server 两处决策点与回放共用构造器，重构逐行核过）、
回放只读+近似写进 notes、增量判重时序、并发/定时器/close 竞争——除上面两条读侧
查询边界外未见问题。修复后全量 `node --test` 184/184、typecheck 干净。

## 结论

P1/P2 修复并配回归测试后，本批达到「可用」状态。
