import pytest

from realesrgan_worker.contracts import (
    MODEL_FILENAME,
    MODEL_SHA256,
    TargetDimensions,
    target_dimensions,
)
from realesrgan_worker.media import ValidationError


def test_verified_h3_canvas_profiles_are_exposed() -> None:
    assert MODEL_FILENAME == "RealESRGAN_x2plus.pth"
    assert MODEL_SHA256 == "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"
    assert target_dimensions(832, 480, "2k") == TargetDimensions(2560, 1478)
    assert target_dimensions(1280, 720, "2k") == TargetDimensions(2560, 1440)
    assert target_dimensions(1344, 768, "2k") == TargetDimensions(2560, 1464)
    assert target_dimensions(1024, 576, "2k") == TargetDimensions(2560, 1440)
    assert target_dimensions(576, 1024, "2k") == TargetDimensions(1440, 2560)
    assert target_dimensions(768, 768, "2k") == TargetDimensions(2048, 2048)


@pytest.mark.parametrize(
    ("width", "height", "target"),
    [(832, 480, "4k"), (1280, 720, "4k"), (1920, 1080, "2k")],
)
def test_unverified_source_or_target_profiles_are_rejected(
    width: int,
    height: int,
    target: str,
) -> None:
    with pytest.raises(ValidationError):
        target_dimensions(width, height, target)
