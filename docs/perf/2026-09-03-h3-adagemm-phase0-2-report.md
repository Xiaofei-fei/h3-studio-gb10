# H3 AdaGEMM Phase 0–2 实测报告

日期：2026-09-03
平台：GB10（Blackwell），ComfyUI + H3 Standard，AdaGEMM per-channel INT8

## 结论

本轮已把 H3 在实际生成时的 AdaGEMM INT8 矩阵形状追踪到位，并验证了 AdaGEMM 的 GB10 内核库已覆盖这些运行时形状。针对重复权重/scale 整理新增的可选缓存不改变输出，但端到端收益低于测量波动，不能作为默认优化项。

保留：默认关闭的追踪、形状工具、隔离的 tuner 兼容性修复，以及默认关闭的 packing 实验开关。
不默认启用：`packing_mode=on`。
下一步门槛：只有剖析证明 ConvRot、量化或布局转换占据足够比例时，才进入 ConvRot + quant + GEMM 融合内核阶段。

## 固定测试条件

| 项目 | 值 |
| --- | --- |
| 模型 | H3 Standard，INT8 ConvRot checkpoint |
| 分辨率 / 时长 | 832×480 / 5 秒（124 帧） |
| 采样 | 6 steps，`res_multistep` |
| 随机性 | 固定 seed `20260903`；每次请求加入独立 nonce 防止采样结果缓存复用 |
| 加速组合 | SpargeAttention 保持开启；AdaGEMM INT8 开启；cuBLASLt INT8 关闭 |
| 计时口径 | ComfyUI `execution_start` 至 `execution_success`，静态加载节点命中缓存 |

每次提交前均确认 ComfyUI 队列为空；未在有运行或待运行任务时启动 tuner、微基准或重启服务。

## 真实形状追踪

一次固定工作流（6 steps）产生 900 条 AdaGEMM 路由记录，另有 300 条预期的 fused-SwiGLU `input_act` 回退记录；没有 RuntimeError 回退。50 个 block 的三类投影均重复出现：

| 投影 | 实测 M | N | K | 调用次数 |
| --- | ---: | ---: | ---: | ---: |
| FC1 | 14,880 | 28,672 | 5,376 | 300 |
| QKV | 14,880 | 21,504 | 5,376 | 300 |
| Attention output | 14,880 | 5,376 | 7,168 | 300 |

AdaGEMM 的运行时选择器会将该 prefill M 值映射到 bucket `16,384`。三种 `(16,384, N, K)` 组合都已存在于 GB10 的预调优库，因此官方 tuner 正确地报告 `tuned: false`；这表示无需产生新候选内核，而不是调优失败。

## 单算子基准

100 次测量、20 次预热的 CUDA-event 结果如下。它们用于确认热点规模，不可直接等同于端到端生成时间。

| 投影 | 中位数 | P95 |
| --- | ---: | ---: |
| FC1 | 51.39 ms | 59.90 ms |
| QKV | 37.92 ms | 42.47 ms |
| Attention output | 13.81 ms | 14.35 ms |

## Packing cache A/B

`packing_mode=on` 只复用可安全派生的连续 INT8 权重布局和每通道 FP32 scale；不缓存输入、输出、模型对象或采样状态。默认值保持 `off`，H3 Studio 的既有工作流没有变化。

| 运行 | `packing_mode=off` | `packing_mode=on` |
| --- | ---: | ---: |
| 第 1 次 | 67.225 s | 67.414 s |
| 第 2 次 | 67.241 s | 67.234 s |
| 中位数 | 67.233 s | 67.324 s |

开启缓存相对关闭缓存为约 **-0.14%**（略慢），远低于 3% 的保留门槛，也在端到端抖动范围内。因此不应将它作为用户可见的默认优化。

质量校验使用第 1 对 A/B 的解码后原始视频流及原始音频流 SHA-256：两者在 off/on 间均完全一致。这证明本实现没有改变该固定输入的结果；它不替代更广泛提示词和时序质量评估。

## 实现与安全边界

- 追踪为 thread-local 且默认关闭，只记录投影名、M/N/K、ConvRot 标记和标准化回退原因；不记录 prompt、latent、图像、音频或异常文本。
- 权重缓存用弱引用和 tensor identity / data pointer / shape / stride / dtype / device / version 签名失效。H3 inference tensor 不读取 `_version`，避免 PyTorch 的 inference-tensor 运行时错误。
- AdaGEMM tuner 的 isolated source 中仅为文档化的 per-channel `quant_param=None` 契约补上 shared-memory 预检查的兼容分支；运行时库 key 仍为 `None`，模型、ComfyUI core、Python 环境和权重均未修改。
- 未知 shape、非 BF16 输出、bias、`input_act`、布局不符、JIT 或 CUDA 异常继续走已有安全回退路径。

## 变更与回归验证

本轮节点与隔离实验工具位于目标 GB10 的 ComfyUI 自定义节点目录和独立 AdaGEMM 实验目录，典型文件包括：

- `<ComfyUI custom_nodes>/h3_adagemm_trial/profile.py`
- `<ComfyUI custom_nodes>/h3_adagemm_trial/packing.py`
- `<ComfyUI custom_nodes>/h3_adagemm_trial/nodes.py`
- `<AdaGEMM experiment root>/h3_tools/{profile_int8_shapes.py,tune_h3_int8_shapes.py,benchmark_h3_int8_shapes.py}`
- `<AdaGEMM experiment root>/src/ada_gemm/utils/quant.py`

验证结果：

| 检查 | 结果 |
| --- | --- |
| custom node 单元/契约测试 | 11 passed（0.60s） |
| isolated shape/tuner 工具测试 | 4 passed（0.71s） |
| H3 Studio workflow 回归 | 28 passed |
| 实际生成 A/B | 4 次成功，静态加载节点均命中缓存 |

## 推荐后续方向

当前 AdaGEMM GEMM 本身已经命中对应的 GB10 预调优内核，继续只调 block size、warp 或 stage 的预期收益很低。若要获得可见的下一档提升，应先做逐阶段 profiler，将目标放在 GEMM 外围的 ConvRot、动态量化、layout conversion 或 VAE/视频流水线；只有其中某一项成为显著热点，才值得开发融合内核。
