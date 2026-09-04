"""Opt-in, aggregate-only CUDA timing for the already-patched FastH3 VSA path.

This module deliberately does not load model weights, alter tensor values, or
serialize user inputs.  It wraps the H3VSA attention forward only when an
operator adds ``H3StudioFastH3Profile`` to a workflow.
"""

from __future__ import annotations

from dataclasses import dataclass
import inspect
import json
import math
import os
import sys
import time
from typing import Any, Callable, Iterable, TypeVar


CANONICAL_STAGES = (
    "qkv",
    "rope_norm",
    "gate",
    "layout_pad",
    "vsa",
    "out_proj",
)
REPORT_PATH = "/comfy/output/H3Studio/fasth3-vsa-profile.jsonl"
T = TypeVar("T")


@dataclass
class _Aggregate:
    shape: list[int] | None = None
    count: int = 0
    cuda_ms: float = 0.0
    fallback_count: int = 0


class ProfileAccumulator:
    """Aggregate timing records without retaining model or request contents."""

    def __init__(self, *, enabled: bool, elapsed_ms: Callable[[], float] | None = None):
        self.enabled = enabled
        self._elapsed_ms = elapsed_ms
        self._aggregates: dict[tuple[str, tuple[int, ...]], _Aggregate] = {}

    @staticmethod
    def _validate_stage(stage: str) -> None:
        if stage not in CANONICAL_STAGES:
            raise ValueError(f"unsupported FastH3 profile stage: {stage}")

    @staticmethod
    def _shape(shape: Iterable[int]) -> tuple[int, ...]:
        values = tuple(int(value) for value in shape)
        if any(value < 0 for value in values):
            raise ValueError("profile shape values must be non-negative")
        return values

    def _aggregate(self, stage: str, shape: Iterable[int]) -> _Aggregate:
        self._validate_stage(stage)
        normalized_shape = self._shape(shape)
        key = (stage, normalized_shape)
        aggregate = self._aggregates.get(key)
        if aggregate is None:
            aggregate = _Aggregate(shape=list(normalized_shape))
            self._aggregates[key] = aggregate
        return aggregate

    def add(self, stage: str, *, shape: Iterable[int], cuda_ms: float, fallback: bool = False) -> None:
        if not self.enabled:
            return
        aggregate = self._aggregate(stage, shape)
        aggregate.count += 1
        aggregate.cuda_ms += float(cuda_ms)
        aggregate.fallback_count += int(fallback)

    def measure(self, stage: str, *, shape: Iterable[int], callback: Callable[[], T]) -> T:
        """Run work unchanged and, when enabled, record an aggregate duration."""
        if not self.enabled:
            return callback()
        if self._elapsed_ms is not None:
            result = callback()
            self.add(stage, shape=shape, cuda_ms=self._elapsed_ms())
            return result

        started = time.perf_counter()
        try:
            return callback()
        finally:
            self.add(stage, shape=shape, cuda_ms=(time.perf_counter() - started) * 1000.0)

    def records(self) -> list[dict[str, Any]]:
        """Return only populated, whitelisted aggregate fields."""
        return [
            {
                "stage": stage,
                "shape": aggregate.shape,
                "count": aggregate.count,
                "cuda_ms": round(aggregate.cuda_ms, 6),
                "fallback_count": aggregate.fallback_count,
            }
            for (stage, _), aggregate in sorted(
                self._aggregates.items(),
                key=lambda item: (CANONICAL_STAGES.index(item[0][0]), item[0][1]),
            )
        ]

    def snapshot(self) -> list[dict[str, Any]]:
        """Return one aggregate per canonical stage, including zero-hit stages."""
        output: list[dict[str, Any]] = []
        for stage in CANONICAL_STAGES:
            stage_records = [
                aggregate for (record_stage, _), aggregate in self._aggregates.items()
                if record_stage == stage
            ]
            if stage_records:
                latest = max(stage_records, key=lambda aggregate: aggregate.count)
                output.append({
                    "stage": stage,
                    "shape": latest.shape,
                    "count": sum(aggregate.count for aggregate in stage_records),
                    "cuda_ms": round(sum(aggregate.cuda_ms for aggregate in stage_records), 6),
                    "fallback_count": sum(aggregate.fallback_count for aggregate in stage_records),
                })
            else:
                output.append({
                    "stage": stage,
                    "shape": None,
                    "count": 0,
                    "cuda_ms": 0.0,
                    "fallback_count": 0,
                })
        return output

    def clear(self) -> None:
        self._aggregates.clear()


