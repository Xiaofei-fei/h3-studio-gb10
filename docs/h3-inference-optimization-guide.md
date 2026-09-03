# H3 Studio 推理优化技术说明

> 适用范围：当前 H3 Studio 本机服务及其连接的 GB10 ComfyUI 环境。
> 更新日期：2026-09-03。
> 本文以当前 workflow 与已部署自定义节点的实现为准；论文或社区指标不直接等同于本服务的实测结论。

## 1. 总览

当前服务包含两条相互独立的推理路径。

| 路径 | 目标 | 核心优化 | 适用场景 |
| --- | --- | --- | --- |
| **H3 Standard** | 在常规 H3 采样下按需折中速度与质量 | SpargeAttention、跨步缓存、调制融合、Turbo LoRA、VAE 批量解码 | 需要 6–25 步、希望逐项 A/B，或优先保持常规 H3 行为 |
| **FastH3 VSA** | 使用专门训练的低步数路径降低端到端时延 | 4-step LoRA、VSA 稀疏注意力、常驻 gate、可选 Fused Modulation / GB10 INT8、VAE Tile Batch 1/2/4 | 接受固定 4-step Euler 合同，追求预览或低延迟生成 |

两条路径不能把所有开关简单叠加。FastH3 的 LoRA、gate 和 VSA 稀疏率是在固定 4-step Euler 下配套工作的。进入 FastH3 后，服务会自动关闭 Standard 的 SpargeAttention、FirstBlockCache、EasyCache、Fused Modulation 与 Standard VAE Tile Batch。

这样做的目的不是限制功能，而是避免把两套近似策略叠加后出现三个问题：质量无法归因、性能无法归因、同一 seed 的复现实验失去意义。

## 2. 推理链路与时间构成

一次视频生成主要分为：条件准备、DiT 去噪、视频 VAE 解码、音频 VAE 解码和 MP4 封装。

~~~mermaid
flowchart LR
    A[提示词、分辨率、时长、Seed] --> B[文本编码与视频条件]
    B --> C[DiT 去噪采样]
    C --> D[视频 VAE 解码]
    C --> E[音频 VAE 解码]
    D --> F[封装 MP4]
    E --> F
~~~

去噪通常是最长阶段。其中注意力、QKV/输出投影和 MLP 的矩阵乘是主要热点。视频较长、分辨率较高，或去噪被显著加速后，视频 VAE 解码会成为新的尾部瓶颈。

| 瓶颈 | 当前技术 |
| --- | --- |
| 视频注意力的计算和访存 | SpargeAttention、FastH3 VSA |
| 相邻去噪步的重复计算 | FirstBlockCache、EasyCache |
| 条件调制小算子的 launch / 中间张量开销 | Fused Modulation |
| 达到可用结果所需的去噪步数 | Turbo LoRA 8-step、FastH3 4-step LoRA |
| H3 ConvRot INT8 投影的后端分派 | GB10 cuBLAS INT8 |
| 视频 VAE 解码的 tile 调度 | VAE Tile Batch |

### 2.1 帧数对齐

服务以 24 FPS 生成，但不会直接使用 <code>秒数 × 24</code> 的帧数。为满足 H3 时间维网格，后端按下式对齐：

~~~text
rawFrames = max(5, round(seconds × 24))
length = rawFrames + ((5 - rawFrames mod 17) mod 17)
~~~

例如，5 秒的请求先得到 120 帧，再对齐为 **124 帧**，实际视频约为 5.17 秒。性能对比必须保持 <code>actualFrames</code> 一致；只保持“5 秒”文字一致并不充分。

### 2.2 固定的基础模型格式

下列文件不是网页开关，但本身就是当前服务性能条件的一部分。

| 组件 | 当前文件 | 作用与边界 |
| --- | --- | --- |
| DiT / UNet | <code>minimax_h3_fl2va_pruned_int8_convrot.safetensors</code> | 使用已裁剪、量化的 ConvRot INT8 H3 权重，降低权重带宽与低精度 GEMM 成本；两条路径共用。 |
| 文本编码器 | <code>qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors</code> | NVFP4/AWQ 主要降低文本编码侧的显存与读取开销；不代表整个 DiT 都是 NVFP4。 |
| 视频 VAE | <code>minimax_h3_video_vae_fp16.safetensors</code> | FP16，兼顾显存与视频重建质量。 |
| 音频 VAE | <code>minimax_h3_audio_vae_fp32.safetensors</code> | FP32；当前没有对音频路径做近似量化。 |

