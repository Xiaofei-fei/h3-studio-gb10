# 推理优化指南

本页只描述当前 H3 Studio 已接入的路径。模型、CUDA、ComfyUI 节点或驱动升级后，应重新做同条件 A/B；社区论文或其他模型的指标不能直接套用到 H3。

## 三种推理模式

| 模式 | 工作流合同 | 适合场景 | 不应与什么混比 |
| --- | --- | --- | --- |
| H3 Standard | 6/10/15/20/25 step；Turbo 开启时固定 8 step | 质量基线、常规成片、单变量试验 | 不要把它与 FastH3 的总时间归因为某一个 kernel。 |
| FastH3 VSA | 匹配 LoRA、resident gate、4-step Euler，可选专用融合/INT8/VAE 解码档位 | 低延迟预览与受控 A/B | 不叠加 Standard 的缓存、Sparge、Fused Modulation。 |
| MiniMax Music3 | 固定 30-step Euler，文本条件 | 音乐生成 | 不支持视频参考，也没有视频注意力优化。 |

视频时长会先按 H3 时间网格对齐。服务以 24 FPS 计算，再把帧数调整到符合模型要求的长度；性能对比必须固定实际帧数，而不只是界面上写的秒数。

## H3 Standard

| 技术 | 解决的问题 | 原理 | 当前边界 |
| --- | --- | --- | --- |
| 稠密注意力基线 | 为质量和定位问题提供参照 | 使用现有 ComfyUI 稠密后端 | 最稳妥，但注意力开销最大。 |
| SpargeAttention | 长时空序列的注意力计算与访存 | 以块级 top-k 路由，只计算选中的 Q/K/V 块；最后一步保持稠密 | 近似路径。Balanced 比 Fast 保守；蒸汽、慢推镜头和背景虚化要看整片连续性。 |
| FirstBlockCache | 相邻去噪步首块重复计算 | 在阈值内复用首个 DiT block 特征，最多连续命中两次 | Safe/ Fast/ Aggressive 档位分别以 0.08/0.10/0.12 阈值控制；与 EasyCache 互斥。 |
| EasyCache | 更大范围的跨步重复计算 | 按 `reuse_threshold=0.20` 在 15%–95% 去噪区间复用状态 | 加速潜力更高，也更容易把近似误差带入后续步；适合构图预览。 |
| Fused Modulation | 条件调制的小 kernel 与中间张量开销 | 合并 scale、shift、gate 等相邻调制操作 | 接近等价重排，但仍需在当前混合精度栈上做数值/成片验证。 |
| Turbo LoRA | 直接减步造成的结构与时序损失 | 用匹配的 LoRA 适配短采样轨迹 | 固定强度 1.0、固定 8 step；是低步数模型合同，不是通用跳步。 |
| VAE Tile Batch | 去噪加速后显现的解码尾部 | 小批量解码多个视频 tile | Standard 使用 batch 2；目标是改调度而非改 latent，显存不足时回退普通解码。 |
| GB10 cuBLAS INT8 | H3 ConvRot INT8 投影的 GEMM 热点 | 用 GB10 适配的 INT8 投影后端覆盖 QKV/输出/MLP 范围 | 与 AdaGEMM INT8 互斥；只在 capability 检测通过时允许启用。 |
| AdaGEMM INT8 | 同一类投影热点的实验性替代后端 | 按 token/通道量化及形状适配选择内核 | 当前为实验路径；不要与 cuBLAS 同时开，需单独测质量和端到端收益。 |

`TAEH3 实时预览` 是单独的界面开关，不应被计入最终推理优化：它用于在采样时显示预览，最终视频仍走正常解码和保存流程。

AdaGEMM 的一轮受控剖析见[Phase 0–2 实测报告](perf/2026-09-03-h3-adagemm-phase0-2-report.md)：当前 packing cache 的中位数反而慢约 0.14%，因此没有作为默认优化保留。报告也给出下一步应优先分析 ConvRot、动态量化、布局转换和 VAE 尾部的依据。

### Sparge 与缓存的取舍

Sparge 和缓存都以受控近似换计算量，但误差位置不同：Sparge 改变 attention 可见的块，缓存复用相邻去噪步的特征或状态。若视频有抖动，推荐按下面顺序回退定位：

1. 关闭 EasyCache；
2. 用 FirstBlockCache Safe 替代；
3. 将 Sparge 从 Fast 调为 Balanced；
4. 关闭 Sparge，回到稠密基线；
5. 最后才减少步数或切换 Turbo / FastH3。

这样能区分时序问题来自近似注意力、跨步复用还是低步数采样。

## FastH3 VSA

FastH3 是独立的优化链：

```text
INT8 ConvRot H3
  → FastH3 4-step LoRA (strength 1.0)
  → H3VSA (top-k 0.10, resident gate)
  → optional FastH3 Fused Modulation
  → optional GB10 cuBLAS INT8 or AdaGEMM INT8
  → fixed simple scheduler + 4-step Euler
  → optional VAE Tile Batch 1 / 2 / 4
```

VSA 使用训练 gate 选择视频 attention 的有效块，而不是随机丢弃 token。gate 在 resident 模式下首次使用后保留在 GPU，减少每个去噪步的传输代价，但会增加显存占用。对不满足 CUDA BF16、序列长度、gate 或形状要求的情况，节点应回退原始稠密 attention。FastH3 的 Fused Modulation 与 VAE batch 档位可独立启用；先以原生 VAE 解码为质量基线，再比较 batch 1、2、4 的端到端时间与显存峰值。

当前有一组受控 FastH3 数据：在 832×480、124 帧、4-step Euler、固定 seed、resident gate、视频和音频均开启的条件下，基线为 63.012 秒；两次 cuBLAS INT8 运行分别为 54.999 秒与 56.431 秒，中位数 55.715 秒，较基线快 11.58%。该组 RGB24 与 PCM16 校验一致。

这只证明该固定软件栈和输入下的窄路径表现；不构成所有提示词、所有版本的无损承诺。

## MiniMax Music3

Music3 使用独立的文本编码、音频 latent 和采样工作流：固定 30-step Euler，支持歌词和提示词。`VAEDecodeAudioTiled` 可把音频解码分块（当前 tile size 512、overlap 64），主要用于降低解码峰值和提高长音频处理稳定性。它不会改变视频模式的优化开关。

## 性能与质量评估

性能测试至少固定以下字段：模式、提示词、分辨率、时长、实际帧数、步数、采样器、seed、参考素材和所有无关开关。每组交替运行至少五次，报告 p50/p95 与分阶段时间；不要只挑最快一次。

| 优化类型 | 合适的质量检查 |
| --- | --- |
| cuBLAS / 可能等价的 VAE 调度 | raw RGB24、PCM16 checksum；必要时比较数值误差。 |
| Fused Modulation | 同 seed 的数值/像素误差与完整视频检查。 |
| Sparge、VSA、缓存、低步数 LoRA | 整片审查、闪烁、光流 warp error、tLPIPS、镜头连续性和音画同步。 |

对于咖啡蒸汽、细小颗粒、景深变化和慢推镜头，单帧清晰不代表时序稳定。把最后一个去噪步保留为稠密、先采用保守阈值、并保留一个无近似质量参考，通常比追求单次最快时间更可靠。
