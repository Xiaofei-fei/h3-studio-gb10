"""A guarded GB10 packer for FastH3's existing VSA attention implementation.

The H3VSA node emits Q/K/V in [S, H, D] views and then materializes four
[B, H, S, D] tensors before padding each one.  This module writes the final
padded VSA layout directly.  The VSA math, gate, top-k, RoPE and projections
remain unchanged; unsupported inputs call the original H3VSA forward.
"""

from __future__ import annotations

import inspect
import logging
import math
import sys
import threading
from typing import Any, Callable, TypeVar


log = logging.getLogger(__name__)
BLOCK_ELEM = 64
PACK_BLOCK_TOKENS = 32
T = TypeVar("T")
_WARNED: set[str] = set()


def padded_token_count(tokens: int, block_elements: int = BLOCK_ELEM) -> int:
    if tokens < 0 or block_elements <= 0:
        raise ValueError("tokens and block_elements must be non-negative/positive")
    return tokens + ((block_elements - tokens % block_elements) % block_elements)


def qkv_source_offset(
    token: int,
    projection: int,
    head: int,
    dim: int,
    heads: int,
    head_dim: int,
) -> int:
    inner = heads * head_dim
    return token * (3 * inner) + projection * inner + head * head_dim + dim


def gate_source_offset(token: int, head: int, dim: int, heads: int, head_dim: int) -> int:
    return token * (heads * head_dim) + head * head_dim + dim


def hsd_source_offset(
    token: int,
    head: int,
    dim: int,
    *,
    stride_s: int,
    stride_h: int,
    stride_d: int,
) -> int:
    return token * stride_s + head * stride_h + dim * stride_d


def hsd_destination_offset(
    token: int,
    head: int,
    dim: int,
    *,
    heads: int,
    head_dim: int,
    padded_tokens: int,
) -> int:
    del heads  # Documented for symmetric call sites and layout readability.
    return head * padded_tokens * head_dim + token * head_dim + dim


def select_projection_forward(default_forward: Callable[..., T], override: Callable[..., T] | None) -> Callable[..., T]:
    """Prefer a ModelPatcher-resolved projection without changing its call ABI."""
    return default_forward if override is None else override


class _BlockMetadataCache:
    """Cache immutable VSA block-size tensors by device and exact padded shape."""

    def __init__(self):
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, int | None, int, int], Any] = {}

    def get(self, torch_module: Any, *, device: Any, tokens: int, padded_tokens: int):
        n_blocks = padded_tokens // BLOCK_ELEM
        last_size = BLOCK_ELEM if tokens == padded_tokens else tokens - (n_blocks - 1) * BLOCK_ELEM
        key = (device.type, device.index, n_blocks, last_size)
        with self._lock:
            existing = self._entries.get(key)
            if existing is not None and existing.device == device:
                return existing
            values = torch_module.full(
                (n_blocks,), BLOCK_ELEM, device=device, dtype=torch_module.int32,
            )
            if last_size != BLOCK_ELEM:
                values[-1] = last_size
            self._entries[key] = values
            return values


_BLOCK_METADATA = _BlockMetadataCache()


def _pack_kernel():
    """Create the Triton copy+pad kernel lazily so unit tests need no Triton."""
    import triton
    import triton.language as tl

    @triton.jit
    def copy_hsd_with_padding(
        source,
        destination,
        source_stride_s,
        source_stride_h,
        source_stride_d,
        tokens,
        padded_tokens,
        HEAD_DIM: tl.constexpr,
        BLOCK_TOKENS: tl.constexpr,
    ):
        head = tl.program_id(0)
        token_block = tl.program_id(1)
        rows = token_block * BLOCK_TOKENS + tl.arange(0, BLOCK_TOKENS)
        dims = tl.arange(0, HEAD_DIM)
        destination_offsets = head * padded_tokens * HEAD_DIM + rows[:, None] * HEAD_DIM + dims[None, :]
        source_offsets = (
            rows[:, None] * source_stride_s
            + head * source_stride_h
            + dims[None, :] * source_stride_d
        )
        destination_mask = rows[:, None] < padded_tokens
        source_mask = destination_mask & (rows[:, None] < tokens)
        values = tl.load(source + source_offsets, mask=source_mask, other=0.0)
        tl.store(destination + destination_offsets, values, mask=destination_mask)

    return copy_hsd_with_padding, triton