## 3. 实际 workflow

### 3.1 H3 Standard

~~~text
INT8 ConvRot H3
  → [可选] Turbo LoRA 8-step
  → [二选一，可选] FirstBlockCache / EasyCache
  → [可选] Fused Modulation
  → [可选] H3SpargeAttention
  → Scheduler + Guider + SamplerCustomAdvanced
  → [可选] MiniMaxH3VAEDecodeBatched（batch 2）
  → 视频 / 音频封装
~~~

关闭 SpargeAttention 时，workflow 回到配置的稠密注意力后端。服务传入 <code>dense_backend: 'inherit'</code>，因此 H3 Studio 本身不强制替换稠密内核；当前界面将该路径展示为 Sage / Dense。换句话说，Sage 是 GB10 ComfyUI 的后端配置，不是 H3 Studio 额外插入的节点。

### 3.2 FastH3 VSA

~~~text
INT8 ConvRot H3
  → FastH3 VSA 4-step LoRA（强度 1.0）
  → H3VSA（topk=0.10，gate resident）
  → [可选] MiniMaxH3FusedModulation
  → [可选] MiniMaxH3GB10CublasInt8 或 MiniMaxH3GB10AdaGemmInt8
  → 固定 simple scheduler + 4-step Euler
  → [可选] MiniMaxH3VAEDecodeBatched（batch 1 / 2 / 4）
  → 视频 / 音频封装
~~~

FastH3 中，Scheduler 与 Guider 始终接收同一个最终 model link：未开启补丁时是 H3VSA 输出；开启调制融合、cuBLAS 或 AdaGEMM 时，按 workflow 串联后的最后一个补丁输出继续向下传递。这样 sigma、条件引导和实际执行的模型不会脱节。

## 4. H3 Standard 的优化技术

H3 Studio 可直接确认每个节点的顺序、参数和互斥关系。部分 Standard 自定义节点的 kernel 源码不随本仓库托管，因此本文会明确区分“workflow 层已验证行为”和“这类算法的一般原理”，不把未检查的远端实现细节写成事实。

### 4.1 SpargeAttention：块级稀疏注意力

**解决的问题**：稠密注意力需要为大量 token 对计算相似度和加权和值。视频时空 token 多，长序列时注意力的计算和显存访问会迅速放大。

**原理**：把 token 按块组织，先以路由分数 / 相似度选出每个查询块最有价值的键值块，再只计算被选中的块对。

~~~text
稠密：A = softmax(QKᵀ / √d)V
稀疏：Aᵢ = softmax(Qᵢ K_S(i)ᵀ / √d)V_S(i)
~~~

其中 <code>S(i)</code> 是第 <code>i</code> 个查询块保留的键值块集合。选择越少，潜在加速越高；遗漏重要远距离关系的风险也越大。

**当前 workflow 参数**：

| 参数 | Balanced | Fast | 说明 |
| --- | ---: | ---: | --- |
| <code>routing_mode</code> | topk | topk | 使用 top-k 路由选择 |
| <code>routing_value</code> | 0.15 | 0.10 | 通用路由强度参数；Fast 使用更激进的节点配置 |
| <code>video_routing_value</code> | 0.12 | 0.08 | 视频 token 的独立路由参数 |
| <code>similarity_threshold</code> | 0.10 | 0.10 | 相似度门槛 |
| <code>block_size</code> | 64 | 64 | 块级选择的粒度 |
| <code>min_seq_len</code> | 8192 | 8192 | 短序列不值得走稀疏路径 |
| <code>dense_last_steps</code> | 1 | 1 | 最后一个去噪步保持稠密，保护收敛末期细节 |
| <code>protect_audio</code> | true | true | 避免音频条件被一并稀疏化 |
| <code>kernel_impl</code> / <code>selector_impl</code> | branch_map / topk_fast | 相同 | 分支映射 kernel 与快速 top-k 选择器 |

