// 默认 policy 模板：新装机拷一份去改（cp policies/default.ts policies/mine.ts）。
// 声明区 = 原 config.json 的整体形状；decide 返回 null = 全部交给内置逻辑
// （新会话月欠账评分、长会话保缓存、尊重钉死、403/429 迁移备选排序）。
// 注意：backends[].name 是身份键（账本/钉死表存它），改了等于换身份证，绝不改。
import type { RouterPolicy } from '../lib/policy-contract.ts';

export default class DefaultPolicy implements RouterPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  listen = { host: '127.0.0.1', port: 8741 };
  admin = { host: '127.0.0.1', port: 8740 };
  backends = [
    // OCG 直连示例（direct: true 表示额度快照走直连接口）
    { name: 'ocg-example', family: 'ocg' as const, alias: 'example', base_url: 'https://opencode.example/v1', key_env: 'OPENCODE_EXAMPLE_KEY', direct: true },
    // CCG 示例
    { name: 'ccg-example', family: 'ccg' as const, alias: 'example', base_url: 'https://commandcode.example/provider', key_env: 'COMMANDCODE_EXAMPLE_KEY' },
  ];
  models = [
    { id: 'example-model', backends: { ocg: 'example-model', ccg: 'vendor/example-model' } },
  ];
  routing = { snapshot_interval_ms: 300_000, long_session_min_requests: 10 };

  decide(ctx: Parameters<NonNullable<RouterPolicy['decide']>>[0]): ReturnType<NonNullable<RouterPolicy['decide']>> {
    // 自定义规则写这里，例如：
    // if (ctx.request.model === 'glm-5.3') return { backend: 'ccg-example' }; // 钉死（撞墙也透传，不回退）
    // if (ctx.error && ctx.session.requests !== null && ctx.session.requests < 10) return 'keep'; // 错误路径也可决定
    void ctx;
    return null; // 交给内置兜底
  }
}