def _can_pack(*sources: Any, heads: int, head_dim: int) -> bool:
    return all(
        source.ndim == 3
        and source.shape[1] == heads
        and source.shape[2] == head_dim
        and source.shape[0] == sources[0].shape[0]
        and source.is_cuda
        and source.device == sources[0].device
        and source.dtype == sources[0].dtype
        for source in sources
    )


def pack_qkvg_for_vsa(
    q_source: Any,
    k_source: Any,
    v_source: Any,
    gate: Any,
    *,
    heads: int,
    head_dim: int,
    torch_module: Any,
):
    """Return contiguous padded VSA tensors with reference [B,H,S,D] values."""
    if not _can_pack(q_source, k_source, v_source, gate, heads=heads, head_dim=head_dim):
        raise ValueError("FastH3 VSA fused pack received an unsupported tensor layout")
    if head_dim not in {64, 128, 256}:
        raise ValueError(f"unsupported VSA head_dim {head_dim}")

    tokens = int(q_source.shape[0])
    padded_tokens = padded_token_count(tokens)
    copy_kernel, triton = _pack_kernel()
    destination_shape = (1, heads, padded_tokens, head_dim)
    q = torch_module.empty(destination_shape, device=q_source.device, dtype=q_source.dtype)
    k = torch_module.empty_like(q)
    v = torch_module.empty_like(q)
    gate_v = torch_module.empty_like(q)
    grid = (heads, triton.cdiv(padded_tokens, PACK_BLOCK_TOKENS))
    for source, destination in (
        (q_source, q),
        (k_source, k),
        (v_source, v),
        (gate, gate_v),
    ):
        copy_kernel[grid](
            source,
            destination,
            source.stride(0),
            source.stride(1),
            source.stride(2),
            tokens,
            padded_tokens,
            HEAD_DIM=head_dim,
            BLOCK_TOKENS=PACK_BLOCK_TOKENS,
            num_warps=4,
        )
    variable_block_sizes = _BLOCK_METADATA.get(
        torch_module,
        device=q_source.device,
        tokens=tokens,
        padded_tokens=padded_tokens,
    )
    return q, k, v, gate_v, padded_tokens - tokens, padded_tokens // BLOCK_ELEM, variable_block_sizes


def _warn_once(key: str, message: str, *args: Any) -> None:
    if key in _WARNED:
        return
    _WARNED.add(key)
    log.warning("[FastH3 GB10 VSA] " + message, *args)


