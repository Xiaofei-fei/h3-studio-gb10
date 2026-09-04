# MiniMax H3 推理优化技术说明与 GB10 性能对照

> 适用范围：H3 Studio、GB10、ComfyUI 的当前集成版本。
> 更新日期：2026-09-04。
> 本文说明已接入的技术、工作流实现和已记录的效果；论文、社区项目或其他机器的结果均不直接视为本机结论。

## 1. 结论摘要

H3 Studio 的优化分为两类：

| 路径 | 核心目标 | 主要手段 | 质量定位 |
| --- | --- | --- | --- |
| H3 Standard | 在常规采样下缩短 DiT 和解码时间 | 稀疏注意力、跨步缓存、调制融合、INT8 后端、VAE 批量解码 | 用于质量基线、6–25 step 成片和单变量 A/B |
| FastH3 VSA | 用训练配套的低步数稀疏路径压低端到端时延 | 4-step LoRA、训练 gate、VSA、resident gate、GB10 INT8 后端 | 用于低延迟预览；不是 Standard 的“叠加开关” |
| MiniMax Music3 | 降低长音频解码的峰值与调度压力 | 音频 VAE 分块解码 | 稳定性 / 显存管理，非视频 DiT 加速 |

已记录的本机受控结果只有两类可量化结论：

1. FastH3 VSA 的 GB10 cuBLAS INT8 路径，在 832×480、124 帧、4-step Euler、resident gate 的固定条件下，中位端到端时间从 63.012 s 降至 55.715 s，提升 11.58%；该组 RGB24 与 PCM16 校验一致。
2. H3 Standard 的 AdaGEMM packing cache 试验虽然保持输出一致，但中位时间从 67.233 s 变为 67.324 s，约慢 0.14%，因此没有作为默认优化。

其余开关已完成 workflow、能力探测或实现级验证，但尚未形成足以对外承诺的本机 p50 / p95 数据。本文不把它们写成固定加速百分比。

## 2. 推理链路与优化位置

一次视频请求由条件构建、DiT 去噪、视频解码、音频解码和封装构成。去噪通常占主导；在低步数或稀疏注意力生效后，视频 VAE 解码会成为新的尾部瓶颈。

~~~text
Prompt / 首尾帧 / 多模态参考
             │
             ▼
      文本与视频条件构建
             │
             ▼
       H3 DiT 去噪采样
       ├─ 注意力与投影热点
       ├─ 条件调制热点
       └─ 相邻 step 的重复计算
             │
             ├────────► 视频 VAE 解码
             └────────► 音频 VAE 解码
                              │
                              ▼
                           MP4 封装
~~~

当前基础权重本身也构成性能前提，但不是前端优化开关：

| 组件 | 当前格式 | 作用 |
| --- | --- | --- |
| H3 DiT | <code>fl2va_pruned_int8_convrot</code> | 已裁剪的 ConvRot INT8 权重，降低权重带宽与低精度 GEMM 成本 |
| H3 文本编码器 | NVFP4 / AWQ | 降低文本编码器的显存和加载压力；不代表整个 DiT 为 NVFP4 |
| 视频 VAE | FP16 | 在重建质量与显存之间折中 |
| 音频 VAE | FP32 | 当前未对音频路径做近似量化 |

服务会把 5 秒请求按 H3 的时间网格对齐。24 FPS 下的 5 秒请求会从 120 帧对齐到 124 帧，实际时长约 5.17 秒。因此性能比较必须固定实际帧数，而不能只固定“5 秒”这个界面参数。

## 3. 工作流架构与实现边界

### 3.1 H3 Standard

~~~text
INT8 ConvRot H3
  → [可选] Turbo LoRA 8-step
  → [二选一] FirstBlockCache / EasyCache
  → [可选] Fused Modulation
  → [可选] SpargeAttention
  → [可选] GB10 cuBLAS INT8 或 AdaGEMM INT8
  → Scheduler + Guider + Sampler
  → [可选] VAE Tile Batch 2
  → 视频 / 音频封装
~~~

