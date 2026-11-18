# 1 — Policy-as-code：config.json 退役，声明+路由逻辑全部收进用户 policy class

**Status:** completed

**目标：**把「声明」（订阅、模型映射、端口、knobs）和「策略」（每个请求路由给谁）合进一个用户可写的 TS class（`RouterPolicy`），引擎只保留传输/鉴权/翻译/账本/护栏；decide() 每请求必问（含 403/429 重试），null 交内置兜底。config.json 不再被引擎读取，不留兼容读取路径（Q3 决定，回滚 = 切回旧 release）。

**已拍板的决策（grilling 结论，2026-11-17）：**
- Q1 一次到位：decide 契约从第一天就是每请求调用，`DefaultPolicy` 用 keep 复刻现状行为。
- Q2 启动时 policy 文件缺失/构造抛错/声明非法 → 拒绝启动（与今天改坏 config.json 同语义）；运行中热重载失败 → 保留旧实例 + 管理口报错。
- Q3 不留 config.json 兼容读取；生产回滚靠旧 release 目录。
- Q4 真身在仓库 `policies/mine.ts`，`/root/.config/coding-plan-router/policy.ts` 软链过去（部署时建链）；仓库同时发布 `policies/default.ts` 模板。
- Q5 mtime 变更自动重载，无手动按钮；管理口新增只读 `/api/policy`（文件、mtime、加载时间、最后错误）。
- 决策语义：`{backend, model?}` | `'keep'` | `null`；`null` = 内置（月欠账 + 长会话阈值 + 钉死默认），`'keep'` = 尊重当前钉死（对不存在的钉死/新会话无效，回落 null 语义）。
- 硬护栏不进 policy：模型支持校验（决定后的组合必须合法，非法决定回落内置）、短 retry-after 重试、1h 迁移冷却、探活、鉴权、账本、协议翻译、body 完整性。
- 额度墙从硬过滤降级为候选标志位 `walled`：policy 可以选撞墙订阅（钉死撞墙透传）；内置路径行为不变（过滤 + 全撞墙返回 429）。
- 决定模型覆盖（Auto 模式地基）：`{model}` 可改实际模型，翻译与审计按生效模型走，审计 `model` 列仍记客户端请求的 id，覆盖写进 routing_note。
- 顺手修观测盲区：迁移成功时把失败那笔也记账（今天 `continue` 跳过），requests 表加 `routing_note` 列记录决定来源（policy@mtime / builtin）与迁移去向。

**范围：**
- 新增 `lib/policy-contract.ts`（RouterPolicy/DecisionCtx/Decision/CandidateView，用户 import type 用）、`lib/builtin-decide.ts`（内置决策，行为=现状）、`lib/policy-loader.ts`（PolicyStore：mtime 热重载、validate、启动失败抛错、重载失败保旧）。
- `lib/config.ts`：删 `loadConfig`（JSON 读取路径退役），保留 `validateConfig` 供 loader 复用。
- `lib/server.ts`：createGatewayServers 收 `RouterPolicy | PolicyStore`（静态实例不校验——reliability-http 空配置子进程测试要求）；每请求取 current policy；声明指纹变化（实例身份）重建 UsageSnapshots；错误路径问 decide（含 session summary）；探活策略三态：首选不健康→503、错误路径目标不健康→内置备选、钉死覆写目标不健康→保钉死+warn；新增 `/api/policy`。
- `lib/audit.ts`：`routing_note TEXT` 列（SCHEMA + ALTER 迁移 + 旧库测试）。
- `policies/default.ts`（模板，示例声明 + decide null）、`policies/mine.ts`（config.example.json 机械翻译 + decide null，切换日与现状逐字节等价）。
- 测试：loader（合法/非法/启动抛错/重载保旧）、decide 契约（keep/pin 覆写/选撞墙/模型覆盖/错误路径）、迁移记账补漏、routing_note 迁移。

**不做：**Auto 模式逻辑本身（只留契约口）、config.json 兼容读取、看板改造（管理 API 响应形状不变即免改）、生产部署（单独授权）。

**部署备忘（另行授权后执行）：**systemd 加 `CPR_POLICY_FILE=/root/.config/coding-plan-router/policy.ts`；建软链 `/root/.config/coding-plan-router/policy.ts → /root/ffr-projects/coding-plan-router/policies/mine.ts`；release 仍 `git archive lib static package.json`（policies/ 不进 release，真身在仓库）。

