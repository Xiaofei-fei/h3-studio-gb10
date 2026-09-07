# H3 Studio ComfyUI 工作流

将下列 JSON 文件拖入 ComfyUI 画布，或使用 **Workflow → Open** 导入。它们已采用当前 GB10 环境可用的节点名称和模型文件名；导入后只需编辑 `MiniMaxH3ImageToVideo` 节点中的 prompt、分辨率、帧数和 `RandomNoise` seed。

| 文件 | 用途 | 已选优化 |
| --- | --- | --- |
| `h3-standard-turbo-easycache-adagemm.json` | H3 Standard 的低延迟预览配置 | Turbo LoRA 8-step、EasyCache、Sparge Balanced、Fused Modulation、AdaGEMM INT8、VAE Tile Batch 2、TAEH3 预览 |
| `fasth3-vsa-adagemm-full.json` | FastH3 VSA 的全开低延迟配置 | FastH3 4-step LoRA、resident VSA gate、Fused Modulation、AdaGEMM INT8、VSA Fused Layout Engine、VAE Tile Batch 4、TAEH3 预览 |

## 互斥项

- Standard 选用 **EasyCache**，因此不包含 FirstBlockCache。
- 两份工作流均选用 **AdaGEMM INT8**，因此不包含 GB10 cuBLAS INT8。
- FastH3 启用 **VSA Fused Layout Engine**，因此不包含 Kernel Profiler。

## 固定采样合同

- Standard：`simple` scheduler、`res_multistep` sampler、Turbo 固定 8 step。
- FastH3：`simple` scheduler、Euler sampler、匹配 LoRA 固定 4 step。

两份文件默认均为 832×480、124 帧（约 5 秒）、24 FPS，并包含视频和原生音频解码。FastH3 与 Turbo 都属于低步数模型合同；若要作为质量基线，请另行使用不含低步数 LoRA、缓存与稀疏近似的 Standard 稠密图。