所有模型补丁按上述顺序串联，Scheduler 与 Guider 接收同一个最终 model link。关闭 SpargeAttention 时，服务传递 <code>dense_backend: inherit</code>，由当前 GB10 ComfyUI 的稠密后端执行；界面中的 “Sage / Dense” 是后端配置，并非 H3 Studio 额外插入的节点。

### 3.2 FastH3 VSA

~~~text
INT8 ConvRot H3
  → FastH3 4-step LoRA（strength = 1.0）
  → H3VSA（topk = 0.10，resident gate）
  → [可选] Fused Modulation
  → [可选] GB10 cuBLAS INT8 或 AdaGEMM INT8
  → [可选] GB10 VSA layout packer
  → 固定 simple scheduler + 4-step Euler
  → [可选] VAE Tile Batch 1 / 2 / 4
  → 视频 / 音频封装
~~~

FastH3 固定使用匹配的 LoRA、4 个 Euler step、VSA gate 和稀疏率。它会清空 Standard 的缓存、SpargeAttention、Turbo 和 Standard VAE batch 字段，避免把两套近似策略混在一起。这样做同时保证速度归因、质量归因和同 seed 复现实验可解释。

## 4. 已接入的优化技术

### 4.1 注意力与跨步计算

| 技术 | 解决的问题 | 原理 | 当前实现 | 效果与边界 |
| --- | --- | --- | --- | --- |
| 稠密注意力基线 | 提供质量与问题定位参照 | 计算完整 <code>softmax(QKᵀ / √d)V</code> | 关闭 Sparge 后回到继承的稠密后端 | 最稳妥，但长视频时空 token 的计算和访存成本最高 |
| SpargeAttention | 视频时空注意力的二次计算与访存 | 以 64-token block 进行 top-k 路由，只计算保留的 Q/K/V 块 | <code>H3SpargeAttention</code>；Balanced 使用 routing 0.15 / video 0.12，Fast 使用 0.10 / 0.08；最后 1 step 强制稠密 | 受控近似。Balanced 是优先档；细蒸汽、景深和慢推镜头需检查全片闪烁与运动连续性 |
| FirstBlockCache | 相邻 step 首个 DiT block 的重复计算 | 当前状态与缓存特征差异低于阈值时，复用 Block 0 输出 | <code>ApplyMiniMaxH3FirstBlockCache</code>；Safe / Fast / Aggressive 阈值为 0.08 / 0.10 / 0.12，10%–95% 区间，最多连续命中 2 次 | 较保守的近似路径。Safe 不等于无损，且当前 <code>temporal_guard=false</code> |
| EasyCache | 更大范围的跨 step 重复计算 | 在满足阈值时复用前一去噪结果或中间状态 | <code>EasyCache</code>；<code>reuse_threshold=0.20</code>，15%–95% 区间 | 覆盖范围更大、潜在收益更高，也更容易把误差传到后续 step；适合构图预览 |
| FastH3 VSA | FastH3 路径中的视频注意力热点 | 由训练 gate 为每个 attention block 选取有效时空块，而非随机丢 token | <code>H3VSA</code> 读取 <code>fasth3_vsa_gate.safetensors</code>，按 64 token 补齐，<code>topk_ratio=0.10</code>，调用 <code>video_sparse_attn</code> | 近似注意力，但 gate 与 FastH3 LoRA 配套训练；不满足 BF16、长度、gate 或形状前提时回退原稠密 forward |
| Gate residency | VSA gate 的重复 CPU→GPU 传输 | 首次使用后把 BF16 gate 缓存在 GPU | FastH3 固定 <code>gate_residency=resident</code> | 以约 3.6 GB 额外显存换取后续 step 的传输节省；冷启动 / 首次任务不应与热态混计 |

FirstBlockCache 与 EasyCache 互斥。两者都在控制跨 step 复用，同时开启会使命中顺序、速度来源和质量偏差无法归因。出现抖动时，建议按 EasyCache → FirstBlockCache Safe → Sparge Balanced → 稠密基线的顺序回退定位。

### 4.2 条件调制、GEMM 后端与布局

