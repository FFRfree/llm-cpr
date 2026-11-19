# 02 策略回放测试：用真实流量沙盘 decide 改动

Status: completed
Blocked by: (resolved: 01)

## 验收

- [x] 回放 harness：读取捕获库的历史请求（按时间范围/租户过滤），逐条喂给
      新旧两个 policy 实例跑 decide（正常路由 + 403/429 改绑两个决策点），
      输出对比报告：路由决策分布、改绑次数、撞墙处理差异。
- [x] 回放只调 decide，不碰真实上游、不发真实推理、不写生产账本
      （dry-run 性质，对齐用户「内置 dry-run 自测」偏好）。
- [x] ctx 构造与 server.ts 的真实决策点同源（复用/抽取同一构造代码，别手搓第二份）。
- [x] 报告人类可读（终端表格即可），关键数字与「旧策略基线」逐项对齐。

## 设计要点

- 决策点复用是本票成败关键：decide 的输入契约在 `core/policy/contract.ts`，
  真实构造点在 `core/http/server.ts` 的正常/错误两处 ctx 构造——回放必须吃同一构造器，
  否则测的不是真实行为。
- 撞墙状态的回放需要快照/错误上下文：捕获库若只存正文，error 决策点的
  `ctx.error`（backend/status/retryAfterMs）要能从账本失败行还原；不行就在
  票 01 的捕获面补一条（在 01 范围内加列是加法迁移）。
- 形态开放问题：独立 CLI（`cpr replay`？）还是管理口？给用户方案拍板。

## 开放问题

- 回放时钟：快照轮询/冷却窗口是时间敏感逻辑，回放用录制时间还是加速时钟？

## Comments

- commit 45e8626。落点：`core/policy/ctx.ts`（decisionCtx/candidateViewOf/routeScope——
  server.ts 正常路由与改绑两处决策点重构为同源工厂，回放吃同一构造器）+
  `core/observability/replay.ts`（replayPolicy + renderReplayReport）+ `scripts/replay-policy.ts`
  CLI（--capture-db/--db/--policy/--baseline/--tenant/--since/--until/--limit/--json）。
  形态：独立 CLI（不走管理口——回放是开发者动作，读侧慢查询不上服务）。
- 口径决定：回放时钟 = 录制时间（turn.ts）；快照额度状态不回放（捕获库不存历史快照，
  walled 全 false，报告尾注写明这一层）；改绑决策点只重放走到决策点的失败笔
  （data.db 403/429 账本行按 capture_id 关联；原地短重试不落账本，两边口径一致），
  retryAfterMs 恒 null；沙盘 affinity = 该 policy 自己上一个决定的目标（模拟引擎钉死）。
- 验证：test/replay.test.ts 4 张（ctx 同源断言含 chars/messages/error/录制时钟、
  dry-run 全程只读且库文件逐字节未动、报告基线对照渲染、模型缺失跳过计数）+
  CLI 假夹具冒烟跑通。全量 `node --test` 182/182，typecheck 干净。
- 没做的验证：快照有值路径（walled 分支）的重放精度；builtin 兜底不在回放内
  （decide null 交内置的那半边是引擎逻辑，回放只测 decide 差异）。