## 验收

- [x] `node --test` 全绿（110/110，新增 12 条 policy 测试）；`npm run typecheck` 通过（tsconfig include 增加 `policies/`）。
- [x] 现有测试除两处入口适配（gateway/family-protocol 的 loadConfig→PolicyStore/内联对象）外零改动，断言原样通过——error-migration 全套、routing-score、admin-dashboard 的 API 形状全数保真。
- [x] 新测试覆盖：policy 文件加载失败启动拒绝；热重载坏文件保旧实例 + lastError；声明变更出新实例；decide keep/覆写/选撞墙/模型覆盖；错误路径 decide keep 透传、migrate 目标选择、抛错回落内置；迁移失败笔落账 + routing_note（policy 与 builtin 两口径）；旧库开库补 routing_note 列且旧行 NULL；`/api/policy` 端点。
- [x] `policies/mine.ts` 与 config.example.json 声明逐字段比对通过（脚本核验 backends 全字段、models 映射、routing、master_key_env、identity_header）。

## Comments

- 2026-11-17：decide 契约 = 每请求必问（含 403/429 重试，带 `ctx.error`/`ctx.active`/`ctx.session.requests`）；session 轮数只在错误路径查账本（每请求查库是热路径税）。额度墙降级为 `CandidateView.walled` 标志位：policy 可选撞墙订阅（撞墙透传语义），builtin 路径过滤行为不变。
- 2026-11-17：探活三态按设计落地——policy 无钉死首选不健康 → 503（钉死无回退）；policy 钉死覆写目标不健康 → 保钉死 + warn；错误路径 policy 目标不健康 → 回落内置备选。builtin 两条路都带 `orderedBackends` 沿序探活（与旧行为一致）。
- 2026-11-17：观测盲区修复实装——`migrateTo()` 先记失败笔（routing_note 拼 `attemptNote|migrate->X`）再 continue；`giveUp()` 同样落账。audit INSERT 列扩到 22 列，初版多打一个 `?`（23 值 22 列）被 9 个测试当场抓住——SQLite 加列套路的价值再次验证。
- 2026-11-17：撞墙测试初版直接注 `snapshots.values` 与快照轮询器赛跑（refresh 的 parseProxy 输出覆盖注入，exceeded 归 false），改走 provider 正常解析路径（upstream GET 回 proxy usage 载荷、rolling_percent=100）才稳。「快照状态注入」这个手法在 snapshots.start() 自动 refresh 的前提下不可靠，测试一律走假上游载荷。
- 2026-11-17：`createGatewayServers` 保持同步签名（测试直传实例），PolicyStore 的异步首次加载放在 `startGateway`：先 `current()` 再构造、再 `attachPolicySource` 接上热重载。声明级热重载 = 实例身份变化 → `snapshotsFor()` 重建 UsageSnapshots（该类持 backends 数组引用，光换内容会漏）。
- 2026-11-17：**未上线**。生产部署清单（须单独授权）：systemd unit 加 `CPR_POLICY_FILE=/root/.config/coding-plan-router/policy.ts`；建软链 policy.ts → 仓库 policies/mine.ts；release 仍 `git archive HEAD lib static package.json`（policies/ 不进 release，真身在仓库，靠软链生效）；切换前 `smoke-release.ts` 假上游冒烟；旧 config.json 保留原地作回滚保险，稳定一个周期后删。生产 DB 迁移（routing_note 列）由 UsageAudit 构造函数 ALTER 自动完成，无需停服脚本，但切换验证时要核对列已补齐。
- 2026-11-18：本票从 `.scratch/coding-plan-router/issues/14-policy-as-code.md`（伞下编号 14）拆出为独立 feature 目录 `.scratch/policy-as-code/`，重编号为 1；决策与验收记录原样保留，见同目录 `spec.md`。
- 2026-11-18：**设计被接替**——用户拍板「先做简单」，policy 文件加载机制（PolicyStore/mtime 热重载、软链、`CPR_POLICY_FILE`、`/api/policy`）由工单 `.scratch/inline-policy/` 退役：`mine.ts` 收进 `lib/policy/mine.ts` 随 release 发布，decide 契约保留。本票的契约与测试成果（每请求 decide、walled 标志位、模型覆盖、迁移记账、routing_note）全部存活；仅「文件加载/热重载」这一层实现作废。本部署清单作废，以 inline-policy 票 Comments 的简化清单为准。