| 技术 | 解决的问题 | 原理 | 当前实现 | 效果与边界 |
| --- | --- | --- | --- | --- |
| Fused Modulation | scale、shift、gate 等小算子的 launch 与中间张量开销 | 合并相邻调制操作，减少中间读写与 kernel 边界 | <code>MiniMaxH3FusedModulation</code> 放在缓存后、Sparge 前；FastH3 也可在 VSA 后单独启用 | 目标是接近等价的执行重排；底层 node 不在本仓库托管，仍需数值和成片 A/B |
| GB10 cuBLAS INT8 | QKV、attention 输出和 MLP 的 INT8 投影热点 | 对既有 ConvRot INT8 GEMM 改用适合 GB10 的 cuBLASLt 分派，不重新量化权重 | <code>MiniMaxH3GB10CublasInt8</code> 覆盖 <code>qkv_proj</code>、<code>out_proj</code>、<code>mlp</code>；通过 capability gate 后才开放 | FastH3 已有一组输出一致的 11.58% 受控提升；升级驱动、PyTorch、ComfyUI 或节点后需重验 |
| AdaGEMM INT8 | 同一组投影热点的替代后端 | 依据 token / 通道量化和矩阵形状选择内核 | <code>MiniMaxH3GB10AdaGemmInt8</code>，与 cuBLAS 为单选项 | 当前为实验路径。已验证 GB10 库覆盖实测矩阵形状，但 packing cache 没有端到端收益 |
| GB10 VSA layout packer | VSA 中 Q/K/V reshape、copy 与 padding 的数据移动 | 直接构造 VSA 所需的最终 padded layout，保留原 VSA 数学、gate、RoPE 和投影 | <code>H3StudioFastH3GB10VSA</code> 仅用于 FastH3；放在 INT8 补丁之后，未知输入回退原 forward | 实验性、lossless-first 实现；尚无可对外承诺的端到端加速数据，必须先做 checksum 与 p50 / p95 |
| FastH3 kernel profiler | 找出 VSA 内部实际热点 | 用 CUDA event 记录 QKV、gate、layout、VSA 和 out projection 分段时间 | <code>H3StudioFastH3Profile</code>，只记录聚合计时，不记录 prompt 或生成内容 | 诊断工具，不是优化；与 layout packer 互斥，避免计时路径改变被误判为加速 |

cuBLAS INT8 与 AdaGEMM INT8 不能同时开启。它们覆盖同一组模型投影；并行叠加不会得到相加收益，反而会使实际 kernel 路径不可解释。

### 4.3 采样与解码

| 技术 | 解决的问题 | 原理 | 当前实现 | 效果与边界 |
| --- | --- | --- | --- | --- |
| Turbo LoRA 8-step | 直接减步造成的结构、纹理和时序退化 | 通过训练得到的低秩增量适配较短去噪轨迹 | <code>LoraLoaderModelOnly</code> 加载匹配 LoRA，强度固定 1.0，服务把 step 固定为 8 | 不是通用跳步；应与 10 step 或更高的 Standard 基线做时序对照 |
| FastH3 4-step LoRA | FastH3 的低步数合同 | 将基础 H3 适配到 VSA 训练时的 4-step Euler 轨迹 | <code>fasth3_vsa_4-steps-v5.safetensors</code>，强度 1.0，simple scheduler + Euler | 适合低延迟预览；不能把其总时延误归因为某一个 kernel |
| VAE Tile Batch | 去噪提速后显现的视频解码尾部 | 将多个独立视频 tile 组成小 batch 解码，提高吞吐 | <code>MiniMaxH3VAEDecodeBatched</code>；Standard 为 batch 2，FastH3 可选 1 / 2 / 4 | 正确实现不改变 latent 或采样轨迹，但显存峰值会上升；应对 RGB 输出和整片时序做检查 |
| Music3 tiled audio decode | 长音频 VAE 解码的峰值压力 | 带 overlap 地分块解码音频 latent | <code>VAEDecodeAudioTiled</code>，tile 512、overlap 64，默认开启 | 主要改善稳定性 / 显存管理，不应当作 H3 视频 DiT 的加速数据 |

