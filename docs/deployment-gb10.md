# 部署到 GB10

本部署把 H3 Studio、FlashVSR worker 和 RealESRGAN worker 运行在 GB10 本机网络中。ComfyUI 是既有服务；部署脚本会安装/更新本仓库管理的 TAEH3 预览节点，但不会复制模型权重到仓库。

## 前置条件

1. GB10 已安装 Docker、Docker Compose v2 与 NVIDIA 容器运行时。
2. ComfyUI 已在 GB10 loopback 的 `8188` 端口可访问，且对应容器名与自定义节点目录已知。
3. H3/Music3 权重、LoRA、VAE 和需要的 ComfyUI 节点已按授权条款安装。文件名、下载入口、目标目录和镜像前置见[大文件下载与预置清单](downloads.md)；能力边界见[模型与节点清单](model-and-node-manifest.md)。
4. 部署源机器可通过 SSH 和 rsync 访问 GB10。
5. ComfyUI 队列为空。若 TAEH3 节点版本需要更新，部署会重启配置的 ComfyUI 容器。

## 配置 `.env`

从示例开始：

```bash
cp .env.example .env
```

填写下列值；路径必须是绝对 Unix 路径，不含空格或 shell 字符。

| 变量 | 含义 |
| --- | --- |
| `H3_STUDIO_GB10_HOST` | SSH host alias 或主机名。 |
| `H3_STUDIO_GB10_DIR` | GB10 上的 H3 Studio 工作目录。worker 的私有状态和虚拟环境也位于其下。 |
| `H3_STUDIO_COMFY_OUTPUT_DIR` | ComfyUI output 的宿主机目录。 |
| `H3_STUDIO_COMFY_VENV_DIR` | ComfyUI 虚拟环境来源，仅用于创建 FlashVSR 私有副本。 |
| `H3_STUDIO_FLASHVSR_MODEL_DIR` | 已授权 FlashVSR 模型目录。 |
| `H3_STUDIO_REALESRGAN_MODEL_SOURCE` | 已验证的 RealESRGAN 模型来源文件。 |
| `H3_STUDIO_COMFY_CONTAINER` | 现有 ComfyUI Docker 容器名。 |
| `H3_STUDIO_COMFY_CUSTOM_NODES_DIR` | ComfyUI 容器内的自定义节点根目录。 |

不要把 `.env` 提交到 Git，也不要用示例文件保存令牌。若需要在 GB10 上手动运行 Compose，请在 GB10 工作目录保留一份同样的 `.env`，或在调用前导出同一组变量；部署同步会刻意排除 `.env`。

## 预检与部署

在部署源机器执行：

```bash
node scripts/preflight-portable.mjs --h3-env-file .env
npm run deploy:gb10
```

有 Docker Compose 的机器可要求实际展开 Compose：

```bash
node scripts/preflight-portable.mjs --h3-env-file .env --require-docker
```

`npm run deploy:gb10` 的顺序是：

1. 构建前端与 BFF 生产产物。
2. 通过 rsync 同步源码和构建产物，排除 `.env`、模型、输出、虚拟环境、缓存与 Cloudflare 私有配置。
3. 在 GB10 上导出配置变量并启动/更新 `h3-studio`。
4. 检查 TAEH3 节点版本；仅在缺失或版本不符时更新节点并重启配置的 ComfyUI 容器。
5. 校验 RealESRGAN 模型 SHA-256，构建独立 worker。
6. 准备 FlashVSR 的私有运行时和 compatibility gate；gate 未通过时该 worker 保持可查询但不可接单。
7. 轮询 `/api/health`，确认服务能力已公开。

脚本只在远端构建失败时使用已验证产物重打包现有运行镜像的回退路径；它不会删除模型、输出或持久状态。

## 日常生命周期

在 GB10 的工作目录执行：

```bash
docker compose --env-file .env -f docker-compose.gb10.yml ps
docker compose --env-file .env -f docker-compose.gb10.yml logs --tail=100 h3-studio
docker compose --env-file .env -f docker-compose.gb10.yml logs --tail=100 realesrgan-worker
docker compose --env-file .env -f docker-compose.gb10.yml logs --tail=100 flashvsr-worker
```

需要重启 BFF 时，只重启 `h3-studio`。除非节点更新确有需要，不要随意重启 ComfyUI；不要使用会移除卷或状态的批量清理命令。

## 验证与回滚

部署成功后：

```bash
curl http://127.0.0.1:5174/api/health
```

检查 `connected` 与各项 `services`。回滚时，在部署源机器切换到已验证的 Git 提交，再运行同一部署命令；worker 状态目录和模型目录不属于 Git 回滚范围。若问题只出现在 FlashVSR，先看其 gate 的失败原因，避免为了一个可选 worker 影响 H3 主服务。
