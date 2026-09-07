# 故障排查

先看能力与日志，再改变服务状态。大多数问题可以通过 `/api/health`、ComfyUI `/object_info` 和独立 worker 的健康状态定位；不要先清理模型、output 或 GPU 进程。

## 1. 页面显示未连接

```bash
curl http://127.0.0.1:8188/system_stats
curl http://127.0.0.1:5174/api/health
```

- 第一条失败：ComfyUI 未运行、端口未映射到 loopback，或 SSH 隧道已关闭。
- 第一条成功、第二条 `connected: false`：检查 BFF 的 `COMFYUI_URL` 和 BFF 日志。
- 本地开发：确认 SSH 隧道终端仍在运行，再刷新页面。

## 2. 某个优化开关不可用

`/api/health` 的 `services` 会给出原因。常见情况：

| 现象 | 检查项 |
| --- | --- |
| FastH3 不可用 | `H3VSA` 节点、FastH3 LoRA、gate 文件。 |
| cuBLAS/AdaGEMM 不可用 | `MiniMaxH3GB10CublasInt8` 或 `MiniMaxH3GB10AdaGemmInt8` 节点，以及模型兼容范围。 |
| VAE Tile Batch 不可用 | `MiniMaxH3VAEDecodeBatched` 节点。 |
| 参考输入不可用 | `MiniMaxH3ReferenceToVideo` 节点与 Ref2VA 文件。 |
| Music3 不可用 | 三个 Music3 模型及其文本/latent/音频节点。 |
| TAEH3 预览不可用 | 预览 loader 和 preview override 节点。 |

可在 GB10 上查询一个具体节点：

```bash
curl http://127.0.0.1:8188/object_info/H3VSA
```

安装模型或节点后需让 ComfyUI 重新扫描；先确认队列为空，再按既有运维流程重启该服务。

## 3. 部署或 Compose 检查失败

```bash
node scripts/preflight-portable.mjs --h3-env-file .env
node scripts/preflight-portable.mjs --h3-env-file .env --require-docker
```

- “缺少必填配置”：检查 `.env` 中八个 `H3_STUDIO_*` 项是否均非空。
- “路径不合法”：部署脚本只接受绝对 Unix 路径，且禁止空格和 shell 字符。
- “未找到 Docker Compose”：在 GB10 或安装了 Docker Compose 的机器使用 `--require-docker` 重跑。
- 远端同步失败：检查 SSH alias、rsync、目标目录权限和可用磁盘空间。

在 GB10 上查看状态：

```bash
docker compose --env-file .env -f docker-compose.gb10.yml ps
docker compose --env-file .env -f docker-compose.gb10.yml logs --tail=100 h3-studio
```

## 4. FlashVSR 或 RealESRGAN 不可用

```bash
curl http://127.0.0.1:8190/health
curl http://127.0.0.1:8191/health
```

- FlashVSR：查看 compatibility gate 返回的原因。源码下载、私有运行时、模型安装或小型推理失败都应 fail closed。
- RealESRGAN：确认模型文件名、SHA-256、至少 12 GiB 的可用系统内存和支持的输入规格；当前稳定路径支持 832×480、1344×768、1024×576、576×1024、768×768，以及历史 1280×720 H3 视频。
- 任何 worker 不可用都不应影响 Standard、FastH3 或 Music3 的生成能力。

## 5. 生成或增强无法停止

先观察状态是否已从 `queued` 变为 `cancelling`：

```bash
curl http://127.0.0.1:5174/api/jobs/<job-id>
curl http://127.0.0.1:5174/api/upscale-jobs/<upscale-job-id>
```

等待任务应由 ComfyUI 队列删除；运行中任务会请求中断。若 BFF 返回冲突，任务可能已经结束或不在该服务可安全控制的队列中。增强任务取消会由对应 worker 处理并仅清理自己的临时文件。

## 6. 性能变慢或画面抖动

先把配置回退到 H3 Standard 稠密基线，固定 prompt、seed、分辨率、实际帧数和步数。随后一次只启用一个开关。抖动通常优先排查 EasyCache、Sparge Fast 和低步数路径；性能下降则检查 VAE 解码、显存压力、worker 并发与 GPU 负载。

详细的单变量 A/B 方法见[推理优化](optimization-guide.md)。