**实现方式**：服务把 <code>H3SpargeAttention</code> 放在模型补丁链末端。开启时，Scheduler 和 Guider 同时使用该节点返回的模型；关闭时，二者都连接到上一个补丁或基础模型。节点设置 <code>dense_backend: inherit</code>，使不适用稀疏分支时回退到当前部署的稠密后端。

**质量边界**：这是近似计算，不应宣称逐像素无损。蒸汽、细小水汽、缓慢推镜等依赖弱而连续的时空关联，过强稀疏化可能表现为闪烁、局部漂移或镜头运动断续。建议先用 Balanced；比较时看完整视频，不只看首帧。<code>dense_last_steps: 1</code> 是当前保留的稳定性安全阀。

### 4.2 FirstBlockCache：首块跨步特征复用

**解决的问题**：扩散采样相邻步的输入常常平滑变化。首个 DiT block 的中间特征可能相近，每一步重算会重复消耗计算。

**原理**：缓存第一个 block 的中间结果；若当前状态与缓存状态的差异低于阈值，且未连续命中过多次，就复用缓存。

~~~text
if distance(h_t, h_cached) < threshold and hits < max_hits:
    use h_cached
else:
    h_cached = Block0(h_t)
~~~

它只跳过首块的部分计算，不是跳过整个 DiT，因此一般比整步复用保守。

**当前配置**：

| 档位 | threshold | 生效区间 | 最大连续命中 |
| --- | ---: | --- | ---: |
| Safe | 0.08 | 采样 10%–95% | 2 |
| Fast | 0.10 | 采样 10%–95% | 2 |
| Aggressive | 0.12 | 采样 10%–95% | 2 |

服务还传入 <code>temporal_guard: false</code>。因此“Safe”仅表示阈值和连续命中次数更保守，不代表额外时序保护已启用，更不代表绝对无损。

**实现方式**：<code>ApplyMiniMaxH3FirstBlockCache</code> 放在 Turbo LoRA 之后、Fused Modulation 之前。因此缓存看到的是已加载 Turbo LoRA 的模型行为，不会在基础权重与 LoRA 权重之间混用特征。

**使用建议**：适合不想减少采样步数、但希望温和减少重复计算的 Standard 路径。对时序特别敏感的内容先用 Safe；<code>max_consecutive_hits=2</code> 用于限制误差连续累积。

### 4.3 EasyCache：整步级跨步复用

**解决的问题**：相邻步的重复并不只存在于第一块。如果能复用更大范围的去噪结果，速度潜力更大。

**原理**：EasyCache 按阈值判断当前采样步是否可复用之前的去噪结果或中间状态。相比 FirstBlockCache，它覆盖的计算更广，因而潜在收益更大，也更容易把误差带入后续步。

**当前配置**：

~~~text
reuse_threshold = 0.20
start_percent  = 0.15
end_percent    = 0.95
~~~

**实现方式与互斥**：H3 Studio 将 <code>EasyCache</code> 作为 model patch 插入 Turbo LoRA 之后；它仍可与 Fused Modulation、SpargeAttention 串联。但它与 FirstBlockCache 互斥，后端会拒绝二者同时开启，因为两套跨步复用同时控制同一去噪路径时，命中顺序与误差来源无法清晰界定。

**使用建议**：更适合极速预览与构图探索，不适合作为“严格质量基线”。如果蒸汽出现断续、背景虚化跳变或镜头抖动，应先关闭 EasyCache，再用 FirstBlockCache Safe 或纯稠密路径对照。

### 4.4 Fused Modulation：合并条件调制小算子

**解决的问题**：DiT block 的条件调制通常包含 scale、shift、gate 等逐元素操作。算术量不大，但多次 kernel launch 和中间张量读写会累积。

**原理**：将相邻调制操作合并为一个执行单元，减少中间张量和调度边界。典型结构可以抽象为：

~~~text
y   = norm(x)
y   = y × (1 + scale(c)) + shift(c)
out = gate(c) × f(y) + residual
~~~

融合路径的目标是保持数学语义，同时减少读写与 launch。