def make_fused_vsa_forward(
    original_forward: Callable[..., T],
    *,
    qkv_forward: Callable[..., Any] | None = None,
    out_proj_forward: Callable[..., Any] | None = None,
):
    """Build an exact H3VSA forward except for its copy+pad data movement."""
    source = sys.modules.get(getattr(original_forward, "__module__", ""))
    if source is None:
        return original_forward
    try:
        captured = inspect.getclosurevars(original_forward).nonlocals
        attn = captured["attn"]
        fallback = captured["fallback"]
        gate_layer = captured["gate_layer"]
        topk_ratio = captured["topk_ratio"]
        min_tokens = captured["min_tokens"]
        hit_log = captured["hit_log"]
        gate_residency = captured["gate_residency"]
        vsa = getattr(source, "_vsa")
        vsa_ok = getattr(source, "_VSA_OK")
        gate_weight_for_device = getattr(source, "_gate_weight_for_device")
        comfy = getattr(source, "comfy")
        functional = getattr(source, "F")
        source_torch = getattr(source, "torch")
    except (AttributeError, KeyError, TypeError):
        return original_forward

    heads = attn.heads
    head_dim = attn.head_dim
    inner = heads * head_dim
    active_qkv_forward = select_projection_forward(attn.qkv_proj, qkv_forward)
    active_out_proj_forward = select_projection_forward(attn.out_proj, out_proj_forward)

    def forward(x, rope_freqs=None, transformer_options={}):
        s = x.shape[0]
        try:
            if not vsa_ok or x.ndim != 2 or s < min_tokens:
                return original_forward(x, rope_freqs=rope_freqs, transformer_options=transformer_options)
            if x.dtype != source_torch.bfloat16 or x.device.type != "cuda" or gate_layer is None:
                return original_forward(x, rope_freqs=rope_freqs, transformer_options=transformer_options)
            if not hit_log._active:
                source_torch.cuda.empty_cache()

            qkv = active_qkv_forward(x)
            q, k, v = qkv.split(inner, dim=-1)
            v = v.view(s, heads, head_dim)
            if rope_freqs is not None:
                q = q.view(1, s, heads, head_dim)
                k = k.view(1, s, heads, head_dim)
                qw = comfy.model_management.cast_to(attn.q_norm.weight, device=x.device)
                kw = comfy.model_management.cast_to(attn.k_norm.weight, device=x.device)
                rot = rope_freqs.shape[-3] * 2
                comfy.quant_ops.ck.rms_rope_split_half_(
                    q, k, rope_freqs, qw, kw,
                    epsilon=attn.q_norm.eps, rot_dim=rot,
                )
                q = q[0]
                k = k[0]
            else:
                q = attn.q_norm(q.view(s, heads, head_dim))
                k = attn.k_norm(k.view(s, heads, head_dim))

            gate_weight = gate_weight_for_device(gate_layer, x.device, gate_residency)
            try:
                gate = functional.linear(x, gate_weight).view(s, heads, head_dim)
            finally:
                del gate_weight

            q, k, v, gate_v, pad, n_blocks, variable_block_sizes = pack_qkvg_for_vsa(
                q,
                k,
                v,
                gate,
                heads=heads,
                head_dim=head_dim,
                torch_module=source_torch,
            )
            topk = max(1, int(math.ceil(n_blocks * topk_ratio)))
            out = vsa(
                q, k, v,
                variable_block_sizes=variable_block_sizes,
                topk=topk,
                block_size=(4, 4, 4),
                compress_attn_weight=gate_v,
            )
            out = out.permute(0, 2, 1, 3).contiguous()[0]
            if pad:
                out = out[:s]
            hit_log.hit(s, topk, n_blocks)
            return active_out_proj_forward(out.reshape(s, inner))
        except Exception as error:  # A kernel failure must never make FastH3 unavailable.
            _warn_once(type(error).__name__, "fused pack declined after %s: %s", type(error).__name__, error)
            return original_forward(x, rope_freqs=rope_freqs, transformer_options=transformer_options)

    forward._h3_vsa_fallback = fallback
    forward._h3_studio_vsa_fast_original = original_forward
    return forward


class H3StudioFastH3GB10VSA:
    """VSA Fused Layout Engine for GB10 FastH3."""

    CATEGORY = "H3 Studio/GB10"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "enabled": ("BOOLEAN", {"default": False}),
        }}

    def apply(self, model, enabled: bool):
        if not enabled:
            return (model,)
        import torch

        if not torch.cuda.is_available() or "GB10" not in torch.cuda.get_device_name():
            return (model,)
        diffusion_model = model.get_model_object("diffusion_model")
        blocks = getattr(diffusion_model, "blocks", None)
        if blocks is None:
            return (model,)

        patched = model.clone()
        patched_count = 0
        for index in range(len(blocks)):
            path = f"diffusion_model.blocks.{index}.attn.forward"
            forward = patched.get_model_object(path)
            while hasattr(forward, "_h3_studio_vsa_fast_original"):
                forward = forward._h3_studio_vsa_fast_original
            if not hasattr(forward, "_h3_vsa_fallback"):
                continue
            qkv_forward = patched.get_model_object(
                f"diffusion_model.blocks.{index}.attn.qkv_proj.forward",
            )
            out_proj_forward = patched.get_model_object(
                f"diffusion_model.blocks.{index}.attn.out_proj.forward",
            )
            patched.add_object_patch(
                path,
                make_fused_vsa_forward(
                    forward,
                    qkv_forward=qkv_forward,
                    out_proj_forward=out_proj_forward,
                ),
            )
            patched_count += 1
        if not patched_count:
            return (model,)
        log.info("[FastH3 GB10 VSA] patched fused pack across %d H3 blocks", patched_count)
        return (patched,)
