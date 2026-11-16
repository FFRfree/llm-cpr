# 本机部署：通过 SSO 反向代理访问看板

本文是可选的本机部署思路，不是完整的生产 Nginx 配置。示例不包含真实域名、证书路径、SSO 服务地址或任何个人凭据；请按自己的认证网关和安全基线替换占位符。

## 边界与建议

- coding-plan-router 的推理入口默认绑定 `127.0.0.1:8741`，管理入口默认绑定 `127.0.0.1:8740`。两者不要直接开放公网端口。
- Nginx 只代理管理入口；先通过已有 SSO 的 `auth_request`（或等价机制）完成身份认证，再将请求转给本机 `127.0.0.1:8740`。
- 仅放行看板 `/`、`/dashboard` 与需要的只读 `/api/` 路径；不要代理 `/v1/`、Node 进程的调试接口或其他上游管理界面。
- TLS 应在可信入口终止；限制访问群组、记录访问审计、设置合理超时，并在 SSO/上游不可用时默认拒绝。
- 看板管理 API 当前是只读但没有应用层认证。不要以“只读”为由绕过 SSO，也不要把 Node 管理端口改为公网监听。

## Nginx 配置组织示意

将 SSO 的认证子请求接入点配置在受信任的 `http`/`server` 层；下面的 `SSO_AUTH_SUBREQUEST` 是示意位置，不是可直接复制的 Nginx 指令。真实配置应使用认证系统提供的 `auth_request` 子请求 URI、内部 location 和必要的用户头传递约定。

```nginx
server {
    listen 443 ssl;
    server_name <your-private-dashboard-host>;

    # 证书与 TLS 配置由你的主机基线管理，不在示例中提供。

    location = /_sso_auth {
        internal;
        # 在此接入 SSO_AUTH_SUBREQUEST；认证接口仅供内部子请求调用。
        proxy_pass <trusted-sso-auth-endpoint>;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
    }

    location / {
        auth_request /_sso_auth;
        proxy_pass http://127.0.0.1:8740;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

示例中的 `<trusted-sso-auth-endpoint>` 不是合法的最终值；按所用 SSO 的部署文档替换，并确保认证检查失败会拒绝请求。若需要按路径限制 API，应先显式列出并测试看板必需的只读路径，再拒绝其余 URI；不要假设 `location /` 本身实现了最小权限。

## 部署与验证清单

1. 确认路由器管理服务仍只绑定 loopback，并且主机防火墙没有对外放行管理端口。
2. 配置私有 DNS/入口和 TLS，采用受支持的 SSO Nginx 集成方法；认证身份与授权组应由可信 SSO 返回，不能信任客户端自行提交的身份头。
3. 仅把 Nginx 暴露给需要访问的网络边界。不要公开推理端口；客户端推理应按独立入口与认证方案设计。
4. 用未登录浏览器验证看板与 API 均被 SSO 拒绝或重定向；用有权限账号验证看板、额度快照及审计只读 API 可用；用无权限账号验证拒绝访问。
5. 检查 Nginx 日志没有记录 `Authorization`、API key、请求正文或 SSO token；检查错误/超时情况下不会回落到未认证上游。
6. Nginx 配置测试通过后再 reload；验证认证代理可用性与路由器独立运行状态。所有真实域名、证书、SSO 参数及主机配置留在本机管理，不提交仓库。

如当前 Nginx/SSO 的认证集成方式不同，应以该认证系统的官方文档为准；此文仅描述“认证先行、回环代理、最小路径暴露”的边界，不承诺可直接部署。
