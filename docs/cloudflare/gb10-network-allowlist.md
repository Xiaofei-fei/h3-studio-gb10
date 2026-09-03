# GB10 Cloudflare Tunnel 网络需求

Cloudflare Tunnel 是可选入口。它应只建立从 GB10 到 Cloudflare 的出站连接；不需要为 H3 Studio、ComfyUI 或增强 worker 开放入站端口。

## 最小出站规则

1. 允许解析 Cloudflare Tunnel 所需的 SRV 和 A/AAAA DNS 记录。
2. 允许向 Cloudflare Tunnel 区域出口 UDP `7844`（QUIC）。
3. 允许向同一出口 TCP `7844` 作为回退。
4. 保留到 Cloudflare 管理 API 的 TCP `443`，用于 connector 管理和验证。

确切区域地址和端口会随 Cloudflare 运营策略变化，应以其官方 Tunnel 防火墙文档为准。不要把某次部署观察到的内网 DNS 地址或临时网络故障写入通用运行手册。

## 验证

在 GB10 的工作目录中：

```bash
docker compose -f docker-compose.cloudflared.yml ps
docker compose -f docker-compose.cloudflared.yml logs --tail=100 cloudflared
```

确认 connector 已注册连接，并且 H3 Studio 与 ComfyUI 仍只监听 loopback。Tunnel 不健康时，先检查 DNS 与出站策略；不要通过开放推理端口规避问题。
