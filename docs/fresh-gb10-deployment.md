# 全新 GB10 部署

本流程用于一台刚安装 NVIDIA 驱动、Docker Engine 和 Docker Compose v2 的 ARM64 GB10。它不依赖已有的 ComfyUI、Python 虚拟环境或本地基础镜像。

部署结果由三个容器组成：已发布的 ComfyUI 运行时、H3 Studio 应用和 RealESRGAN x2 worker。H3、Music3、Turbo LoRA、TAEH3 和 RealESRGAN 权重始终保存在宿主机目录，**不会写入 Git 或容器镜像**。

## 交付边界

| 能力 | 全新部署状态 | 说明 |
| --- | --- | --- |
| H3 Standard、Sparge、缓存、融合、INT8、VAE Tile Batch | 已包含 | 运行时镜像固定了已验证的 ComfyUI、PyTorch 和自定义节点版本。 |
| 首/尾帧与多模态参考 | 已包含 | 下载 Ref2VA 权重后，由 ComfyUI 原生参考节点提供。 |
| Turbo LoRA 8-step、TAEH3 预览 | 已包含 | 引导脚本会下载公开资产；TAEH3 只影响实时预览。 |
| MiniMax Music3 | 已包含 | 下载 Music3 三个核心文件后自动启用。 |
| RealESRGAN x2 / 2K 路径 | 已包含 | 以独立低显存 worker 运行，并校验官方 SHA-256。 |
| FastH3 VSA | 需授权资产 | LoRA 与 gate 没有可复现的公开来源；用 `--private-assets` 从受控交付包安装。 |
| FlashVSR | 可选实验项 | 仍需本机编译和兼容性 gate；核心部署不会因它失败而阻断。 |

## 前置条件

1. GB10 已安装可工作的 NVIDIA 驱动，`nvidia-smi` 能显示 GPU。
2. Docker Engine、Docker Compose v2 与 Git 已安装。
3. NVIDIA Container Toolkit 已配置到 Docker；安装方式以 [NVIDIA 官方指南](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) 为准。若机器只有驱动和 Docker，可让引导脚本按该官方流程安装并配置（会修改 Docker 配置并重启 Docker）：

```bash
./scripts/bootstrap-fresh-gb10.sh --env .env.fresh --install-nvidia-container-toolkit
```

完成后应能通过 `docker run --rm --gpus all <gpu-image> nvidia-smi`。
4. 已获此私有仓库和 GitHub Container Registry 包的访问权。首次在机器上拉取前执行：

```bash
docker login ghcr.io
```

登录 token 需要 `read:packages` 权限；制作并推送 `comfy-runtime` 的维护账号还需要 `write:packages`。若使用 GitHub CLI 管理当前登录，可在有用户确认的终端中执行 `gh auth refresh -s read:packages -s write:packages` 追加权限。不要把 token 写进 `.env.fresh`、shell 历史或仓库。

5. 确认模型许可证允许下载与使用。引导脚本使用魔搭下载公开模型；若网络受限，可先在其他机器下载并传入同样的目录结构。

## 一次性部署

在新 GB10 上克隆仓库到计划的运行目录。默认示例使用 `/opt/h3-studio`；普通管理员先把该目录交给当前用户，避免后续模型、输出目录因权限不足失败：

```bash
sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/h3-studio
git clone https://github.com/Xiaofei-fei/h3-studio-gb10.git /opt/h3-studio
cd /opt/h3-studio
cp .env.fresh.example .env.fresh
```

编辑 `.env.fresh` 中的绝对路径；默认值已按 `/opt/h3-studio` 布局设置，并固定到本次审计的应用和 ComfyUI runtime digest。发布的运行时与 Node 应用均使用镜像内稳定的 `1000:1000` 服务账号。引导脚本会只调整 H3 Studio 的输入、输出和 worker 状态目录为该账号，不会改动模型文件的所有者。若改用其他目录，需一致替换 `.env.fresh` 内四个 `H3_STUDIO_*_DIR/ROOT` 路径。

执行引导：

```bash
./scripts/bootstrap-fresh-gb10.sh --env .env.fresh
```

