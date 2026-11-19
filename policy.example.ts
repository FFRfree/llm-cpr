// ~/.cpr/policy.ts 的模板（v0.2.0 起用户声明住 ~/.cpr 单目录，不进 clone/release）：
// cp policy.example.ts ~/.cpr/policy.ts 后在里面改。本文件只是起点，代码从不加载它；无 policy.ts 时用内置 core/policy/mine.ts。
// 铁律：backends[].name 是身份键（亲和事件与账本都存它），定下来绝不改；alias 只是显示名。
// 类型补全：经 ~/.cpr/tsconfig.json 的 paths 指路（cpr install 生成）；字段含义见 core/policy/contract.ts。类型导入运行时被擦除，加载不依赖它。
import type { RouterPolicy } from 'llm-cpr';

export default class MyPolicy implements RouterPolicy {
  // 客户端鉴权用的环境变量名（值放 .env，别写进任何被跟踪文件）。
  master_key_env = 'CPR_MASTER_KEY';
  identity_header = 'x-session-id';
  // 推理口对客户端暴露；管理口只绑回环，绝不暴露公网。
  listen = { host: '127.0.0.1', port: 8741 };
  admin = { host: '127.0.0.1', port: 8740 };
  routing = { snapshot_interval_ms: 300_000, long_session_min_requests: 10 };

  // 订阅声明：name 唯一且永不改；key_env 指向 .env 里的键名，真实 key 不进仓。
  backends = [
    { name: 'ocg-sub-a', family: 'ocg' as const, alias: '订阅A', base_url: 'https://ocg.example/v1', key_env: 'OCG_SUB_A_KEY', direct: true },
    { name: 'ccg-sub-a', family: 'ccg' as const, alias: '订阅A代理', base_url: 'https://ccg.example/provider', key_env: 'CCG_SUB_A_KEY' },
  ];

  // 模型映射：id 是客户端请求用的名字；backends 按家族给上游真实模型名。
  models = [
    { id: 'model-a', backends: { ocg: 'model-a', ccg: 'vendor/model-a' } },
  ];

  // decide 恒返 null = 全部交给内置路由（月欠账均衡 / 长会话保 prompt cache / 尊重会话亲和）。
  // 想自定义时从这里改，契约见 core/policy/contract.ts。
  decide(ctx: Parameters<NonNullable<RouterPolicy['decide']>>[0]): ReturnType<NonNullable<RouterPolicy['decide']>> {
    void ctx;
    return null;
  }
}
