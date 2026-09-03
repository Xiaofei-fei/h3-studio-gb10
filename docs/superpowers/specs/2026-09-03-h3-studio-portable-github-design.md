# H3 Studio 可迁移 GitHub 仓库设计

**状态：** 已批准
**目标仓库：** `Xiaofei-fei/h3-studio-gb10`（默认私有）
**目标：** 将当前 MiniMax H3 Studio 系统整理为不携带权重和私密配置、可在另一台已满足硬件条件的机器上复现部署的 GitHub 仓库。

## 1. 背景与边界

当前系统由浏览器前端、Node.js BFF、GB10 上的 ComfyUI、三个推理模式，以及两个独立视频增强 worker 组成。H3 Studio 只负责受控提交、状态管理、能力检测和媒体代理；模型推理仍由 ComfyUI 或专用 worker 在 GB10 本机完成。

本次整理的目标是可迁移的**工程和运行手册**，不是发布 MiniMax、FlashVSR 或 RealESRGAN 的模型权重。仓库不承诺在不具备 NVIDIA GB10 / CUDA、ComfyUI 自定义节点和已授权模型的机器上直接运行推理。

### 包含

- React/Vite 前端、Node.js BFF、工作流构建与测试。
- H3 Standard、FastH3 VSA、MiniMax Music3 的表单、能力协商与 ComfyUI workflow。
- TAEH3 预览节点、FlashVSR worker、确定性 RealESRGAN x2 worker。
- GB10 Docker Compose、部署脚本、Cloudflare 可选入口模板。
- 迁移、配置、模型清单、优化开关、超分、验证和故障排查文档。

### 不包含

- H3、Turbo LoRA、FastH3 VSA、Music3、VAE、文本编码器、FlashVSR、RealESRGAN 等权重或下载缓存。
- 生成视频、ComfyUI output/input、Python/Node 构建产物、虚拟环境和 wheelhouse。
- SSH 私钥、GitHub/Cloudflare Token、实际 `wrangler.jsonc`、隧道凭据、用户或公司内部地址。

## 2. 当前系统架构

```text
浏览器
  │  http://127.0.0.1:5174（或受控 Cloudflare 入口）
  ▼
H3 Studio（React + Node BFF）
  ├─ HTTP / WebSocket → GB10 ComfyUI :8188
  ├─ HTTP → FlashVSR worker :8190（可用性由 compatibility gate 决定）
  └─ HTTP → RealESRGAN worker :8191（确定性 2K 增强）
                         │
                         ▼
                    ComfyUI / 模型目录 / 输出目录
```

### 推理模式

| 模式 | 用途 | 固定或主要优化 |
| --- | --- | --- |
| H3 Standard | 常规视频生成、可做单项 A/B | SpargeAttention、FirstBlockCache/EasyCache、Fused Modulation、Turbo LoRA 8-step、VAE Tile Batch、cuBLAS/AdaGEMM INT8 |
| FastH3 VSA | 固定低步数预览 / 低延迟路径 | VSA 4-step LoRA、训练 gate、Euler 4-step、VAE Tile Batch、cuBLAS/AdaGEMM INT8 |
| MiniMax Music3 | 音乐生成 | Music3 专用 workflow、分块音频解码 |
| 视频增强（后处理） | 已完成视频的稳定超分 | RealESRGAN x2：832×480→2560×1478、1280×720→2560×1440；FlashVSR 仅在兼容性 gate 通过时开放 |

## 3. 目标仓库结构

```text
h3-studio-gb10/
├── src/                         # 前端
├── server/                      # BFF、ComfyUI/worker 客户端和工作流
├── tests/                       # TypeScript/Vitest 测试
├── comfy_nodes/                 # 随仓库维护的 TAEH3 节点
├── flashvsr_worker/             # FlashVSR 隔离 worker
├── realesrgan_worker/           # 确定性 RealESRGAN worker
├── scripts/                     # 可参数化的部署与预检命令
├── config/                      # 无敏感信息的示例配置与模型 manifest
├── docs/
│   ├── getting-started.md
│   ├── deployment-gb10.md
│   ├── architecture.md
│   ├── optimization-guide.md
│   ├── model-and-node-manifest.md
│   ├── upscale.md
│   ├── troubleshooting.md
│   └── security-and-secrets.md
├── .env.example
├── docker-compose.gb10.yml
├── Dockerfile
├── README.md
└── LICENSE
```

现有的 `docs/superpowers/` 是过程性设计与计划记录，不作为对外迁移文档的主体；发布时只保留用户可执行的 `docs/` 内容。

