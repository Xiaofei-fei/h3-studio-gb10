"""Thin, lazy adapter over the official FlashVSR v1.1 full pipeline.

The project code is installed unchanged in `/opt/FlashVSR`; this adapter only
supplies paths and the production inference parameters agreed for H3 Studio.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import MethodType
from typing import Any


# Twice the upstream default tile dimensions with the same 50% overlap.  The
# temporal streaming scheduler keeps the peak memory bounded while reducing
# the high-resolution 720P grid from 144 to 36 spatial tiles.
FLASHVSR_TILE_SIZE = (120, 208)
FLASHVSR_TILE_STRIDE = (60, 104)
DEFAULT_KV_RATIO = 3.0


def streaming_kv_ratio(environ: dict[str, str] | None = None) -> float:
    """Read the bounded temporal-history setting used by the official DiT.

    The default exactly preserves the upstream v1.1 setting. A smaller value
    is an explicitly opt-in memory experiment: it retains fewer prior
    temporal windows, never changes the number of denoising steps, and is not
    exposed in the frontend until a long-video quality check passes.
    """
    variables = os.environ if environ is None else environ
    raw = variables.get("FLASHVSR_KV_RATIO")
    if raw is None or not raw.strip():
        return DEFAULT_KV_RATIO
    try:
        value = float(raw)
    except ValueError as error:
        raise RuntimeError("FLASHVSR_KV_RATIO 必须是 1 到 3 之间的数字。") from error
    if not 1.0 <= value <= DEFAULT_KV_RATIO:
        raise RuntimeError("FLASHVSR_KV_RATIO 必须在 1 到 3 之间。")
    return value


def add_official_import_paths(repo_dir: Path) -> None:
    """Expose both official package roots used by the WanVSR example scripts."""
    root = repo_dir.resolve()
    wanvsr_dir = root / "examples" / "WanVSR"
    if not (wanvsr_dir / "utils").is_dir():
        raise RuntimeError("FlashVSR 官方 WanVSR 工具目录缺失。")
    for path in (root, wanvsr_dir):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def official_prompt_tensor_path(repo_dir: Path) -> Path:
    return repo_dir.resolve() / "examples" / "WanVSR" / "prompt_tensor" / "posi_prompt.pth"


def spatial_tile_tasks(
    *,
    latent_height: int,
    latent_width: int,
    tile_size: tuple[int, int],
    tile_stride: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    """Return the exact spatial task layout used by FlashVSR's Wan VAE."""
    size_h, size_w = tile_size
    stride_h, stride_w = tile_stride
    if min(size_h, size_w, stride_h, stride_w) <= 0:
        raise ValueError("FlashVSR tile size and stride must be positive.")
    tasks: list[tuple[int, int, int, int]] = []
    for top in range(0, latent_height, stride_h):
        if top - stride_h >= 0 and top - stride_h + size_h >= latent_height:
            continue
        for left in range(0, latent_width, stride_w):
            if left - stride_w >= 0 and left - stride_w + size_w >= latent_width:
                continue
            tasks.append((top, top + size_h, left, left + size_w))
    return tasks


def _release_cuda_cache(torch_module: Any) -> None:
    empty_cache = getattr(getattr(torch_module, "cuda", None), "empty_cache", None)
    if callable(empty_cache):
        empty_cache()


def memory_safe_tiled_decode(
    vae: Any,
    torch_module: Any,
    hidden_states: Any,
    device: str,
    tile_size: tuple[int, int],
    tile_stride: tuple[int, int],
) -> Any:
    """Run the official tiled VAE with equivalent temporal streaming.

    The upstream tiled decoder runs every temporal latent in a spatial tile as
    one large batch.  FlashVSR's ``stream_decode`` performs exactly the same
    causal VAE operations one latent at a time while retaining only that
    tile's temporal cache.  Moving each result to CPU before the next chunk
    bounds GPU/UMA activation pressure without changing the blend math.
    """
    _, _, temporal, latent_height, latent_width = hidden_states.shape
    upsampling = vae.upsampling_factor
    out_temporal = temporal * 4 - 3
    data_device = "cpu"
    values = torch_module.zeros(
        (1, 3, out_temporal, latent_height * upsampling, latent_width * upsampling),
        dtype=hidden_states.dtype,
        device=data_device,
    )
    weight = torch_module.zeros(
        (1, 1, out_temporal, latent_height * upsampling, latent_width * upsampling),
        dtype=hidden_states.dtype,
        device=data_device,
    )

    for top, bottom, left, right in spatial_tile_tasks(
        latent_height=latent_height,
        latent_width=latent_width,
        tile_size=tile_size,
        tile_stride=tile_stride,
    ):
        # This mirrors ``VideoVAE_.decode`` at the start of each official
        # spatial tile, then keeps just this tile's temporal causal cache.
        vae.model.clear_cache()
        output_offset = 0
        try:
            for temporal_index in range(temporal):
                tile_input = hidden_states[
                    :, :, temporal_index:temporal_index + 1, top:bottom, left:right
                ].to(device)
                tile_output = vae.model.stream_decode(tile_input, vae.scale).to(data_device)
                output_end = output_offset + tile_output.shape[2]
                if output_end > out_temporal:
                    raise RuntimeError("FlashVSR 流式 VAE 返回了意外的时间维度。")
                mask = vae.build_mask(
                    tile_output,
                    is_bound=(top == 0, bottom >= latent_height, left == 0, right >= latent_width),
                    border_width=(
                        (tile_size[0] - tile_stride[0]) * upsampling,
                        (tile_size[1] - tile_stride[1]) * upsampling,
                    ),
                ).to(dtype=hidden_states.dtype, device=data_device)
                target_top = top * upsampling
                target_left = left * upsampling
                target_bottom = target_top + tile_output.shape[3]
                target_right = target_left + tile_output.shape[4]
                values[:, :, output_offset:output_end, target_top:target_bottom, target_left:target_right] += tile_output * mask
                weight[:, :, output_offset:output_end, target_top:target_bottom, target_left:target_right] += mask
                output_offset = output_end
                del tile_input, tile_output, mask
                _release_cuda_cache(torch_module)
            if output_offset != out_temporal:
                raise RuntimeError("FlashVSR 流式 VAE 未返回完整的视频时间维度。")
        finally:
            vae.model.clear_cache()
            _release_cuda_cache(torch_module)
    return (values / weight).clamp_(-1, 1)


