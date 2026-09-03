# H3 Studio for GB10

H3 Studio 是 MiniMax H3 的本地控制台：React 前端负责操作界面，Node.js BFF 负责参数校验、任务状态、能力检测和媒体代理，实际视频/音乐推理由 GB10 上已有的 ComfyUI 与独立增强 worker 完成。

本仓库提供代码、部署模板、配置合同和运维文档。**不包含模型权重、生成媒体、账号凭据、实际 Cloudflare 配置或 Python 虚拟环境。**

## 能力概览

| 模块 | 用途 | 主要能力 |
| --- | --- | --- |
| H3 Standard | 常规视频生成与受控 A/B | SpargeAttention、FirstBlockCache / EasyCache、Fused Modulation、Turbo LoRA 8-step、VAE Tile Batch、GB10 INT8 后端 |
| FastH3 VSA | 固定低步数预览路径 | 4-step VSA LoRA、训练 gate、稀疏注意力、可选 cuBLAS/AdaGEMM INT8、Fused Modulation、VAE Tile Batch 1/2/4 |
| MiniMax Music3 | 文本生成音乐 | Music3 专用工作流与可选分块音频解码 |
| 参考与预览 | 视频生成辅助能力 | 首/尾帧、图像/视频/音频参考、TAEH3 实时预览 |
| 视频增强 | 对已完成视频做离线后处理 | 稳定的 RealESRGAN x2 2K 路径；通过兼容性 gate 后开放 FlashVSR |

## 运行前提

- Node.js 22 或兼容的当前 LTS；npm。
- 目标推理机具备 NVIDIA GB10、Docker Compose v2 与 NVIDIA 容器运行时。新机器可直接使用[全新 GB10 部署](docs/fresh-gb10-deployment.md)，不再要求预先运行 ComfyUI；旧的已有 ComfyUI 部署仍见下文与[GB10 部署](docs/deployment-gb10.md)。
- 已从授权来源获得 H3、Music3、VAE、LoRA 与可选增强模型，并已安装所需 ComfyUI 节点。文件清单见 [模型与节点清单](docs/model-and-node-manifest.md)，下载入口、目标目录和镜像前置见[大文件下载与预置清单](docs/downloads.md)。
- 从部署机到 GB10 的 SSH / rsync 访问；部署脚本不会传输模型或凭据。

## 快速开始

安装依赖并验证源码：

```bash
npm ci
npm test
npm run check
npm run build
```

若在开发机通过 SSH 访问 GB10 上的 ComfyUI：

```bash
ssh -N -L 8188:127.0.0.1:8188 <gb10-ssh-alias>
npm run dev
```

打开 `http://127.0.0.1:5173`，API 代理位于 `http://127.0.0.1:5174`。完整步骤见[开始使用](docs/getting-started.md)。

部署到 GB10 前，先从示例配置创建本地 `.env`，填入目标环境路径：

```bash
cp .env.example .env
node scripts/preflight-portable.mjs --h3-env-file .env
npm run deploy:gb10
```

`.env` 只留在本机；部署脚本会读取它并把必要变量传给远端 Compose。GB10 上有 Docker Compose 时，可使用 `--require-docker` 强制做 Compose 展开检查。

从零开始的 GB10 不使用上述 SSH/已有 ComfyUI 路径。克隆仓库到 GB10 后，按[全新 GB10 部署](docs/fresh-gb10-deployment.md)创建 `.env.fresh` 并运行：

```bash
./scripts/bootstrap-fresh-gb10.sh --env .env.fresh
```

## 文档导航

- [开始使用](docs/getting-started.md)：本地开发、SSH 隧道、健康检查。
- [GB10 部署](docs/deployment-gb10.md)：环境变量、部署生命周期、升级与回滚。
- [全新 GB10 部署](docs/fresh-gb10-deployment.md)：仅有驱动和 Docker 时的一次性引导、验收与运行时镜像。
- [系统架构](docs/architecture.md)：浏览器、BFF、ComfyUI、worker 和端口边界。
- [推理优化](docs/optimization-guide.md)：三种模式的原理、互斥关系、质量与性能评估。
- [模型与节点清单](docs/model-and-node-manifest.md)：外部依赖、能力协商和校验边界。
- [大文件下载与预置](docs/downloads.md)：H3、Music3、LoRA、VAE、增强模型、镜像与 FlashVSR 源码的下载入口。
- [视频增强](docs/upscale.md)：历史视频、RealESRGAN 2K、FlashVSR 与停止任务。
- [故障排查](docs/troubleshooting.md)：健康检查、节点、模型、GPU、worker 与取消任务。
- [安全与凭据](docs/security-and-secrets.md)：忽略规则、发布扫描、GitHub/Cloudflare 操作边界。

开发过程中的技术实验记录保存在 `docs/h3-inference-optimization-guide.md` 与 `docs/superpowers/`。前者可作为较细的实现参考；新部署请优先遵循上面的迁移文档。

## 发布前检查

```bash
npm test
npm run check
npm run build
node scripts/preflight-portable.mjs --h3-env-file .env.example
npm run verify:release
```

`verify:release` 只扫描 Git 已跟踪文件，阻止模型权重、运行产物、私有配置和令牌样式文本进入提交。更多说明见[安全与凭据](docs/security-and-secrets.md)。
