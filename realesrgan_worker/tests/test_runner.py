from pathlib import Path

from realesrgan_worker.contracts import TargetDimensions
from realesrgan_worker.runner import (
    DeterministicRunner,
    SourceFacts,
    cleanup_failed_encoder,
    ffmpeg_encode_command,
    partial_video_path,
    readiness_reason,
)


def test_partial_video_path_keeps_a_real_video_suffix() -> None:
    final_path = Path("/comfy-output/H3Studio/upscaled/coffee_up-1.mp4")

    assert partial_video_path(final_path) == Path(
        "/comfy-output/H3Studio/upscaled/.coffee_up-1.partial.mp4"
    )


def test_ffmpeg_streaming_encoder_preserves_audio_and_uses_validated_2k_canvas() -> None:
    command = ffmpeg_encode_command(
        source=Path("/comfy-output/H3Studio/coffee.mp4"),
        facts=SourceFacts(width=832, height=480, fps="24/1", frames=73, has_audio=True),
        dimensions=TargetDimensions(final_width=2560, final_height=1478),
        destination=Path("/work/.coffee.partial.mp4"),
    )

    assert command == [
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", "1664x960", "-framerate", "24/1", "-i", "pipe:0",
        "-i", "/comfy-output/H3Studio/coffee.mp4", "-map", "0:v:0", "-map", "1:a?",
        "-vf", "scale=2560:1478:flags=lanczos", "-c:v", "libx264", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "copy", "/work/.coffee.partial.mp4",
    ]


def test_readiness_allows_the_current_gb10_host_reserve_for_the_6g_streaming_worker(
    monkeypatch,
) -> None:
    import realesrgan_worker.runner as runner

    monkeypatch.setattr(runner, "verified_model_path", lambda _model_dir: Path("/models/RealESRGAN_x2plus.pth"))
    monkeypatch.setattr(runner, "available_memory_bytes", lambda: 18 * 1024 * 1024 * 1024)

    assert readiness_reason(Path("/models")) is None


def test_failed_or_interrupted_encoder_cleans_only_the_partial_video(tmp_path: Path) -> None:
    partial = tmp_path / ".coffee.partial.mp4"
    partial.write_bytes(b"partial")

    class InputPipe:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    class FakeEncoder:
        def __init__(self) -> None:
            self.stdin = InputPipe()
            self.terminated = False
            self.killed = False

        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            self.terminated = True

        def wait(self, timeout: int) -> None:
            assert timeout == 5

        def kill(self) -> None:
            self.killed = True

    encoder = FakeEncoder()
    cleanup_failed_encoder(encoder, partial)

    assert encoder.stdin.closed is True
    assert encoder.terminated is True
    assert encoder.killed is False
    assert partial.exists() is False


def test_parent_cancellation_removes_only_its_owned_published_and_partial_paths(tmp_path: Path) -> None:
    output_root = tmp_path / "comfy-output"
    source = output_root / "H3Studio" / "coffee.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    target_dir = output_root / "H3Studio" / "upscaled"
    target_dir.mkdir(parents=True)
    final = target_dir / "coffee_det-1.mp4"
    partial = target_dir / ".coffee_det-1.partial.mp4"
    unrelated = target_dir / ".coffee_other.partial.mp4"
    final.write_bytes(b"final")
    partial.write_bytes(b"partial")
    unrelated.write_bytes(b"other")

    DeterministicRunner(output_root=output_root, model_dir=tmp_path / "models").cleanup_cancelled_output(
        source,
        "det-1",
    )

    assert final.exists() is False
    assert partial.exists() is False
    assert unrelated.exists() is True
