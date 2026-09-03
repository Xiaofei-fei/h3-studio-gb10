from pathlib import Path
from types import SimpleNamespace

from flashvsr_worker import runner
from flashvsr_worker.runner import _decode_source_frames, partial_video_path


def test_partial_video_path_keeps_a_real_video_suffix() -> None:
    final_path = Path("/comfy-output/H3Studio/upscaled/coffee_up-1.mp4")

    assert partial_video_path(final_path) == Path(
        "/comfy-output/H3Studio/upscaled/.coffee_up-1.partial.mp4"
    )


def test_decode_source_frames_stops_after_the_requested_frame_count(
    tmp_path: Path, monkeypatch
) -> None:
    commands: list[list[str]] = []

    def fake_run_checked(command: list[str]) -> SimpleNamespace:
        commands.append(command)
        pattern = Path(command[-1])
        for index in range(1, 4):
            Path(str(pattern).replace("%08d", f"{index:08d}")).touch()
        return SimpleNamespace()

    monkeypatch.setattr(runner, "_run_checked", fake_run_checked)

    frames = _decode_source_frames(tmp_path / "source.mp4", tmp_path / "frames", 3)

    assert len(frames) == 3
    assert commands == [[
        "ffmpeg", "-y", "-v", "error", "-i", str(tmp_path / "source.mp4"),
        "-map", "0:v:0", "-vsync", "0", "-frames:v", "3",
        str(tmp_path / "frames" / "%08d.png"),
    ]]
