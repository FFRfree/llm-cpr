// 我的 policy：从 config.json 机械翻译（2026-11-17），声明与旧 config 逐字段一致，
// decide 恒返 null → 行为与切换前逐字节等价（内置月欠账/长会话保缓存/尊重钉死）。
// 规则从这里一条条加；name 是身份键，绝不改。
import type { RouterPolicy } from '../lib/policy-contract.ts';

export default class Mine implements RouterPolicy {
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  listen = { host: '127.0.0.1', port: 8741 };
  admin = { host: '127.0.0.1', port: 8740 };
  routing = { snapshot_interval_ms: 300_000, long_session_min_requests: 10 };

  backends = [
    { name: 'ocg-foxmail', family: 'ocg' as const, alias: 'foxmail', base_url: 'https://opencode.ai/zen/go/v1', key_env: 'OPENCODE_GO_KEY_FOXMAIL', direct: true },
    { name: 'ocg-gmail', family: 'ocg' as const, alias: 'gmail', base_url: 'https://opencode.ai/zen/go/v1', key_env: 'OPENCODE_GO_KEY_GMAIL', direct: true },
    { name: 'ccg-main', family: 'ccg' as const, alias: 'foxmail', base_url: 'https://api.commandcode.ai/provider', key_env: 'COMMANDCODE_API_KEY' },
  ];

  models = [
    { id: 'glm-5.3-flash', backends: { ocg: 'glm-5.3-flash', ccg: 'z-ai/glm-5.3-flash' } },
    { id: 'glm-5.3', backends: { ocg: 'glm-5.3', ccg: 'zai-org/GLM-5.3' } },
    { id: 'deepseek-v4.1-flash', backends: { ocg: 'deepseek-v4.1-flash', ccg: 'deepseek/deepseek-v4.1-flash' } },
    { id: 'deepseek-v4-pro', backends: { ocg: 'deepseek-v4-pro', ccg: 'deepseek/deepseek-v4-pro' } },
    { id: 'gemini-4-argon', backends: { ocg: 'gemini-4-argon', ccg: 'google/gemini-4-argon' } },
    { id: 'hy3', backends: { ocg: 'hy3', ccg: 'tencent/hy3-paid' } },
    { id: 'hy4', backends: { ocg: 'hy4', ccg: 'tencent/hy4-preview' } },
    { id: 'hy4-preview', backends: { ocg: 'hy4-preview', ccg: 'tencent/hy4-preview' } },
    { id: 'mimo-v2.6-flash', backends: { ocg: 'mimo-v2.6-flash', ccg: 'xiaomi/mimo-v2.6-flash' } },
    { id: 'longcat-2.0', backends: { ocg: 'longcat-2.0', ccg: 'meituan/LongCat-2.0' } },
    { id: 'kimi-k2.7-code', backends: { ocg: 'kimi-k2.7-code', ccg: 'moonshotai/Kimi-K2.7-Code' } },
    { id: 'qwen3.8-max', backends: { ocg: 'qwen3.8-max', ccg: 'Qwen/Qwen3.8-Max' } },
  ];

  decide(ctx: Parameters<NonNullable<RouterPolicy['decide']>>[0]): ReturnType<NonNullable<RouterPolicy['decide']>> {
    void ctx;
    return null;
  }
}