class _CudaEventProfiler:
    """Defers one synchronization until a full FastH3 denoise pass is observed."""

    def __init__(
        self,
        *,
        torch_module: Any,
        accumulator: ProfileAccumulator,
        expected_calls: int,
        report_path: str,
    ):
        self._torch = torch_module
        self._accumulator = accumulator
        self._expected_calls = expected_calls
        self._report_path = report_path
        self._pending: list[tuple[str, tuple[int, ...], Any, Any]] = []

    def measure(self, stage: str, *, shape: Iterable[int], callback: Callable[[], T]) -> T:
        if not self._accumulator.enabled:
            return callback()
        start = self._torch.cuda.Event(enable_timing=True)
        end = self._torch.cuda.Event(enable_timing=True)
        start.record()
        try:
            return callback()
        finally:
            end.record()
            self._pending.append((stage, tuple(int(value) for value in shape), start, end))
            if len(self._pending) >= self._expected_calls:
                self.flush()

    def flush(self) -> None:
        if not self._pending:
            return
        self._torch.cuda.synchronize()
        for stage, shape, start, end in self._pending:
            self._accumulator.add(
                stage,
                shape=shape,
                cuda_ms=float(start.elapsed_time(end)),
            )
        self._pending.clear()
        directory = os.path.dirname(self._report_path)
        os.makedirs(directory, exist_ok=True)
        with open(self._report_path, "a", encoding="utf-8") as report:
            report.write(json.dumps({
                "stages": self._accumulator.snapshot(),
                "shapes": self._accumulator.records(),
            }, separators=(",", ":")) + "\n")
        self._accumulator.clear()


def _make_profiled_forward(forward: Callable[..., T], profiler: _CudaEventProfiler):
    def profiled(x, rope_freqs=None, transformer_options={}):
        # The original H3VSA closure performs the exact attention calculation.
        # This wrapper records only the full VSA-forward interval; Nsight then
        # resolves its QKV/gate/layout/out-proj kernel composition without
        # duplicating or modifying that numerical implementation.
        return profiler.measure(
            "vsa",
            shape=tuple(int(value) for value in x.shape),
            callback=lambda: forward(
                x,
                rope_freqs=rope_freqs,
                transformer_options=transformer_options,
            ),
        )

    profiled._h3_vsa_fallback = getattr(forward, "_h3_vsa_fallback", None)
    return profiled