## 4. 可迁移配置合同

仓库把所有机器相关的值迁入 `.env` 或环境变量，提交 `.env.example`：

| 变量 | 含义 | 是否可公开 |
| --- | --- | --- |
| `H3_STUDIO_GB10_HOST` | SSH host alias | 仅示例值 |
| `H3_STUDIO_GB10_DIR` | GB10 上的工作目录 | 仅示例值 |
| `H3_STUDIO_COMFY_OUTPUT_DIR` | ComfyUI output 绝对路径 | 仅示例值 |
| `H3_STUDIO_FLASHVSR_MODEL_DIR` | 已授权 FlashVSR 权重目录 | 仅示例值 |
| `H3_STUDIO_REALESRGAN_MODEL_SOURCE` | 已校验 RealESRGAN 模型来源 | 仅示例值 |
| `COMFYUI_URL` | BFF 到 ComfyUI 的内部地址 | 可公开的 loopback 默认值 |

`docker-compose.gb10.yml`、部署脚本和文档使用同一组变量。脚本必须在文件同步前检查变量存在、路径为绝对路径且不包含 shell 特殊字符。

## 5. 安全与发布策略

1. 用 Git 初始化默认 `main` 分支，添加 MIT 许可证（除第三方模型和外部项目自身许可外）。
2. 修改 `.gitignore`：忽略模型、输出、缓存、实际 `.env`、Cloudflare 实例配置、构建产物和 agent 临时文件；允许跟踪用户文档。
3. 只保留 `cloudflare-worker/wrangler.jsonc.example`，将实际 `wrangler.jsonc` 明确忽略。
4. 发布前对候选 Git 文件执行凭据模式扫描；若发现疑似凭据，先移除或替换为变量引用，不进行推送。
5. 不把模型下载链接中的临时签名 URL、公司内网地址或真实账户标识写入 README。
6. GitHub 远端创建与 `git push` 仅在用户完成 GitHub 设备登录 / GitHub Desktop / PAT 授权后执行；令牌不在聊天、文档或仓库中保存。

## 6. 文档交付

### README

面向首次使用者：能力概览、运行前提、5 分钟本地前端启动、GB10 部署入口、支持矩阵和文档导航。

### `docs/getting-started.md`

描述本机开发、SSH 隧道和本地浏览器访问；说明如何验证 `/api/health`。

### `docs/deployment-gb10.md`

描述 GB10 前置条件、目录布局、环境变量、容器启动、预检、升级与回滚。模型步骤只写“从已授权来源放入指定目录并校验”，不复制权重。

### `docs/architecture.md`

明确 BFF、ComfyUI、worker、可选 Cloudflare 入口的职责和端口边界。

### `docs/optimization-guide.md`

整合现有 H3 推理优化技术说明，按 H3 Standard、FastH3 VSA、Music3 和后处理划分；标明互斥关系、质量风险与实测边界。

### `docs/model-and-node-manifest.md`

列出每种模式需要的模型**文件名/用途/来源类型/校验方式**和 ComfyUI 节点能力，不发布权重或受限下载 URL。

### `docs/upscale.md`

说明 RealESRGAN 480P/720P 稳定增强的输出规格、排队与停止、FlashVSR 兼容性 gate 的含义和历史视频入口限制。

### `docs/troubleshooting.md`

按 health、ComfyUI capability、GPU/内存、worker、模型缺失、前端连接、停止任务和超分失败分组给出诊断命令。

## 7. 验收标准

- 从空目录 `git clone` 后不包含权重、输出、Token 或 100 MB 以上的缓存文件。
- `npm ci && npm test && npm run build` 能完成。
- `docker compose -f docker-compose.gb10.yml config` 使用示例配置可解析。
- 新机器仅需完成文档定义的模型/节点前置条件、填充 `.env`，即可部署 BFF 和两个 worker。
- `/api/health` 正确报告 Standard、FastH3、Music3、TAEH3、FlashVSR 和确定性超分的可用性或失败原因。
- README 能让未参与过本项目的工程师找到部署入口、模式选择和故障排查资料。

## 8. 发布流程

1. 整理代码和示例配置，补齐文档与测试。
2. 运行测试、构建、Compose 配置检查和敏感信息扫描。
3. 初始化本地 Git、创建原子提交并复核 `git status`。
4. 用户完成 GitHub 授权后，创建私有仓库 `Xiaofei-fei/h3-studio-gb10`，添加 `origin` 并推送 `main`。
5. 在干净目录 clone 后执行文档中的最小验证，作为迁移验收。
