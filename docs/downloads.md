# 大文件下载与预置清单

本仓库**不分发**模型、权重、运行镜像或生成媒体。本页给出当前工作流实际引用的大文件、来源、目标目录和校验边界，便于在新机器预置后再运行部署脚本。

优先使用魔搭；Hugging Face 链接仅作为官方备选。下载前先打开模型页确认许可证并完成可能要求的授权。文件名必须与本页一致，不能以同类模型、相近量化版本或不同 step 的 LoRA 替代。

## 使用约定

- 下文的 `ComfyUI/models` 是目标 ComfyUI 实例的模型根目录，不是本仓库目录。
- 大文件可先下载到有较好网络的机器，执行 `sha256sum <文件>` 后再用支持断点续传的方式传到 GB10；不要把文件或临时签名链接提交到 Git。
- 魔搭命令行可安装为 `python -m pip install -U modelscope`。下方的 `modelscope download` 示例会保留仓库内的目录结构；将 `COMFY_MODELS_DIR` 改成实际的 `ComfyUI/models`。
- 真实部署前仍以 [`config/model-manifest.yaml`](../config/model-manifest.yaml)、ComfyUI 的文件下拉框和 `GET /api/health` 为准。

## MiniMax H3

来源页：[魔搭 Comfy-Org/MiniMax-H3](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/summary)（主入口）｜[Comfy-Org / Hugging Face](https://huggingface.co/Comfy-Org/MiniMax-H3)（备选）｜[MiniMax 原始模型页](https://huggingface.co/MiniMaxAI/MiniMax-H3)。H3 采用其社区许可证；应先阅读并接受源站条款。

| 文件 | 安装位置（相对 `ComfyUI/models`） | 下载 |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| `minimax_h3_video_vae_fp16.safetensors` | `vae/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_video_vae_fp16.safetensors) |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_audio_vae_fp32.safetensors) |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | `loras/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors) |

可按需拉取当前 H3 Standard、参考模式和 8-step Turbo 所需的文件：

```bash
export COMFY_MODELS_DIR=/path/to/ComfyUI/models
modelscope download --model Comfy-Org/MiniMax-H3 --local_dir "$COMFY_MODELS_DIR" \
  --include "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" \
            "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" \
            "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
            "vae/minimax_h3_video_vae_fp16.safetensors" \
            "vae/minimax_h3_audio_vae_fp32.safetensors" \
            "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
```

## MiniMax Music3

