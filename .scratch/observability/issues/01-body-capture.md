# 01 正文落库：内容寻址存储 + 租户级 opt-in + 协议归一化（第一版 chat-completions）

Status: completed
Blocked by: (none)

本票是整个 observability 特性的地基，02-05 全部依赖它。

## 验收

- [x] 存储独立于 data.db（侧库或独立文件），账本库性能不受连累；加法迁移纪律
      （`core/store/migrate.ts` 套路，破坏性变更不进启动路径）。
- [x] 内容寻址：消息按哈希存一份、请求存引用列表；同一内容跨请求/跨会话只存一份；
      提供按引用列表拼装还原正文的读接口，还原结果与原始 body 逐字节一致（测试覆盖）。
- [x] opt-in 按租户：tenants 声明加开关（如 `capture: true`），默认关；
      未声明 tenants 的隐式 default 租户不捕获（对外用户零感知）。
- [x] TTL 保留期 + 超限跳过（>N MB 不落，阈值可配）；清理时判哈希引用计数，
      仍被引用的内容不删。
- [x] 写盘异步队列、内存有界（沿用 usageCollector 的有界丢弃纪律）；写失败降级不阻塞
      转发（对齐账本降级语义：latch 不变，缺行不能宣称完整）。
- [x] 协议归一化：统一 item 模型（消息/工具调用/工具结果/缓存线索四类实体起步）+
      chat-completions 转换器；非 chat-completions 请求不捕获（不猜格式）。
- [x] 管理口可查询：按 (tenant, identity, 时间范围) 列出捕获轮次、查看单轮还原正文；
      看板暂可不做（读侧接口先立）。

## 设计要点

- 哈希进库前考虑加盐问题：正文哈希可被彩虹表反推短消息——评估要不要 `salt`（配置期
  生成、存本机），对分析（同哈希对比）无影响。
- 引用列表与 data.db 的 requests 行要能对上（外键 request_id 或等价锚点），
  否则 02-05 的关联查询做不了。
- 隐私残余风险知情项：opt-in 默认值（对外发布版本）需用户拍板，别替用户决定。

## 开放问题

- opt-in 粒度：租户级够不够，要不要会话级白名单？（→ 已定：第一版租户级，会话级未做）
- 响应侧落不落（本票先不做，但存储设计要留得下响应的位）。（→ 已定：turns 留 response_refs 列）

## Comments

- commit 45e8626（分支 observability，未推送）。实现落点：`core/store/capture.ts`（CaptureStore：
  capture.db 侧库、内容寻址、盐文件 capture-salt.txt 0600 + CPR_CAPTURE_SALT/CPR_CAPTURE_DB_FILE
  接缝、TTL 14 天默认 / max 5MB 默认均走 `capture: {ttl_days, max_body_bytes}` 声明、扫描式引用
  清理、250ms 异步队列 32MB 有界、降级锁存）+ `core/protocols/items.ts`（四类实体 item 模型；
  存储单元 = 消息条目，assistant tool_calls 以 names 附在 message item 上，独立成条的 tool_call
  实体留给单列它的协议）+ server.ts 接线（captureId 在路由决策后、转发循环前生成，随账本行落
  capture_id 列，改绑重试 1:N 共用）+ `core/store/migrate.ts` 加列（capture_id TEXT，加法不占
  步骤号）+ 管理口 `/api/capture/turns|turns/:id|status`。
- 验证：`node --test` 182/182（其中 test/capture.test.ts 10 张：还原逐字节一致、跨轮去重、
  租户隔离、无 opt-in 不落文件、TTL 保引用清理、超限/形状跳过、降级不阻塞、加列迁移、
  坏声明拒启动、item 模型形状）；`npm run typecheck` 干净。INSERT 列数 23/23 程序数过。
- 没做的验证：响应侧捕获（留位未实现）；真链路（真上游）冒烟（属生产改动，单独授权）；
  对外发布版默认值需用户拍板（现默认关）。