**实现方式**：服务将 <code>MiniMaxH3FusedModulation(model, enabled=true)</code> 放在缓存节点之后、SpargeAttention 之前。该节点的图级行为、输入和顺序已经确认；它的底层实现没有随 H3 Studio 仓库托管，所以不能仅凭节点名断言它使用 Triton、CUDA C++ 或 <code>torch.compile</code> 的哪一种方式。

**质量边界**：它的目标接近等价重排，理论上比缓存和稀疏注意力更容易保持质量；但混合精度仍需以同 seed 的数值与成片检查为准。其收益取决于分辨率、batch 与其他瓶颈，不能与其他优化的百分比直接相加。

### 4.5 Turbo LoRA 8-step：面向低步数的蒸馏适配

**解决的问题**：普通 H3 直接减少到 8 步，常会损失结构、纹理或时序。Turbo LoRA 用训练得到的低秩增量把模型适配到较短的采样轨迹。

**原理**：它不是运行时通用“跳过若干步”，而是让低步数轨迹近似较长去噪轨迹的蒸馏 / 适配产物。必须配合训练时匹配的权重、步数与采样合同使用。

**当前配置**：

~~~text
LoRA:       minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
加载节点：  LoraLoaderModelOnly
强度：       1.0
服务步数：   固定归一为 8
~~~

**实现方式**：先加载基础 UNet，再经 <code>LoraLoaderModelOnly</code> 得到新的 model link。缓存、融合和稀疏注意力都以该 link 为输入。开关开启时，后端强制将步数归一为 8，避免“界面写 6 步、实际上带 8-step LoRA”的不可复现实验。

**质量边界**：相较未适配的直接减步，Turbo LoRA 通常更稳定；但它仍属于低步数路线。最终交付前应与 10 步或更高的 Standard 路径在同 prompt、seed、分辨率下比较时序稳定性。

### 4.6 VAE Tile Batch：批量视频解码

**解决的问题**：视频 VAE 可能逐个处理 tile / 时间片，导致 GPU 利用率低、kernel launch 多。去噪加速后，解码时间在端到端占比中会上升。

**原理**：把多个独立 tile 作为一个小 batch 解码，让卷积和张量计算具有更高吞吐。它不改变 latent 或采样轨迹，改变的是解码调度方式。

| 路径 | 节点 | tile_batch_size |
| --- | --- | ---: |
| H3 Standard | <code>MiniMaxH3VAEDecodeBatched</code> | 2 |
| FastH3 VSA | <code>MiniMaxH3VAEDecodeBatched</code> | 1、2 或 4（界面可选） |

关闭时走普通 <code>VAEDecode</code>。音频仍由 <code>VAEDecodeAudio</code> 处理。

**质量边界**：正确实现时应保持解码语义，但更大 batch 会提高显存峰值。启用后应检查全片，而不是只看前几帧；若 OOM 或远端节点版本不兼容，回退到普通解码。

## 5. FastH3 VSA 的专用优化链

FastH3 不是“Standard H3 再叠更多开关”，而是一套匹配的低步数与稀疏注意力路径。

### 5.1 4-step LoRA 与固定 Euler

当前服务固定使用：

~~~text
LoRA:       fasth3_vsa_4-steps-v5.safetensors
strength:   1.0
scheduler:  simple
steps:      4
sampler:    euler
~~~

该 LoRA 用于把基础 H3 适配到 VSA 训练时的低步数轨迹。服务不会让 FastH3 继承 Standard 的 6 / 10 / 15 / 20 / 25 步或采样器选择。

因此，FastH3 与 Standard 的比较可以用于产品体验比较，却不能直接归因成“某个内核带来的加速”。两条路径同时改变了 LoRA、采样步数和注意力算法。

### 5.2 H3VSA：带训练 gate 的视频稀疏注意力

**解决的问题**：视频注意力是 FastH3 路径的主要热点之一。很多时空块的直接互相访问并非每次都必要。

**当前代码实际做了什么**：

