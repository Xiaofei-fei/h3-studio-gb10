from pathlib import Path

import pytest

from realesrgan_worker.contracts import SourceRef
from realesrgan_worker.media import ValidationError, resolve_source


def test_source_resolves_only_a_safe_comfy_output_mp4(output_root: Path) -> None:
    assert resolve_source(
        output_root,
        SourceRef(filename="coffee.mp4", subfolder="H3Studio", type="output"),
    ) == (output_root / "H3Studio" / "coffee.mp4").resolve()


@pytest.mark.parametrize(
    "source",
    [
        SourceRef(filename="../secret.mp4", type="output"),
        SourceRef(filename="folder/coffee.mp4", type="output"),
        SourceRef(filename="C:\\secret.mp4", type="output"),
        SourceRef(filename="coffee.mov", type="output"),
        SourceRef(filename="coffee.mp4", subfolder="../outside", type="output"),
        SourceRef(filename="coffee.mp4", subfolder="H3Studio", type="input"),
    ],
)
def test_source_rejects_unsafe_or_non_output_references(
    output_root: Path,
    source: SourceRef,
) -> None:
    with pytest.raises(ValidationError):
        resolve_source(output_root, source)
