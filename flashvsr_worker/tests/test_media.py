from pathlib import Path

import pytest

from flashvsr_worker.contracts import SourceRef, TargetDimensions
from flashvsr_worker.media import (
    ValidationError,
    output_frames_to_keep,
    padded_input_frames,
    resolve_source,
    target_dimensions,
)


def test_target_dimensions_preserve_h3_content_bounds() -> None:
    assert target_dimensions(832, 480, "2k") == TargetDimensions(2560, 1478, 3328, 1920, 0, 0)
    assert target_dimensions(1280, 720, "2k") == TargetDimensions(2560, 1440, 5120, 2944, 0, 64)
    assert target_dimensions(1280, 720, "4k") == TargetDimensions(3840, 2160, 5120, 2944, 0, 64)


def test_target_dimensions_reject_4k_for_480p_and_unknown_source_sizes() -> None:
    with pytest.raises(ValidationError):
        target_dimensions(832, 480, "4k")
    with pytest.raises(ValidationError):
        target_dimensions(1920, 1080, "2k")


def test_frame_padding_keeps_the_original_duration_after_trim() -> None:
    padded = padded_input_frames(124)

    assert padded == 129
    assert output_frames_to_keep(124, padded) == 124


def test_frame_padding_meets_the_official_streaming_window_minimum() -> None:
    # FlashVSR's full streaming loop needs at least one 8-frame process window.
    assert padded_input_frames(1) == 25
    assert padded_input_frames(5) == 25
    assert padded_input_frames(21) == 25


def test_source_rejects_traversal_and_non_mp4(output_root: Path) -> None:
    with pytest.raises(ValidationError):
        resolve_source(output_root, SourceRef(filename="../secret.mp4", type="output"))
    with pytest.raises(ValidationError):
        resolve_source(output_root, SourceRef(filename="coffee.mov", type="output"))
    with pytest.raises(ValidationError):
        resolve_source(output_root, SourceRef(filename="coffee.mp4", subfolder="../outside", type="output"))


def test_source_resolves_only_a_safe_comfy_output_file(output_root: Path) -> None:
    assert resolve_source(
        output_root,
        SourceRef(filename="coffee.mp4", subfolder="H3Studio", type="output"),
    ) == (output_root / "H3Studio" / "coffee.mp4").resolve()