1. 从 <code>fasth3_vsa_gate.safetensors</code> 读取各 H3 block 的 <code>to_gate_compress.weight</code>。
2. 向每个 attention module 注入无 bias 线性层 <code>Wg</code>，形状为 <code>[inner, hidden]</code>。
3. 保留原有 <code>qkv_proj</code>、RMSNorm 与 RoPE，不重写 Q/K 的规范化和位置编码。
4. 计算 gate：<code>g = x Wgᵀ</code>，将 <code>q/k/v/g</code> 重排成 <code>[B, H, S, D]</code>。
5. 序列按 64 token 补齐，令 <code>n_blocks = ceil(S / 64)</code>，再计算：

   ~~~text
   topk = max(1, ceil(n_blocks × topk_ratio))
   ~~~

6. 以 <code>topk_ratio = 0.10</code> 调用 <code>vsa.video_sparse_attn(...)</code>，并把 gate 作为 <code>compress_attn_weight</code> 传入。传给 kernel 的空间块形状为 <code>(4, 4, 4)</code>，其乘积正好是前述 64 token 选择粒度；末块的真实长度通过 <code>variable_block_sizes</code> 保留。
7. 去掉 padding，再通过原有 <code>attn.out_proj</code> 输出。

可把注意力阶段概括为：

~~~text
q, k, v = qkv_proj(x)
q, k    = RMSNorm + RoPE(q, k)
g       = Wg(x)
blocks  = GateTopK(g, ratio=0.10)
out     = SparseAttention(q, k, v, blocks)
return out_proj(out)
~~~

VSA kernel 来自 FastVideo 的 <code>video_sparse_attn</code>；H3VSA 节点负责 H3 张量布局、gate 权重与该 kernel 的衔接。

**回退逻辑**：当 VSA kernel 不可用、序列短于 <code>min_tokens=4096</code>、输入不是 CUDA BF16、某 block 缺 gate 或形状不符合要求时，节点回到原始稠密 attention forward。它不会在前提不满足的输入上硬走稀疏 kernel。

**为何需要训练 gate**：这里不是推理时凭启发式随机丢 token。各 block 的 gate 与 FastH3 LoRA 是配套产物，用于让块选择贴近训练分布。它仍为近似注意力，但比未训练路由更有机会保持结构与时序。

### 5.3 Gate residency：以显存换传输开销

H3VSA 的 gate 起初保留在 CPU 侧，节点会尽量使用 pinned memory。

| 模式 | 行为 | 优点 | 代价 |
| --- | --- | --- | --- |
| <code>stream</code> | 每次 attention 调用时把 gate 传到 GPU | 最低显存占用 | 相同 gate 在多个去噪步内重复传输 |
| <code>resident</code> | 首次使用后保存私有 CUDA tensor | 后续去噪步直接复用 BF16 gate | 约额外占用 3.6 GB 显存 |

当前 FastH3 workflow 固定使用 <code>resident</code>，适合 GB10 这类高显存设备。实现上，常驻 gate 是推理缓存，并不是新注册的可训练模型参数。首次真正进入 VSA 的 CUDA 前向时，节点还会清理上一次被取消任务遗留的碎片显存，以降低稀疏 kernel 分配 OOM 的概率；这可能影响首条任务的计时。服务重启后的首次任务仍存在加载 / warm-up 成本，严格 A/B 不应把冷启动和热态混在同一组统计中。

### 5.4 GB10 cuBLAS INT8 热路径补丁

**解决的问题**：VSA 稀疏化后，剩余的 QKV、attention output projection 和 MLP INT8 线性层在占比中更突出。该优化不是重新量化模型，而是让现有 ConvRot INT8 GEMM 在 GB10 上走更合适的后端分派。

**精确作用范围**：<code>MiniMaxH3GB10CublasInt8</code> 为每个 H3 block 包装：

~~~text
attn.qkv_proj.forward
attn.out_proj.forward
mlp.forward
~~~

它不修改 RMSNorm、RoPE、VSA 路由、LoRA、scheduler、采样步数、VAE 或其他非热点投影。

**具体实现**：

1. 节点检查 CUDA 设备名中含 GB10、模型为 <code>MiniMaxH3Model</code>、VSA gate 为 <code>resident</code>，并检查 ComfyKitchen CUDA 后端提供必要状态。任一前提不满足时返回未修改的模型。
2. 每个热点 forward 由闭包包装：保存原始 <code>cuda_backend._DISABLE_CUTLASS_INT8</code>，在这次调用内切换到 cuBLASLt INT8 分派所需状态，然后在 <code>finally</code> 中恢复。
3. 后端对已有 ConvRot INT8 GEMM 使用 cuBLASLt INT8 执行和精确反量化；节点不进行第二次权重量化。
4. 节点在采样前同步预热 resident VSA gate，以免首次 gate 传输落在采样计时里。

