# 05: 审计账本 usage.db

**What to build:** node:sqlite 审计账本，每笔推理请求一行：ts / identity / identity_kind / subscription / account / model（原始+翻译后）/ path / status / 耗时 / token 四件套 / cache 观测字段 / 上游 usage 原文 JSON。cache miss 双口径（沿用已拍板）：a) 会话汇总全 miss 率；b) 逐笔"本笔命中 < 上笔 prompt × 0.6"。两条不变式有测试：审计写失败丢行不挡转发；请求正文永不落库。含会话级汇总查询 API（供 06 号看板用）。

**Blocked by:** 02（需要身份字段；可与 03/04 并行）

**Status:** ready-for-agent

- [ ] 单测：行字段完整性（流式/非流式）、cache 口径 a+b 的判定表、正文零落库（喂带敏感内容的请求断言账本无正文）
- [ ] e2e：并发请求下账本行数与请求数一致；故意弄坏 DB → 转发仍成功且日志有降级标记
- [ ] 会话汇总查询：按 identity 出全 miss 率与丢失事件列表
- [ ] `node --test` 全绿；中文 commit；工作树干净