def install_memory_safe_tiled_decode(pipeline: Any, torch_module: Any) -> None:
    """Install a narrow runtime patch without modifying the official checkout."""
    vae = pipeline.vae

    def _tiled_decode(
        self: Any,
        hidden_states: Any,
        device: str,
        tile_size: tuple[int, int],
        tile_stride: tuple[int, int],
    ) -> Any:
        return memory_safe_tiled_decode(
            self,
            torch_module,
            hidden_states,
            device,
            tile_size,
            tile_stride,
        )

    vae.tiled_decode = MethodType(_tiled_decode, vae)


class OfficialFlashVsrPipeline:
    def __init__(self, model_dir: Path, repo_dir: Path | None = None) -> None:
        self.model_dir = model_dir.resolve()
        self.repo_dir = (repo_dir or Path(os.environ.get("FLASHVSR_REPO", "/opt/FlashVSR"))).resolve()
        self._torch: Any | None = None
        self._pipeline: Any | None = None

    def _model_file(self, filename: str) -> Path:
        path = self.model_dir / filename
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"缺少 FlashVSR 模型文件：{filename}")
        return path

    def _load(self) -> None:
        if self._pipeline is not None:
            return
        add_official_import_paths(self.repo_dir)
        import torch
        from diffsynth import FlashVSRFullPipeline, ModelManager
        from utils.utils import Causal_LQ4x_Proj

        if not torch.cuda.is_available():
            raise RuntimeError("FlashVSR 需要可用的 CUDA 设备。")
        diffusion = self._model_file("diffusion_pytorch_model_streaming_dmd.safetensors")
        vae = self._model_file("Wan2.1_VAE.pth")
        projection = self._model_file("LQ_proj_in.ckpt")

        manager = ModelManager(torch_dtype=torch.bfloat16, device="cpu")
        manager.load_models([str(diffusion), str(vae)])
        pipeline = FlashVSRFullPipeline.from_model_manager(manager, device="cuda")
        install_memory_safe_tiled_decode(pipeline, torch)
        lq_projection = Causal_LQ4x_Proj(in_dim=3, out_dim=1536, layer_num=1).to("cuda", dtype=torch.bfloat16)
        lq_projection.load_state_dict(torch.load(projection, map_location="cpu"), strict=True)
        pipeline.denoising_model().LQ_proj_in = lq_projection.to("cuda")
        # This is the official v1.1 full-pipeline memory layout, not a model fork.
        pipeline.vae.model.encoder = None
        pipeline.vae.model.conv1 = None
        pipeline.to("cuda")
        pipeline.enable_vram_management(num_persistent_param_in_dit=None)
        prompt_tensor = official_prompt_tensor_path(self.repo_dir)
        if not prompt_tensor.is_file():
            raise RuntimeError("FlashVSR 官方提示词张量缺失。")
        pipeline.init_cross_kv(context_tensor=torch.load(prompt_tensor, map_location="cpu"))
        pipeline.load_models_to_device(["dit", "vae"])
        self._torch = torch
        self._pipeline = pipeline

    def enhance(self, lq_video: Any, *, height: int, width: int, num_frames: int) -> Any:
        self._load()
        assert self._pipeline is not None
        assert self._torch is not None
        with self._torch.inference_mode():
            return self._pipeline(
                prompt="",
                negative_prompt="",
                cfg_scale=1.0,
                num_inference_steps=1,
                seed=0,
                # This is the official low-memory path.  The overlap preserves
                # continuity at tile boundaries while preventing a full 5K VAE
                # decode from exhausting the GB10 host.
                tiled=True,
                tile_size=FLASHVSR_TILE_SIZE,
                tile_stride=FLASHVSR_TILE_STRIDE,
                LQ_video=lq_video,
                num_frames=num_frames,
                height=height,
                width=width,
                is_full_block=False,
                if_buffer=True,
                topk_ratio=2.0 * 768 * 1280 / (height * width),
                kv_ratio=streaming_kv_ratio(),
                local_range=11,
                color_fix=True,
            )