### 4.4 不应计入最终推理加速的能力

| 能力 | 用途 | 为什么不纳入性能结论 |
| --- | --- | --- |
| TAEH3 实时预览 | 每步以近似 decoder 展示构图和运动 | 最终视频仍由正式视频 VAE 解码；预览开关可能带来额外工作 |
| RealESRGAN / FlashVSR 超分 | 对已完成视频进行离线增强 | 改变的是输出策略或后处理，不是同一原生分辨率 DiT 的纯推理加速 |
| 首尾帧、多模态参考 | 控制生成内容 | 增加条件输入，不是性能优化节点 |

## 5. 已记录的性能结果

### 5.1 本机 H3 Studio 受控数据

| 试验 | 固定条件 | 结果 | 结论 |
| --- | --- | --- | --- |
| FastH3 VSA + cuBLAS INT8 | 832×480、124 帧、4-step Euler、固定 seed、resident gate、视频与音频均开启 | VSA 基线 63.012 s；两次 cuBLAS 为 54.999 s / 56.431 s；中位数 55.715 s | 相对基线快 11.58%；该组 RGB24、PCM16 checksum 一致 |
| H3 Standard AdaGEMM packing cache | 832×480、124 帧、6 step、<code>res_multistep</code>、Sparge 与 AdaGEMM 开启、固定 seed | packing off 67.233 s；packing on 67.324 s（中位数） | 约慢 0.14%，处于测量波动内；不作为默认优化 |

第一项证明的是特定 GB10、特定软件栈与固定输入下的窄路径等价性。它不等同于所有 prompt、所有模型版本或所有驱动下的无损保证。第二项证明的是缓存层的收益不足，不应延伸为“AdaGEMM 本身无价值”的结论。

### 5.2 外部单机 GB10 对照

