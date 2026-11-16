# Sub-Router

LLM 订阅路由网关（agent-agnostic）：在多个 OCG / CCG 订阅间做负载均衡 + 审计 + 看板。

## 当前状态（重要）

**规划阶段，未写代码、未起服务、未改任何生产配置。** 设计与事实底座见
`docs/design.md`（含「已验证 / 待拍板 / 待验证」标注）。动手前所有待拍板项须用户逐项确认。

## 目录

```
docs/design.md    设计文档（规划稿 v0.1）
```

## 约定（与 ocg-proxy 同源的规矩）

- 纯 Node 零第三方依赖（node:sqlite），Node ≥ 22。
- `.env` 不进 git；真 key 只放 `.env`（chmod 600）。
- 管理口永远只绑回环；开发期用端口覆盖 + 假上游冒烟，不碰生产端口。
- 审计写失败只丢行不挡转发；不落请求正文。
- 正式改动单独中文 git commit，结束工作树应干净。
- Hermes config.yaml / systemd 等生产改动须用户逐次明确同意。