脚本依次验证 GPU 容器访问、拉取私有镜像、从运行时镜像提取 worker 所需的 venv、从魔搭下载核心模型、下载 TAEH3 和 RealESRGAN、构建 worker、启动服务并验收节点和能力。成功后界面仅绑定在本机：`http://127.0.0.1:5174`。

若模型已经由管理员预置，使用 `--skip-model-download`；脚本会在启动前逐个检查所需文件，缺失时直接退出而不会产生半可用服务。
镜像和模型均已预置时，后续结构验收只在现有容器的桥接网络内请求服务，不会为检查额外拉取 Docker Hub 工具镜像。

## FastH3 与离线传输

FastH3 的 LoRA 与 gate 必须来自同一份授权交付包。不要替换成同名、不同版本的文件：

```bash
./scripts/bootstrap-fresh-gb10.sh --env .env.fresh \
  --private-assets /secure/h3-authorized-assets
```

离线传输时，把 [下载清单](downloads.md)中列出的模型按相对目录放入 `H3_STUDIO_MODELS_DIR`，并把 `RealESRGAN_x2plus.pth` 放入 `H3_STUDIO_RUNTIME_DIR/realesrgan-models/`。RealESRGAN 必须匹配清单中的 SHA-256。随后运行：

```bash
./scripts/bootstrap-fresh-gb10.sh --env .env.fresh --skip-model-download
```

## 验收、升级与回滚

结构验收可重复运行，不会重新下载模型：

```bash
./scripts/verify-fresh-gb10.sh --env .env.fresh
```

该检查确认 ComfyUI、H3 Standard、参考模式、Music3、TAEH3、Sparge、VAE Tile Batch 和 RealESRGAN 的节点、模型下拉项及 BFF 健康状态。完成后应在界面实际提交一次固定 seed 的 H3 Standard 样例和一次 Music3 样例，确认所选模型许可证、显存余量与画面质量符合预期。

升级到新的已审计版本时，先在 `.env.fresh` 中显式更新应用和 runtime 的 digest，再执行：

```bash
docker compose --env-file .env.fresh -f docker-compose.fresh-gb10.yml pull
docker compose --env-file .env.fresh -f docker-compose.fresh-gb10.yml up -d --build
./scripts/verify-fresh-gb10.sh --env .env.fresh
```

停止服务不会删除模型和输出：

```bash
docker compose --env-file .env.fresh -f docker-compose.fresh-gb10.yml down
```

## 运行时镜像发布

`ghcr.io/xiaofei-fei/h3-studio-gb10/comfy-runtime:gb10-v1` 由一个已验证的 GB10 运行环境制作，包含 ComfyUI 代码、Python venv、节点实现，以及 RealESRGAN worker 所需的 FastAPI/Uvicorn 控制面依赖；不含模型、输入、输出、`.env`、Git 历史或 secret 文件。镜像直接启动已验证的 ComfyUI 与 venv，不运行基础镜像内会更新代码或 Python 包的安装脚本。发布脚本会在 Docker build 前再次拒绝 `.safetensors`、`.ckpt`、`.pth`、`.pt`、`.onnx` 和敏感文件名。新机模板不依赖这个可变 tag，而是使用已验证的 digest。

只有维护运行时的管理员才执行以下命令；先用 `--no-push` 在隔离标签上检查，再推送 GHCR：

```bash
./scripts/publish-comfy-runtime-gb10.sh \
  --source /path/to/known-good-comfy-runtime \
  --image ghcr.io/xiaofei-fei/h3-studio-gb10/comfy-runtime:gb10-v1 \
  --no-push
```

确认本地容器能启动且节点齐全后，移除 `--no-push` 才会上传。应用镜像由 GitHub Actions 自动发布为 ARM64 `app:main`；运行时镜像发布仍需要 GB10 原生环境，避免把 GPU/Python 环境差异隐藏在跨架构构建里。

若发布机只能通过本机代理访问 PyPI，可显式传入标准代理环境变量并使用主机网络，例如 `HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 ./scripts/publish-comfy-runtime-gb10.sh --source /path/to/runtime --build-network host --no-push`。该网络设置只用于发布时安装 worker 控制面依赖，不会写入最终镜像。
