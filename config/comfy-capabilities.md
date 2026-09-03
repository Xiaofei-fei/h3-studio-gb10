# ComfyUI capability contract

H3 Studio queries `GET /object_info` at startup. A UI control is enabled only
when its required node and model option are available; a missing capability is
reported rather than silently substituted.

| Area | Required node or worker | What it enables |
| --- | --- | --- |
| H3 Standard | `H3SpargeAttention`, `ApplyMiniMaxH3FirstBlockCache`, `ApplyMiniMaxH3EasyCache`, `MiniMaxH3FusedModulation` | Dense/sparse attention A/B, feature or denoising cache, and fused modulation. FirstBlockCache and EasyCache remain mutually exclusive. |
| H3 Standard INT8 | `MiniMaxH3GB10CublasInt8` or `MiniMaxH3GB10AdaGemmInt8` | GB10 INT8 projection path. The two choices are mutually exclusive. |
| H3 video decode | `MiniMaxH3VAEDecodeBatched` | VAE tile batch decoding; use only when the node reports support. |
| Reference video | `MiniMaxH3ReferenceToVideo` plus `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | First/last-frame and multimodal reference conditioning. |
| TAEH3 preview | `H3StudioTAEH3PreviewLoader`, `MiniMaxH3PreviewOverride` | Optional realtime preview; it is independent of inference optimizations. |
| FastH3 VSA | `H3VSA`, `fasth3_vsa_4-steps-v5.safetensors`, `fasth3_vsa_gate.safetensors` | Low-latency VSA path with its fixed workflow settings. |
| FastH3 decode | `MiniMaxH3VAEDecodeBatched` | Optional tile batch decode for FastH3. |
| MiniMax Music3 | `VAEDecodeAudioTiled` plus the three Music3 model files | Music generation and optional tiled audio decoding. |
| FlashVSR | `flashvsr-worker` on loopback port 8190 | Offline high-quality video enhancement after its compatibility gate passes. |
| RealESRGAN | `realesrgan-worker` on loopback port 8191 | Deterministic x2 enhancement after checksum verification. |

The node names above are deployment requirements, not Python package names. See
`config/model-manifest.yaml` for the corresponding external model artifacts.
