# H3 Studio Cloudflare Gateway

这是 H3 Studio 的可选 Cloudflare Worker 入口。Worker 通过 Workers VPC Service 和出站 Tunnel 访问 GB10 上的 `localhost:5174`；它不托管前端构建、模型或 ComfyUI。

## 账户侧配置

1. 在目标 Cloudflare 账户中启用 Workers、Zero Trust 与所需 VPC 能力。
2. 创建一个远程管理的 Tunnel，并在 GB10 运行 ARM64 Linux connector。
3. 创建 HTTP VPC Service，目标为 `localhost:5174`。
4. 复制 `wrangler.jsonc.example` 为本地 `wrangler.jsonc`，填入实际 service 标识。
5. 使用目标账户的认证执行 `npx wrangler deploy`。
6. 用 Cloudflare Access 保护 Worker URL，仅允许组织认可的身份提供者、用户组或邮箱域策略访问。

实际 `wrangler.jsonc` 和 tunnel 令牌都是私有配置，已被 Git 忽略。

## Connector 生命周期

在 GB10 工作目录执行：

```bash
docker compose -f docker-compose.cloudflared.yml ps
docker compose -f docker-compose.cloudflared.yml logs --tail=100 cloudflared
docker compose -f docker-compose.cloudflared.yml restart cloudflared
```

connector 使用 host networking，因此其 `localhost` 指向 GB10 本机。H3 Studio 和 ComfyUI 不需要、也不应该被映射为公网服务。

## 缓存边界

Worker 对 `/api/*` 返回 `Cache-Control: no-store`，避免任务状态、SSE 事件和媒体查找被网关缓存。前端发布仍通过 GB10 部署完成，而不是由 Worker 保存静态构建文件。
