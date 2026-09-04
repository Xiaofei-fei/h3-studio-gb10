"""Regional ``torch.compile`` decode path for the MiniMax H3 video VAE.

The VAE's chunking, tiling, blend, and output-buffer semantics stay native.
Only ``MiniMaxH3VideoVAE._decode_pixels`` (post-quant convolution plus the
ViT3D decoder) is compiled, because this is the repeated fixed-shape region
inside every spatial tile batch.
"""

from __future__ import annotations

import logging
import threading
import weakref
from typing import Any, Callable


log = logging.getLogger(__name__)
_DECODE_LOCK = threading.RLock()


def is_supported_h3_video_vae(first_stage_model: Any) -> bool:
    """Return whether the exact MiniMax H3 tile decoder contract is present."""
    return (
        first_stage_model is not None
        and first_stage_model.__class__.__name__ == "MiniMaxH3VideoVAE"
        and callable(getattr(first_stage_model, "_decode_pixels", None))
    )


def inductor_mode_for_allocator(allocator_backend: str | None) -> str:
    """Avoid Inductor CUDA Graph capture when Comfy runs cudaMallocAsync."""
    return "default" if allocator_backend == "cudaMallocAsync" else "reduce-overhead"


def _allocator_backend(torch_module: Any) -> str | None:
    cuda = getattr(torch_module, "cuda", None)
    get_backend = getattr(cuda, "get_allocator_backend", None)
    if not callable(get_backend):
        return None
    try:
        return str(get_backend())
    except Exception:
        return None


class _CompiledDecodeCache:
    """Keep one compiled regional decoder per live VAE instance."""

    def __init__(self) -> None:
        self._entries: weakref.WeakKeyDictionary[Any, tuple[Any, Callable[..., Any], str]] = weakref.WeakKeyDictionary()

    def get(self, first_stage_model: Any, torch_module: Any) -> tuple[Callable[..., Any], bool, str]:
        original_forward = first_stage_model._decode_pixels
        source_function = getattr(original_forward, "__func__", original_forward)
        existing = self._entries.get(first_stage_model)
        if existing is not None and existing[0] is source_function:
            return existing[1], False, existing[2]

        mode = inductor_mode_for_allocator(_allocator_backend(torch_module))
        compiled = torch_module.compile(
            original_forward,
            fullgraph=False,
            dynamic=False,
            mode=mode,
        )
        self._entries[first_stage_model] = (source_function, compiled, mode)
        return compiled, True, mode


_COMPILED_DECODE_CACHE = _CompiledDecodeCache()


def _decode_with_regional_compile(vae: Any, latent: Any, tile_batch_size: int, torch_module: Any):
    """Call VAE decode with only its repeated pixel-decoder region compiled.

    If compile/capture cannot support the installed VAE build, restore the
    original bound method and transparently execute the native decoder.
    """
    first_stage_model = getattr(vae, "first_stage_model", None)
    if not is_supported_h3_video_vae(first_stage_model) or not hasattr(torch_module, "compile"):
        return vae.decode(latent, vae_options={"tile_batch_size": tile_batch_size})

    with _DECODE_LOCK:
        native_forward = first_stage_model._decode_pixels
        try:
            compiled_forward, created, mode = _COMPILED_DECODE_CACHE.get(first_stage_model, torch_module)
            first_stage_model._decode_pixels = compiled_forward
            try:
                images = vae.decode(latent, vae_options={"tile_batch_size": tile_batch_size})
            finally:
                first_stage_model._decode_pixels = native_forward
            log.info(
                "[FastH3 VAE Compile] regional decoder %s (Inductor mode=%s)",
                "compiled" if created else "reused",
                mode,
            )
            return images
        except Exception as error:  # compile is optional; the native VAE is the safety fallback.
            first_stage_model._decode_pixels = native_forward
            log.warning(
                "[FastH3 VAE Compile] declined after %s: %s; using native decoder",
                type(error).__name__,
                error,
            )
            return vae.decode(latent, vae_options={"tile_batch_size": tile_batch_size})


class H3StudioFastH3VaeDecodeCompile:
    """Decode FastH3 VAE tiles through a guarded compiled decoder region."""

    CATEGORY = "H3 Studio/GB10"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "vae": ("VAE",),
                "tile_batch_size": ("INT", {"default": 2, "min": 1, "max": 12, "step": 1}),
            }
        }

    def decode(self, samples: Any, vae: Any, tile_batch_size: int):
        import torch

        latent = samples["samples"]
        if latent.is_nested:
            latent = latent.unbind()[0]
        images = _decode_with_regional_compile(vae, latent, max(1, int(tile_batch_size)), torch)
        if images.ndim == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        return (images,)