来源页：[魔搭 Comfy-Org/MiniMax-Music-3](https://www.modelscope.cn/models/Comfy-Org/MiniMax-Music-3)（主入口）｜[Comfy-Org / Hugging Face](https://huggingface.co/Comfy-Org/MiniMax-Music-3)（备选）｜[MiniMax 原始模型页](https://huggingface.co/MiniMaxAI/MiniMax-Music3)。Music3 的 Comfy-Org 包标注为 Apache-2.0；安装前仍须在来源页确认版本与条款。

| 文件 | 安装位置（相对 `ComfyUI/models`） | 下载 |
| --- | --- | --- |
| `minimax_music3_dit_fp16.safetensors` | `diffusion_models/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/diffusion_models/minimax_music3_dit_fp16.safetensors) |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `text_encoders/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors) |
| `minimax_music3_dav.safetensors` | `vae/` | [魔搭直链](https://www.modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/master/vae/minimax_music3_dav.safetensors) |

```bash
export COMFY_MODELS_DIR=/path/to/ComfyUI/models
modelscope download --model Comfy-Org/MiniMax-Music-3 --local_dir "$COMFY_MODELS_DIR" \
  --include "diffusion_models/minimax_music3_dit_fp16.safetensors" \
            "text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors" \
            "vae/minimax_music3_dav.safetensors"
```

## 预览、增强与 FastH3 附加资产

| 资产 | 安装位置 / 用法 | 下载与校验 |
| --- | --- | --- |
| `taeh3_decoder.safetensors` | `ComfyUI/models/vae_approx/`；只用于 TAEH3 实时预览，不影响最终视频。 | [MiniMax H3 Preview Override 项目](https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride)｜[文件直链](https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride/raw/main/minivae/taeh3_decoder.safetensors)。这是社区项目资产，下载后应记录自己的 SHA-256。 |
| FlashVSR v1.1 | 放入 `H3_STUDIO_FLASHVSR_MODEL_DIR`。部署脚本会在目录不完整时从魔搭下载并写入本地 manifest。 | [魔搭 AI-ModelScope/FlashVSR](https://www.modelscope.cn/models/AI-ModelScope/FlashVSR/summary)｜[diffusion 权重](https://www.modelscope.cn/models/AI-ModelScope/FlashVSR/resolve/master/diffusion_pytorch_model_streaming_dmd.safetensors)｜[LQ projection](https://www.modelscope.cn/models/AI-ModelScope/FlashVSR/resolve/master/LQ_proj_in.ckpt)｜[TCDecoder](https://www.modelscope.cn/models/AI-ModelScope/FlashVSR/resolve/master/TCDecoder.ckpt)｜[Wan VAE](https://www.modelscope.cn/models/AI-ModelScope/FlashVSR/resolve/master/Wan2.1_VAE.pth)｜[官方源码](https://github.com/OpenImagingLab/FlashVSR)。四个文件缺一不可。 |
| `RealESRGAN_x2plus.pth` | 先下载到任意安全的 staging 路径，再把该绝对路径填入 `H3_STUDIO_REALESRGAN_MODEL_SOURCE`。部署脚本会复制到 worker 私有目录。 | [官方 v0.2.1 文件直链](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth)｜[官方项目](https://github.com/xinntao/Real-ESRGAN)。预期 SHA-256：`49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb`。 |
| `fasth3_vsa_4-steps-v5.safetensors` | `loras/`；由标准 LoRA loader 加载。 | [公开 ComfyUI 转换包](https://huggingface.co/barelymining/ComfyUI-MiniMax-H3-FastVideo)｜[文件直链](https://huggingface.co/barelymining/ComfyUI-MiniMax-H3-FastVideo/resolve/main/fasth3_vsa_4-steps-v5.safetensors)。SHA-256：`70831f37ad1431f0686c8976d3ec949a4359ae67316d654b453d8809517bb268`。 |
| `fasth3_vsa_gate.safetensors` | `loras/`；由 `H3VSA` 节点注入。 | 同一[公开 ComfyUI 转换包](https://huggingface.co/barelymining/ComfyUI-MiniMax-H3-FastVideo)｜[文件直链](https://huggingface.co/barelymining/ComfyUI-MiniMax-H3-FastVideo/resolve/main/fasth3_vsa_gate.safetensors)。SHA-256：`bf95408e335c4b0d6a1a44946a428a3e12849e6eab2de9566ecedae4a0043420`。 |
| `vsa-datafree/adapter_model.safetensors` | **不要直接放入** ComfyUI `loras/`；它是 FastVideo 原始 adapter。 | [魔搭 FastVideo FastH3 LoRA](https://www.modelscope.cn/models/FastVideo/FastVideo-FastH3-4-step-Preview-v1-LoRA)｜[魔搭直链](https://www.modelscope.cn/models/FastVideo/FastVideo-FastH3-4-step-Preview-v1-LoRA/resolve/master/vsa-datafree/adapter_model.safetensors)。公开下载，SHA-256：`42dc502a2078f166c396a1fa75f29728d1844363652d345d5ef3e2b444ed6470`。原始 adapter 含拆分 Q/K/V、完整 AdaLN 与 gate，需转换后才能供本项目的 ComfyUI 路径使用。 |

FlashVSR 的 worker 还会以固定提交构建源码依赖；`npm run deploy:gb10` 会自动且可恢复地下载这些归档。离线或网络较慢时可预先放入 GB10 工作目录的 `flashvsr-sources/`：

- [FlashVSR `cf910c6` 源码归档](https://codeload.github.com/OpenImagingLab/FlashVSR/tar.gz/cf910c61a60733e610e9c6e8b607f80c3a6c202b)
- [Block-Sparse-Attention `49d6c39` 源码归档](https://codeload.github.com/mit-han-lab/Block-Sparse-Attention/tar.gz/49d6c39e4dc0303442cda3bb758b3925d4399c49)
- [NVIDIA CUTLASS `a75b4ac` 源码归档](https://codeload.github.com/NVIDIA/cutlass/tar.gz/a75b4ac483166189a45290783cb0a18af5ff0ea5)

将前三者依次命名为 `FlashVSR.tar.gz`、`Block-Sparse-Attention.tar.gz`、`CUTLASS.tar.gz`。部署脚本会验证归档顶层目录与固定提交是否一致；FlashVSR 模型安装完成后会在 `flashvsr-state/model-manifest.json` 记录每个文件的 SHA-256。

## 运行镜像与容器前置

| 镜像 / 文件 | 获取方式 | 说明 |
| --- | --- | --- |
| `ghcr.io/xiaofei-fei/h3-studio-gb10/comfy-runtime@sha256:7d004a5c96c250d279ab4c227ca92f3af8a4699444d4d6dfa1e01f5b2c323609` | 私有 GitHub Container Registry 包；先执行 `docker login ghcr.io`，并获得该包的读取权限。 | 全新 GB10 默认使用的已审计 ComfyUI 运行时（发布 tag 为 `gb10-v1`），包含固定的 ARM64 ComfyUI、venv 和自定义节点，**不含模型权重、输入、输出或凭据**。部署步骤见[全新 GB10 部署](fresh-gb10-deployment.md)。 |
| `ghcr.io/xiaofei-fei/h3-studio-gb10/app@sha256:d58c07b412a30f154c4c9a740697ae789c3d2be2af13fe29c0120a18ab801ea5` | 私有 GitHub Container Registry 包；与上项使用同一登录。 | 全新 GB10 默认使用的已审计 ARM64 应用镜像（构建 tag 为 `sha-1af695fe3283ff489fa7a36e67699f0ff32b9771`）；`app:main` 仅用于明确升级后跟踪最新版本。 |
| `node:22-bookworm-slim-linuxarm64` | [Node 官方镜像页](https://hub.docker.com/_/node)。本仓库 Dockerfile 使用的镜像引用为 `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim-linuxarm64`。 | 构建 `h3-studio:gb10` 时自动拉取；网络受限时可先执行 `docker pull` 预热。 |
| `comfyui-gb10:v2` | **没有公开下载链接记录。** | 仅用于旧的已有 ComfyUI 部署，或制作 `comfy-runtime` 时作为受控基础镜像；全新部署不要求该镜像已存在。 |
| `h3-studio:gb10`、`h3-studio-flashvsr:gb10`、`h3-studio-realesrgan:gb10` | 本仓库构建，不从远端 pull。 | 在 GB10 执行 `docker compose --env-file .env -f docker-compose.gb10.yml build`。 |
| `cloudflared`（可选） | [Cloudflare 官方 Release](https://github.com/cloudflare/cloudflared/releases/latest)｜[Linux ARM64 直链](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64)。 | 仅在启用 Cloudflare 隧道时需要。保存为 `bin/cloudflared` 并赋予可执行权限后，再构建 `docker-compose.cloudflared.yml` 中的本地镜像。 |

## 下载后的最小检查

```bash
# 对来源给出 checksum 的文件，先在下载机核验，再传输。
sha256sum /path/to/RealESRGAN_x2plus.pth

# 在 GB10，确认必要的本地基础镜像已经存在。
docker image inspect comfyui-gb10:v2 >/dev/null

# 预检只读取路径和配置；有 Docker 的 GB10 可同时展开 Compose。
node scripts/preflight-portable.mjs --h3-env-file .env --require-docker
```

完成预置后按 [GB10 部署](deployment-gb10.md) 执行。若 `GET /api/health` 显示某项能力不可用，优先核对文件名、模型目录、节点版本与下载来源的 checksum；不要通过关闭 capability 检查强行启用。