def make_profiled_vsa_forward(forward: Callable[..., T], profiler: _CudaEventProfiler):
    """Rebuild only the known H3VSA closure with stage-level CUDA events.

    The FastVideo node has no public callback inside its `forward`, so merely
    wrapping it reports only one opaque interval.  For the exact current H3VSA
    closure we read its captured objects and execute the same arithmetic with
    event boundaries.  Unknown forwards are deliberately left untouched.
    """
    source = sys.modules.get(getattr(forward, "__module__", ""))
    if source is None:
        return forward
    try:
        captured = inspect.getclosurevars(forward).nonlocals
        attn = captured["attn"]
        fallback = captured["fallback"]
        gate_layer = captured["gate_layer"]
        topk_ratio = captured["topk_ratio"]
        min_tokens = captured["min_tokens"]
        block_elem = captured["block_elem"]
        hit_log = captured["hit_log"]
        gate_residency = captured["gate_residency"]
        unsupported = getattr(source, "_Unsupported")
        vsa = getattr(source, "_vsa")
        vsa_ok = getattr(source, "_VSA_OK")
        gate_weight_for_device = getattr(source, "_gate_weight_for_device")
        comfy = getattr(source, "comfy")
        functional = getattr(source, "F")
        source_torch = getattr(source, "torch")
    except (AttributeError, KeyError, TypeError):
        return forward

    heads = attn.heads
    head_dim = attn.head_dim
    inner = heads * head_dim

    def profiled(x, rope_freqs=None, transformer_options={}):
        s = x.shape[0]
        if not hit_log._active and x.device.type == "cuda":
            source_torch.cuda.empty_cache()
        try:
            if not vsa_ok:
                raise unsupported("vsa unavailable")
            if x.ndim != 2 or s < min_tokens:
                raise unsupported("below min_tokens")
            if x.dtype != source_torch.bfloat16 or x.device.type != "cuda":
                raise unsupported("requires bfloat16 CUDA")
            if gate_layer is None:
                raise unsupported("no gate weights for this block")

            def project_qkv():
                q_value, k_value, v_value = attn.qkv_proj(x).split(inner, dim=-1)
                return q_value, k_value, v_value.view(s, heads, head_dim)

            q, k, v = profiler.measure(
                "qkv", shape=tuple(int(value) for value in x.shape), callback=project_qkv,
            )

            if rope_freqs is not None:
                def apply_rope_norm():
                    q_value = q.view(1, s, heads, head_dim)
                    k_value = k.view(1, s, heads, head_dim)
                    qw = comfy.model_management.cast_to(attn.q_norm.weight, device=x.device)
                    kw = comfy.model_management.cast_to(attn.k_norm.weight, device=x.device)
                    rot = rope_freqs.shape[-3] * 2
                    comfy.quant_ops.ck.rms_rope_split_half_(
                        q_value, k_value, rope_freqs, qw, kw,
                        epsilon=attn.q_norm.eps, rot_dim=rot,
                    )
                    return q_value[0], k_value[0]

                q, k = profiler.measure(
                    "rope_norm", shape=(s, heads, head_dim), callback=apply_rope_norm,
                )
            else:
                q, k = profiler.measure(
                    "rope_norm",
                    shape=(s, heads, head_dim),
                    callback=lambda: (
                        attn.q_norm(q.view(s, heads, head_dim)),
                        attn.k_norm(k.view(s, heads, head_dim)),
                    ),
                )

            def project_gate():
                gate_weight = gate_weight_for_device(gate_layer, x.device, gate_residency)
                try:
                    return functional.linear(x, gate_weight).view(s, heads, head_dim)
                finally:
                    del gate_weight

            gate = profiler.measure(
                "gate", shape=tuple(int(value) for value in x.shape), callback=project_gate,
            )

            def build_vsa_layout():
                q_value = q.unsqueeze(0).permute(0, 2, 1, 3).contiguous()
                k_value = k.unsqueeze(0).permute(0, 2, 1, 3).contiguous()
                v_value = v.unsqueeze(0).permute(0, 2, 1, 3).contiguous()
                gate_value = gate.unsqueeze(0).permute(0, 2, 1, 3).contiguous()
                pad = (block_elem - s % block_elem) % block_elem
                n_blocks = (s + pad) // block_elem
                if pad:
                    q_value = functional.pad(q_value, (0, 0, 0, pad))
                    k_value = functional.pad(k_value, (0, 0, 0, pad))
                    v_value = functional.pad(v_value, (0, 0, 0, pad))
                    gate_value = functional.pad(gate_value, (0, 0, 0, pad))
                variable_block_sizes = source_torch.full(
                    (n_blocks,), block_elem, device=q_value.device, dtype=source_torch.int32,
                )
                if pad:
                    variable_block_sizes[-1] = block_elem - pad
                return q_value, k_value, v_value, gate_value, pad, n_blocks, variable_block_sizes

            q, k, v, gate_v, pad, n_blocks, vbs = profiler.measure(
                "layout_pad", shape=(s, heads, head_dim), callback=build_vsa_layout,
            )
            topk = max(1, int(math.ceil(n_blocks * topk_ratio)))
            out = profiler.measure(
                "vsa",
                shape=(n_blocks, heads, block_elem, head_dim),
                callback=lambda: vsa(
                    q, k, v,
                    variable_block_sizes=vbs,
                    topk=topk,
                    block_size=(4, 4, 4),
                    compress_attn_weight=gate_v,
                ),
            )

            def project_output():
                output = out.permute(0, 2, 1, 3).contiguous()[0]
                if pad:
                    output = output[:s]
                return attn.out_proj(output.reshape(s, inner))

            result = profiler.measure(
                "out_proj", shape=(s, inner), callback=project_output,
            )
            hit_log.hit(s, topk, n_blocks)
            return result
        except unsupported as error:
            hit_log.miss(str(error))

        return fallback(x, rope_freqs=rope_freqs, transformer_options=transformer_options)

    profiled._h3_vsa_fallback = fallback
    return profiled


class H3StudioFastH3Profile:
    """Attach CUDA-event timing to FastH3 VSA forwards without changing output."""

    CATEGORY = "H3 Studio/diagnostics"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "enabled": ("BOOLEAN", {"default": False}),
            "expected_calls": ("INT", {"default": 200, "min": 1, "max": 1000}),
        }}

    def apply(self, model, enabled: bool, expected_calls: int):
        if not enabled:
            return (model,)

        import torch

        if not torch.cuda.is_available():
            return (model,)

        diffusion_model = model.get_model_object("diffusion_model")
        blocks = getattr(diffusion_model, "blocks", None)
        if blocks is None:
            return (model,)

        patched = model.clone()
        accumulator = ProfileAccumulator(enabled=True)
        profiler = _CudaEventProfiler(
            torch_module=torch,
            accumulator=accumulator,
            expected_calls=int(expected_calls),
            report_path=REPORT_PATH,
        )
        patched_count = 0
        for index in range(len(blocks)):
            path = f"diffusion_model.blocks.{index}.attn.forward"
            forward = patched.get_model_object(path)
            if not hasattr(forward, "_h3_vsa_fallback"):
                continue
            patched.add_object_patch(path, make_profiled_vsa_forward(forward, profiler))
            patched_count += 1

        if not patched_count:
            return (model,)
        return (patched,)
