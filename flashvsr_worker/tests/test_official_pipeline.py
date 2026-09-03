from pathlib import Path

import pytest

from flashvsr_worker.official_pipeline import (
    OfficialFlashVsrPipeline,
    spatial_tile_tasks,
    streaming_kv_ratio,
)


class _InferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _FakeTorch:
    def inference_mode(self):
        return _InferenceMode()


class _FakePipeline:
    def __init__(self) -> None:
        self.kwargs = None

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return "enhanced-frames"


def test_enhance_uses_the_memory_safe_high_resolution_tile_profile(
    tmp_path: Path,
) -> None:
    adapter = OfficialFlashVsrPipeline(tmp_path)
    pipeline = _FakePipeline()
    adapter._pipeline = pipeline
    adapter._torch = _FakeTorch()

    result = adapter.enhance("lq-video", height=2944, width=5120, num_frames=25)

    assert result == "enhanced-frames"
    assert pipeline.kwargs is not None
    assert pipeline.kwargs["tiled"] is True
    assert pipeline.kwargs["tile_size"] == (120, 208)
    assert pipeline.kwargs["tile_stride"] == (60, 104)


def test_spatial_tile_tasks_match_the_official_wan_vae_boundary_rules() -> None:
    tasks = spatial_tile_tasks(
        latent_height=368,
        latent_width=640,
        tile_size=(120, 208),
        tile_stride=(60, 104),
    )

    assert len(tasks) == 36
    assert tasks[0] == (0, 120, 0, 208)
    assert tasks[-1] == (300, 420, 520, 728)


def test_streaming_kv_ratio_defaults_to_official_and_allows_the_bounded_probe() -> None:
    assert streaming_kv_ratio({}) == 3.0
    assert streaming_kv_ratio({"FLASHVSR_KV_RATIO": "1"}) == 1.0


def test_streaming_kv_ratio_rejects_unsafe_or_malformed_overrides() -> None:
    with pytest.raises(RuntimeError, match="1 到 3"):
        streaming_kv_ratio({"FLASHVSR_KV_RATIO": "0.5"})
    with pytest.raises(RuntimeError, match="数字"):
        streaming_kv_ratio({"FLASHVSR_KV_RATIO": "fast"})
