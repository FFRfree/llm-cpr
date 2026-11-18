// policy.local.ts 的模板：cp policy.example.ts policy.local.ts，然后在 local 里改。
// 本文件只是起点，代码从不加载它；本机的默认声明在 lib/policy/mine.ts。
// 铁律：backends[].name 是身份键（亲和事件与账本都存它），定下来绝不改；alias 只是显示名。
// 类型补全：本文件 import 了契约类型，编辑器里有完整提示；字段含义见 lib/policy/contract.ts。
import type { RouterPolicy } from './lib/policy/contract.ts';

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
  // 想自定义时从这里改，契约见 lib/policy/contract.ts。
  decide(ctx: Parameters<NonNullable<RouterPolicy['decide']>>[0]): ReturnType<NonNullable<RouterPolicy['decide']>> {
    void ctx;
    return null;
  }
}
