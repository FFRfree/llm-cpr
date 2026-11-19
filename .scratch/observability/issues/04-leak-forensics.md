# 04 泄漏取证：密钥/敏感串扫描，报警可定位、绝不落原文

Status: completed
Blocked by: (resolved: 01)

## 验收

- [x] 转发路径（捕获开关打开时）对请求正文跑规则扫描：已知密钥格式正则 + 熵检测，
      命中落 `privacy.hit` 事件（system_events，detail 含：类型、轮次、消息内位置哈希、
      规则名）——**绝不落命中原文**，事件里拿不回内容。
- [x] 与捕获库联动可定位：从事件回查该轮引用列表，指出密钥可能来自哪条消息
      （哪一轮、哪个角色、哪条消息先出现该位置哈希）——「哪一轮读哪个文件吸进来的」。
- [x] 白名单机制：自带 key（CPR_MASTER_KEY/租户 key/订阅 key）所在请求不误报；
      用户可配置额外豁免（如测试专用 key 前缀）。
- [x] 延迟预算实测：扫描开销与 parse 同量级（对照 ~1.5ms/MB 口径），超预算要给出
      降级策略（如只扫增量消息——哈希未见过的新消息才扫，天然省大头）。
- [x] 测试覆盖：真密钥格式样例（合成，不用真实凭据）、误报样例、白名单、超限跳过。

## 设计要点

- 「增量扫描」是性能与隐私双赢：引用列表能精确判出本轮新消息，只扫新消息。
- 规则库形态开放问题：对齐 gitleaks 规则格式（生态成熟、可导入）还是自维护最小集
  （零依赖纪律，规则文件进仓）？给用户方案拍板——零运行时依赖是仓库铁律，
  若对齐 gitleaks 只能取其规则数据而非其代码。
- 事件语义跟 system_events 既有 kind 纪律走（决策账，一行=一次自主动作），
  `privacy.hit` 命名与 detail 结构对齐 route.rebind 的 {trigger, source, note} 风格。
- 本票是四类分析里唯一动转发路径的，独立 review 必做（findings-only 子代理批审）。

## 开放问题

- 误报兜底：命中后要不要可配置「静默类型」（只计数不报警）？

## Comments

- commit 45e8626。落点：`core/observability/leaks.ts`（自维护最小规则集：known 精确正则
  aws/github/gitlab/slack/google/openai 形态/私钥块/JWT + credential-assignment 赋值形态过
  香农熵≥3.5 与长度≥16 门槛——不引 gitleaks 代码，只取思路）+ `core/store/capture.ts`
  增量扫描接线（只扫本轮新消息；判重必须在挂进 pendingContent 之前，否则本轮消息全被
  误判已见——测试抓出过）+ server.ts 白名单（master/租户/订阅 key 真实值 + 
  `capture.privacy.extra_allow` 前缀豁免，只进内存比对）+ `privacy.hit` 事件
  （detail: rule/item_hash/capture_id/message_index/role，无原文）+ `/api/capture/privacy`
  （事件回查捕获库：hit_turn + first_seen_turn）。
- 延迟预算实测：1MB 代码类文本扫描 4ms（parse 口径 ~1.5ms/MB 同量级还快一个量级），
  测试断言 <500ms/MB 兜底。进程内 (rule,item_hash) 去重（FIFO 4096 上界），同一条密钥
  随历史重发只报一次；重启后可能重复报，宁多报不漏报。
- 规则库形态：自维护最小集（开放问题答案）。独立 review：与全批次一起做（findings-only）。
- 没做的验证：误报率在真实 agent 流量上的观察（需生产开启后积累）；「静默类型」可配置
  （开放问题留用户拍板）；超限 body 不扫描（与超限跳过同语义，已在测试注记）。
