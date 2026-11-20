# 01: server.ts 转发路径分段打点 + 基准脚本

Status: ready-for-agent

## 验收

- [ ] 每个走到转发路径的客户端请求在 res close 时恰好输出一行 `[perf] {...}`（多 attempt 请求也只一行；aborted 请求带 `aborted:true`）。
- [ ] 行内含 spec 定义的 ms 段位、forward{ttft,stream,attempts}、meta{status,bytes,model,tenant}；不含 identity/会话 id/正文。
- [ ] 401/404/本地 400 不产生行。
- [ ] 新测试覆盖：普通 JSON 响应、流式响应、客户端取消、429 透传各一行且段位合理。
- [ ] `scripts/perf-overhead.ts` 假上游基准可跑通，输出直连 vs 经网关的分段对照。
- [ ] 全量 `node --test` 通过。

## Comments
