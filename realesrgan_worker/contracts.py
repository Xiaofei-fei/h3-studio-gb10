from dataclasses import dataclass, field
from typing import Literal


DeterministicUpscaleTarget = Literal["2k"]
DeterministicUpscaleState = Literal[
    "queued",
    "preparing",
    "upscaling",
    "saving",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
]

MODEL_NAME = "realesrgan-x2plus-fp16"
MODEL_FILENAME = "RealESRGAN_x2plus.pth"
MODEL_SHA256 = "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"
# The sidecar is capped at 6 GiB and streams frames through 512 px tiles.  A
# 12 GiB host reserve retains a 2x safety margin without hiding the worker on
# a GB10 that is concurrently keeping H3 resident.
MIN_AVAILABLE_MEMORY_BYTES = 12 * 1024 * 1024 * 1024
TILE_SIZE = 512
TILE_OVERLAP = 32


class ValidationError(ValueError):
    """Raised when a request falls outside the deterministic worker contract."""


@dataclass(frozen=True)
class SourceRef:
    filename: str
    subfolder: str | None = None
    type: str = "output"


@dataclass(frozen=True)
class TargetDimensions:
    final_width: int
    final_height: int


@dataclass(frozen=True)
class SupportedProfile:
    source_width: int
    source_height: int
    target: DeterministicUpscaleTarget
    dimensions: TargetDimensions


SUPPORTED_PROFILES = (
    SupportedProfile(
        source_width=832,
        source_height=480,
        target="2k",
        dimensions=TargetDimensions(final_width=2560, final_height=1478),
    ),
    SupportedProfile(
        source_width=1280,
        source_height=720,
        target="2k",
        dimensions=TargetDimensions(final_width=2560, final_height=1440),
    ),
    SupportedProfile(
        source_width=1344,
        source_height=768,
        target="2k",
        dimensions=TargetDimensions(final_width=2560, final_height=1464),
    ),
    SupportedProfile(
        source_width=1024,
        source_height=576,
        target="2k",
        dimensions=TargetDimensions(final_width=2560, final_height=1440),
    ),
    SupportedProfile(
        source_width=576,
        source_height=1024,
        target="2k",
        dimensions=TargetDimensions(final_width=1440, final_height=2560),
    ),
    SupportedProfile(
        source_width=768,
        source_height=768,
        target="2k",
        dimensions=TargetDimensions(final_width=2048, final_height=2048),
    ),
)


def target_dimensions(source_width: int, source_height: int, target: str) -> TargetDimensions:
    """Return only an end-to-end-validated H3 output enhancement profile."""
    for profile in SUPPORTED_PROFILES:
        if (
            source_width == profile.source_width
            and source_height == profile.source_height
            and target == profile.target
        ):
            return profile.dimensions
    if any((source_width, source_height) == (profile.source_width, profile.source_height) for profile in SUPPORTED_PROFILES):
        raise ValidationError(f"{source_width}×{source_height} H3 视频当前仅支持稳定 2K 增强。")
    raise ValidationError("当前稳定增强仅支持已验证的 H3 输出画幅。")


@dataclass
class WorkerJob:
    id: str
    source: SourceRef | None = None
    target: DeterministicUpscaleTarget = "2k"
    state: DeterministicUpscaleState = "queued"
    width: int = 0
    height: int = 0
    total_elapsed_ms: int = 0
    message: str | None = None
    output_filename: str | None = None
    output_subfolder: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)