<code>try/finally</code> 很重要：它避免全局 CUDA 后端状态泄漏到 workflow 的无关节点。

**为何强制 <code>force_full_load=false</code>**：历史试验中，全模型预加载改变了动态加载栈首轮的输出轨迹，也没有带来可靠端到端收益。当前节点保留该输入仅为了兼容旧 workflow；即使传入 true，它只会记录告警并继续使用 resident-gate 预热，不执行全预加载。

**已记录的受控结果**：

~~~text
模型：MiniMax H3 FastH3 VSA
分辨率：832 × 480
帧数：124
采样：4-step Euler
seed：2026090201
状态：resident VSA gate，视频与音频均开启
~~~

| 路径 | 端到端耗时 | 输出校验 |
| --- | ---: | --- |
| Resident VSA 基线 | 63.012 s | RGB / PCM 参考值 |
| cuBLAS INT8 A | 54.999 s | 与参考完全一致 |
| cuBLAS INT8 B | 56.431 s | 与参考完全一致 |
| cuBLAS INT8 中位数 | 55.715 s | **相对基线快 11.58%** |

在该固定配置中，RGB24 与 PCM16 checksum 均一致。它证明该窄路径未改变该测试的原始视频 / 音频输出；**不等于**对任意 prompt、任意驱动或未来版本的无损保证。升级 PyTorch、ComfyUI、驱动、权重或 CUDA kernel 后应重新做校验。

### 5.5 FastH3 VAE Tile Batch 4

FastH3 的解码优化与 Standard 相同，但把 tile batch 从 2 提升到 4。FastH3 的去噪步数更短，VAE 解码更可能成为端到端尾部；GB10 有足够显存时，batch 4 有机会进一步缩短解码。

它与 cuBLAS INT8 独立。测试 cuBLAS 的单独收益时，基线与优化组必须保持 VAE Tile Batch 状态相同；前端的历史对比正是按此条件筛选。

## 6. 依赖、互斥与安全设计

~~~mermaid
flowchart TD
    A[H3 Standard] --> B[Turbo LoRA 8-step]
    B --> C{跨步缓存}
    C -->|首块复用| D[FirstBlockCache]
    C -->|整步复用| E[EasyCache]
    D --> F[Fused Modulation]
    E --> F
    F --> G[SpargeAttention]

    H[FastH3 VSA] --> I[4-step VSA LoRA]
    I --> J[H3VSA + resident gate]
    J --> K{可选}
    K --> L[GB10 cuBLAS INT8]
    K --> M[VAE Tile Batch 4]
~~~

| 规则 | 原因 |
| --- | --- |
| FirstBlockCache 与 EasyCache 互斥 | 都是跨步复用策略，同时控制同一去噪路径会使命中顺序和误差来源不清晰。 |
| FastH3 关闭 Standard cache / Sparge / Fused / batch 2 | FastH3 LoRA + gate + VSA 已是训练配套路线，继续叠加稀疏或跨步近似会破坏训练假设。 |
| cuBLAS INT8 依赖 resident gate | 节点需要稳定的 GB10 热态，并在采样前预热 gate；不满足时宁可不补丁。 |
| FastH3 的 cuBLAS 是直接开关 | 固定 VSA 图不再有档位覆盖逻辑，开关状态就是唯一的 cuBLAS 执行变量，便于单变量 A/B。 |
| VAE batch 必须在 A/B 中保持一致 | 它会改变端到端耗时，但不属于 cuBLAS 的采样热路径。 |

## 7. 服务如何保证开关真的生效