[DGX Spark ComfyUI MiniMax H3 benchmark](https://github.com/luqidaxia/dgxspark_comfyui_minimax_h3/blob/main/BENCHMARK.md) 给出了一组相关但不等价的单机 GB10 数据：ComfyUI 0.30.1、INT8 ConvRot H3、20 step、124 帧、<code>res_multistep + simple</code>，使用咖啡蒸汽慢推镜头 prompt。其结果可用于判断量级和测试设计。

| 外部配置 | 分辨率 / 输出 | 端到端时间 | 相对稠密基线 | 可借鉴的结论 |
| --- | --- | ---: | ---: | --- |
| 稠密基线 | 864×480 | 285 s | 1.00× | 用作该项目自己的 20-step 基线 |
| SageAttention + SolAttn + Spectrum + FirstBlockCache | 864×480 | 210 s | 1.36× | 组合注意力优化在该条件下有中等收益 |
| 稠密基线 | 1280×720 | 875 s | 1.00× | 分辨率对 GB10 时延影响显著 |
| 同一 Sol Engine 组合 | 1280×720 | 540 s | 1.62× | 较大分辨率下，注意力优化相对收益更明显 |
| 640×360 生成 + RealESRGAN x2 | 输出 1280×720 | 145 s | 相对原生 720p 为 6.03× | 最大收益来自降低原生生成分辨率，而非单一 kernel |

这组对照必须带着下列限制使用：

1. 外部项目使用的是 SolAttn、Spectrum 和其 FirstBlockCache 实现；它们不是 H3 Studio 当前的 H3SpargeAttention、EasyCache 或 FastH3 VSA。
2. 外部主基准为 20 step、864×480 / 1280×720；本机 FastH3 数据为 4 step、832×480，不能把秒数或倍数直接并排比较。
3. 外部报告中的 FirstBlockCache 阈值 0.08 在该组 20-step 运行里为 0 次命中。这支持本机采用“先记录命中率，再评价缓存收益”的原则，也说明阈值不应只凭名称判断。
4. “低分辨率生成 + 超分”会改变原生生成分辨率、画面细节和后处理链。它适合产品策略比较，不是稀疏注意力或 GEMM 的单变量 A/B。

## 6. 实施与验证规范

### 6.1 能力探测与防错

前端开关不是直接假设可用。服务启动时会查询 ComfyUI 的 <code>/system_stats</code> 和 <code>/object_info</code>，确认 H3VSA、匹配 gate、LoRA、INT8 node、batched VAE node 等能力。提交任务前会再检查一次；缺失可选 node 时只禁用对应开关，不把工作流伪装成“已优化”。

FastH3 请求会在后端归一为固定 4-step Euler；Turbo 请求归一为固定 8 step；cuBLAS 与 AdaGEMM 冲突会被拒绝。这样可避免界面参数和实际执行图不一致。

### 6.2 A/B 的最小条件

每个 A/B 只改变一个变量，并固定下列字段：

~~~text
service、prompt、width、height、actualFrames、steps、sampler、
seed、参考素材、VAE batch、其他所有优化开关
~~~

建议流程：

1. 服务重启后先丢弃一条 warm-up，尤其是 FastH3 resident gate；
2. A / B 交替运行至少 5 次，例如 A-B-B-A-A-B；
3. 记录端到端时间、采样时间、视频解码时间、峰值显存与 cache hit；
4. 报告 p50 和 p95，不使用单次最快值；
5. 将队列等待、模型下载、冷启动和文件上传从执行时间中剥离。

### 6.3 质量验证分级

| 技术类别 | 首选验证 | 通过标准 |
| --- | --- | --- |
| cuBLAS INT8、已声明等价的布局 / 解码调度 | 解码后 raw RGB24 与 PCM16 checksum | 同一条件下完全一致；MP4 文件 hash 可受封装元数据影响 |
| Fused Modulation、VAE Tile Batch | 同 seed 数值 / 像素误差 + 整片检查 | 误差处于可接受范围，且无新增闪烁或音画问题 |
| Sparge、VSA、缓存、低步数 LoRA | 全片审查、闪烁、光流 warp error、tLPIPS、镜头连续性 | 不要求 hash 一致，但必须满足业务质量门槛 |

咖啡蒸汽、细颗粒、景深变化和慢推镜头是时序敏感内容。单帧清晰不代表视频稳定；应重点看蒸汽是否断续、背景虚化是否跳变、镜头推进是否抖动。

## 7. 推荐使用方式

| 目标 | 建议起点 | 说明 |
| --- | --- | --- |
| 质量基线 / 问题定位 | H3 Standard 稠密后端，关闭缓存与 Sparge | 用于建立参考，不以最快时间为目标 |
| 常规质量与温和加速 | Standard + Sparge Balanced；若仍需加速，再试 FirstBlockCache Safe | 先避免 EasyCache，逐项判断时序稳定性 |
| 低步数预览 | Turbo LoRA 8-step 或 FastH3 VSA | 两者属于不同采样合同，应分别与各自基线比较 |
| FastH3 低延迟 A/B | VSA resident baseline → 单独开启 cuBLAS INT8 → 固定 VAE batch | 当前唯一已有严格输出校验的 FastH3 增益是 cuBLAS 试验 |
| 视频解码尾部优化 | 固定 DiT 配置，仅切换 VAE Tile Batch | 同时记录解码时间、峰值显存和视频输出 |
| 高分辨率交付 | 将低原生分辨率 + 超分作为产品路径单独评估 | 不将其与同原生分辨率的 kernel 优化合并为一个倍数 |

## 8. 参考资料

- [H3 Studio 推理优化技术说明](h3-inference-optimization-guide.md)：节点顺序、参数、回退逻辑和 FastH3 VSA 实现细节。
- [H3 AdaGEMM Phase 0–2 实测报告](perf/2026-09-03-h3-adagemm-phase0-2-report.md)：矩阵形状、微基准与 packing cache A/B。
- [现有优化开关与使用建议](optimization-guide.md)：前端功能与质量回退顺序。
- [DGX Spark ComfyUI MiniMax H3 Benchmark](https://github.com/luqidaxia/dgxspark_comfyui_minimax_h3/blob/main/BENCHMARK.md)：外部单机 GB10 对照数据。
