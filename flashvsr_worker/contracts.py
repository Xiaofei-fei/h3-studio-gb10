from dataclasses import dataclass, field
from typing import Literal


UpscaleTarget = Literal["2k", "4k"]
UpscaleState = Literal[
    "queued",
    "preparing",
    "upscaling",
    "saving",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
]


@dataclass(frozen=True)
class SourceRef:
    filename: str
    subfolder: str | None = None
    type: str = "output"


@dataclass(frozen=True)
class TargetDimensions:
    final_width: int
    final_height: int
    padded_width: int
    padded_height: int
    pad_x: int
    pad_y: int


@dataclass
class WorkerJob:
    id: str
    source: SourceRef | None = None
    target: UpscaleTarget = "2k"
    state: UpscaleState = "queued"
    width: int = 0
    height: int = 0
    total_elapsed_ms: int = 0
    message: str | None = None
    output_filename: str | None = None
    output_subfolder: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)