1. <code>/api/health</code> 读取 GB10 ComfyUI 的 <code>/system_stats</code>，并查询 <code>/object_info</code>。
2. FastH3 必需条件是：存在 <code>H3VSA</code> 节点、其 <code>gate_file</code> 列表含 <code>fasth3_vsa_gate.safetensors</code>，且 <code>LoraLoaderModelOnly</code> 的 <code>lora_name</code> 列表含 <code>fasth3_vsa_4-steps-v5.safetensors</code>。
3. <code>MiniMaxH3GB10CublasInt8</code> 和 <code>MiniMaxH3VAEDecodeBatched</code> 单独探测。FastH3 核心可用但某个可选节点缺失时，只禁用对应开关。
4. <code>POST /api/jobs</code> 在进入 ComfyUI 队列前再次做 capability 检查。
5. 请求规范化阶段固定 FastH3 为 4-step Euler，并清空不兼容的 Standard 优化字段。

这样可避免“网页显示开关已打开、远端节点其实不存在、实际退回默认路径”的假阳性。

## 8. 可重复的 A/B 方法

### 8.1 单变量原则

比较 cuBLAS INT8 时，以下字段必须一致：

~~~text
service、prompt、width、height、seconds、actualFrames、
steps、sampler、seed、VAE Tile Batch 开关
~~~

前端只在两条 FastH3 历史记录满足上述条件、且仅 <code>fastH3CublasInt8</code> 不同时显示耗时差。它不会把 Standard 与 FastH3 当作“内核 A/B”，因为两条路径同时改变了 LoRA、步骤与注意力算法。

### 8.2 推荐流程

1. 服务重启后先丢弃一条 FastH3 resident-gate warm-up。
2. 固定 prompt、分辨率、时长、seed 和所有无关开关。
3. 至少做 5 组交替运行，例如 A-B-B-A-A-B；A 为关 cuBLAS，B 为开 cuBLAS。这样可降低温度、权重缓存与系统抖动的影响。
4. 分别记录端到端 <code>totalElapsedMs</code>、采样阶段时间和解码阶段时间，报告 p50、p95，不只选最快一次。
5. 若目标是严格无损，导出视频解码后的 raw RGB24 与音频 PCM16 计算 checksum。MP4 文件 hash 可能受封装元数据影响。
6. 比较稀疏注意力或缓存时，应检查整段视频的蒸汽连续性、慢推镜头、背景虚化稳定性、闪烁与音画同步，不只比较单帧。

### 8.3 质量检查分级

| 等级 | 方法 | 适用技术 |
| --- | --- | --- |
| 位级一致 | raw RGB / PCM checksum 完全相同 | GB10 cuBLAS INT8 这类等价后端替换 |
| 数值近似 | latent / 像素误差、PSNR | 可能等价但有混合精度差异的融合或 VAE 批处理 |
| 感知与时序 | 全片审查、tLPIPS、光流 warp error、闪烁指标 | Sparge、VSA、缓存、低步数 LoRA |

不要把稀疏注意力或跨步缓存强行要求为“与稠密基线 hash 一致”；它们本身以受控近似换速度。相反，cuBLAS 这类后端替换应优先要求严格数值或位级校验。

## 9. 参数速查

| 技术 | 当前参数 | 主要风险 |
| --- | --- | --- |
| Standard 稠密后端 | <code>dense_backend: inherit</code> | 吞吐最低，但适合作为质量参考 |
| Sparge Balanced | topk，0.15 / 视频 0.12，64-token block，末步稠密 | 近似注意力导致时序不稳 |
| Sparge Fast | topk，0.10 / 视频 0.08 | 更激进，必须看完整视频 |
| FirstBlockCache | 阈值 0.08 / 0.10 / 0.12，最多连续命中 2 | 跨步复用误差 |
| EasyCache | 阈值 0.20，15%–95% | 更易影响连续性 |
| Fused Modulation | enabled=true | 依赖远端自定义节点版本 |
| Turbo LoRA | 强度 1.0，固定 8 step | 低步数细节与时序波动 |
| Standard VAE batch | batch 2 | 显存峰值、节点兼容性 |
| FastH3 VSA | LoRA 1.0，topk 0.10，min_tokens 4096，resident | 稀疏近似，额外约 3.6 GB 显存 |
| GB10 cuBLAS INT8 | qkv_out_mlp，force_full_load=false | 仅当前 GB10 后端组合支持 |
| FastH3 VAE batch | batch 1 / 2 / 4 | batch 越大，显存峰值越高；需按端到端时间和 OOM 风险选择 |

