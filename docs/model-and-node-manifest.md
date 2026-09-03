# 模型与节点清单

所有权重均为外部依赖，不随本仓库分发。机器管理员应从已授权来源获取文件、核验来源提供的 checksum，并遵守对应许可证。可机器读取的元数据在 [`config/model-manifest.yaml`](../config/model-manifest.yaml)。

## 模型文件

| 领域 | 文件 | 用途 |
| --- | --- | --- |
| H3 Standard / FastH3 | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | H3 视频 DiT / UNet。 |
| 参考视频 | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 首/尾帧和多模态参考条件。 |
| H3 文本条件 | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 文本与多模态编码。 |
| H3 VAE | `minimax_h3_video_vae_fp16.safetensors`、`minimax_h3_audio_vae_fp32.safetensors` | 视频与音频解码。 |
| Turbo | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | Standard 的固定 8-step 适配。 |
| FastH3 | `fasth3_vsa_4-steps-v5.safetensors`、`fasth3_vsa_gate.safetensors` | FastH3 的 4-step LoRA 与 VSA gate。 |
| Music3 | `minimax_music3_dit_fp16.safetensors`、`minimax_music3_text_encoder_pruned_int8_convrot.safetensors`、`minimax_music3_dav.safetensors` | Music3 DiT、文本编码器、音频 VAE。 |
| 稳定增强 | `RealESRGAN_x2plus.pth` | RealESRGAN x2 模型；部署脚本和 worker 使用 manifest 中的 SHA-256。 |
| FlashVSR | 由授权渠道提供的 FlashVSR 资产 | worker 在兼容性 gate 中验证可用性，不通过则不开放。 |

不要将下载缓存、临时签名 URL、模型目录或权重拷入仓库。模型文件扩展名已被 `.gitignore` 和发布扫描阻止。

## ComfyUI capability

BFF 启动时查询 ComfyUI 的 `/object_info`，提交任务前会再次检查。下表列出的“缺失行为”是刻意的安全策略：缺失时禁用选项或拒绝请求，而不是伪造已开启的优化。

| 能力 | 主要节点 / 文件 | 缺失行为 |
| --- | --- | --- |
| Standard 工作流 | `UNETLoader`、`CLIPLoader`、`VAELoader`、`MiniMaxH3ImageToVideo` | H3 无法提交。 |
| 参考输入 | `MiniMaxH3ReferenceToVideo` 与 Ref2VA 文件 | 参考模式不可用。 |
| Turbo | `LoraLoaderModelOnly` 与 Turbo LoRA | Turbo 开关不可用。 |
| Sparge / 缓存 / 融合 | `H3SpargeAttention`、`ApplyMiniMaxH3FirstBlockCache`、`ApplyMiniMaxH3EasyCache`、`MiniMaxH3FusedModulation` | 相应 Standard 开关不可用或不能作为成功配置使用。 |
| INT8 | `MiniMaxH3GB10CublasInt8`、`MiniMaxH3GB10AdaGemmInt8` | 仅禁用对应后端；主路径仍可运行。 |
| VAE Tile Batch | `MiniMaxH3VAEDecodeBatched` | 回到普通 VAE 解码。 |
| TAEH3 | `H3StudioTAEH3PreviewLoader`、`MiniMaxH3PreviewOverride` | 实时预览开关禁用，不影响最终生成。 |
| FastH3 VSA | `H3VSA`、FastH3 LoRA、gate 文件 | FastH3 整体不可用。 |
| Music3 | `MiniMaxMusic3TextEncode`、`EmptyMiniMaxMusic3LatentAudio`、`VAEDecodeAudioTiled` 及 Music3 模型 | Music3 或其分块解码不可用。 |

完整节点映射在 [`config/comfy-capabilities.md`](../config/comfy-capabilities.md)。

## 安装与验证顺序

1. 把权重安装到 ComfyUI 能扫描的模型目录，并按来源核验 hash。
2. 安装/更新自定义节点，重启 ComfyUI，使 `/object_info` 反映新节点和文件选项。
3. 运行 `curl http://127.0.0.1:8188/system_stats`，确认 ComfyUI 本身可用。
4. 运行 `curl http://127.0.0.1:5174/api/health`，查看每项能力的可用性和缺失原因。
5. 对新的模型或节点版本，先以 H3 Standard 稠密路径做一个固定 seed 的小样本，再逐项开启优化。

如果模型需要从其他机器传入，请先在来源机器完成 hash 校验，再使用可恢复的传输方式复制完整文件；完成后再让 ComfyUI 扫描，避免把半成品权重暴露给运行服务。
