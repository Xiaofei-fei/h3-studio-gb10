# H3 Studio GB10 Origin

H3 Studio 与现有 ComfyUI 并排运行在 GB10 上。Compose 使用 host networking，但服务应只监听 GB10 loopback；Cloudflare Tunnel 仅作为可选的出站连接器。

部署前在源机器创建 `.env`，填写 `H3_STUDIO_GB10_HOST`、`H3_STUDIO_GB10_DIR`、ComfyUI 路径和容器名。完整配置说明见[GB10 部署指南](../deployment-gb10.md)。

```bash
node scripts/preflight-portable.mjs --h3-env-file .env
npm run deploy:gb10
```

该命令同步源码与已构建产物，排除 `.env`、模型、运行状态和 secrets，然后在 GB10 上重建 H3 Studio。若 TAEH3 节点版本不符，部署会更新节点并重启配置的 ComfyUI 容器；请先保持队列为空。

GB10 的日常检查：

```bash
docker compose --env-file .env -f docker-compose.gb10.yml ps
docker compose --env-file .env -f docker-compose.gb10.yml logs --tail=100 h3-studio
curl http://127.0.0.1:5174/api/health
```

`/api/health` 应显示 `connected: true`，并列出 FastH3、TAEH3 预览和两个增强 worker 的 capability。不要为 H3 Studio 或 ComfyUI 添加公网 Docker 端口。