## 10. 代码映射

| 位置 | 职责 |
| --- | --- |
| <code>server/workflow.ts</code> | 请求规范化、帧数对齐、Standard / FastH3 workflow 组装和参数常量。 |
| <code>server/types.ts</code> | 服务类型、优化开关与任务快照数据契约。 |
| <code>server/comfy-client.ts</code> | <code>/object_info</code> capability 探测，检查 VSA gate、LoRA 和可选节点。 |
| <code>server/app.ts</code> | FastH3 提交前安全检查、任务状态和端到端计时。 |
| <code>src/components/GenerationControls.tsx</code> | 服务选择及标准 / FastH3 开关的界面。 |
| <code>src/optimization.ts</code> | 任务摘要与“仅 cuBLAS 不同”的可比性筛选。 |
| <code>fasth3_vsa_gate_resident_20260902/node/nodes.py</code> | H3VSA gate 注入、64-token padding、top-k VSA 调用、stream/resident。 |
| <code>h3_hotpath_profile/nodes.py</code> | GB10 cuBLAS INT8 热路径包装、gate 预热、全预加载质量保护。 |
| <code>h3_hotpath_profile/RESULTS.md</code> | 固定 832×480 / 124 帧 / 4-step 的 checksum 与性能记录。 |

最后三项是本部署所用自定义节点的开发 / 验证源。H3 Studio 不把节点代码复制进前端或服务端，而是通过 ComfyUI 节点名与 <code>object_info</code> 对接。

## 11. 典型配置

### Standard：质量参考

~~~json
{
  "service": "h3_standard",
  "prompt": "一杯咖啡的热气缓缓升起，镜头缓慢推近，背景虚化",
  "width": 832,
  "height": 480,
  "seconds": 5,
  "steps": 10,
  "samplerName": "res_multistep",
  "seed": 2026090201,
  "spargeAttention": false,
  "featureCacheSafe": false,
  "easyCache": false,
  "fusedModulation": false,
  "vaeTileBatch": false
}
~~~

这是适合质量基线的稠密路径。之后一次只打开一项：先 Fused Modulation，再 Sparge Balanced，最后才试缓存。

### FastH3：只比较 GB10 cuBLAS

~~~json
{
  "service": "fasth3_vsa",
  "prompt": "一杯咖啡的热气缓缓升起，镜头缓慢推近，背景虚化",
  "width": 832,
  "height": 480,
  "seconds": 5,
  "steps": 10,
  "samplerName": "res_multistep",
  "seed": 2026090201,
  "fastH3CublasInt8": false,
  "fastH3VaeTileBatch": false
}
~~~

即使请求写了 10 步与 res_multistep，FastH3 也会归一为 **4-step Euler**。要做 cuBLAS A/B，只需在完全相同的其余条件下将 <code>fastH3CublasInt8</code> 从 false 切换为 true；<code>fastH3VaeTileBatch</code> 必须保持不变。

## 12. 选择建议与边界

| 目标 | 建议 |
| --- | --- |
| 做质量参考、排查抖动来源 | Standard 稠密路径，关闭缓存与稀疏注意力。 |
| 需要保守加速且不减步 | 先试 Fused Modulation，再试 FirstBlockCache Safe；每次只加一个变量。 |
| 需要快速预览 | Turbo 8-step 或 FastH3 VSA；二者是不同模型合同，不要混作内核 A/B。 |
| FastH3 内继续降低延迟 | 保持 VSA resident；先单独验证 Fused Modulation、cuBLAS INT8 或 AdaGEMM，再比较 VAE Tile Batch 1 / 2 / 4。 |
| 需要严格无损 | 优先 cuBLAS INT8 / 可能的等价 VAE 批处理，并用 raw RGB/PCM checksum 验证；不要依赖稀疏或跨步缓存。 |

当前服务已把可控的服务级优化暴露为开关，但不意味着每一种组合都必然更快。注意力被加速后，解码、文本编码、IO 或模型加载可能成为新瓶颈；显存接近上限时，更大的 VAE batch 也可能变慢或 OOM。最终结论必须来自同配置、同热态、重复运行的端到端数据。
