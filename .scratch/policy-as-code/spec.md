# Spec: Policy-as-code（config.json 退役）

**Status:** completed（代码已合入；**生产部署未执行，须单独授权**）
**日期:** 2026-11-17（原属 coding-plan-router 伞下工单 14；2026-11-18 拆出为独立 feature）

## Problem Statement

路由「声明」（订阅、模型映射、端口、knobs）与「策略」（每个请求路由给谁）都埋在 config.json 里：用户想改选路逻辑就得改 JSON 结构，引擎与配置耦合，也没法写自定义策略或为未来的 Auto 模式留口。

## Solution

声明 + 策略合进一个用户可写的 TS class（`RouterPolicy`，真身 `policies/mine.ts`，生产经 `/root/.config/coding-plan-router/policy.ts` 软链生效）：引擎只保留传输/鉴权/翻译/账本/护栏；`decide(ctx)` 每请求必问（含 403/429 重试），返回 `{backend, model?}` | `'keep'` | `null`（null 交内置兜底 `lib/builtin-decide.ts`）。config.json 不再被引擎读取，不留兼容路径（回滚 = 切回旧 release）。PolicyStore 按 mtime 热重载：启动时文件坏拒绝启动，运行中重载失败保旧实例 + `/api/policy` 报 lastError。

硬护栏不进 policy：模型支持校验、短 retry-after 重试、1h 迁移冷却、探活、鉴权、账本、协议翻译、body 完整性。额度墙从硬过滤降级为候选标志位 `walled`（policy 可选撞墙订阅，内置路径行为不变）。顺手修观测盲区：迁移前的失败笔也落账，`requests` 表加 `routing_note` 列记决定来源。

**未完成的尾巴：生产部署**（清单见 `issues/01-policy-as-code.md` Comments）：systemd 加 `CPR_POLICY_FILE`、建软链、`smoke-release.ts` 假上游冒烟新 release、切换验证核对 `routing_note` 列自动补齐；旧 config.json 留原地作回滚保险。

完整拍板过程（Q1–Q5）、契约细节与测试清单见 `issues/01-policy-as-code.md`；后续选路钩子（`choose`/`shouldMigrate`）设计见技能 `references/selection-hook-design.md`。
