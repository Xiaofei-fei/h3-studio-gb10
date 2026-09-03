"""Subprocess-backed execution of the official FlashVSR full pipeline.

The API process only owns state.  Every actual GPU run is a fresh process group
so a cancellation request can terminate precisely that run without ever
touching ComfyUI or another enhancement task.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from flashvsr_worker.contracts import TargetDimensions
from flashvsr_worker.jobs import JobStore
from flashvsr_worker.media import output_frames_to_keep, padded_input_frames


@dataclass(frozen=True)
class SourceFacts:
    width: int
    height: int
    fps: str
    frames: int
    has_audio: bool


@dataclass(frozen=True)
class RunResult:
    filename: str
    subfolder: str


def partial_video_path(final_path: Path) -> Path:
    """Use an atomically replaceable temporary file that FFmpeg recognises."""
    return final_path.with_name(f".{final_path.stem}.partial{final_path.suffix}")


def _run_checked(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, text=True, capture_output=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "未知 FFmpeg 错误").strip().replace("\n", " ")
        raise RuntimeError(detail[:240])
    return result


def _parse_positive_int(value: object) -> int:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit() and int(value) > 0:
        return int(value)
    raise RuntimeError("ffprobe 未返回有效的视频帧数。")


class FlashVsrRunner:
    def __init__(self, *, output_root: Path, model_dir: Path) -> None:
        self.output_root = output_root.resolve()
        self.model_dir = model_dir.resolve()

    def probe_source(self, source: Path) -> SourceFacts:
        payload = _run_checked([
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,nb_read_frames,nb_frames",
            "-of", "json", str(source),
        ])
        streams = json.loads(payload.stdout).get("streams", [])
        if not isinstance(streams, list) or not streams or not isinstance(streams[0], dict):
            raise RuntimeError("ffprobe 未找到视频流。")
        stream = streams[0]
        fps = stream.get("avg_frame_rate")
        if not isinstance(fps, str) or not fps or fps == "0/0":
            raise RuntimeError("ffprobe 未返回有效的视频帧率。")
        frames = _parse_positive_int(stream.get("nb_read_frames") or stream.get("nb_frames"))
        audio_probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "json", str(source)],
            check=False,
            text=True,
            capture_output=True,
        )
        has_audio = False
        if audio_probe.returncode == 0:
            audio_streams = json.loads(audio_probe.stdout).get("streams", [])
            has_audio = isinstance(audio_streams, list) and bool(audio_streams)
        return SourceFacts(
            width=_parse_positive_int(stream.get("width")),
            height=_parse_positive_int(stream.get("height")),
            fps=fps,
            frames=frames,
            has_audio=has_audio,
        )

    async def run(
        self,
        *,
        job_id: str,
        source: Path,
        facts: SourceFacts,
        dimensions: TargetDimensions,
        target: Literal["2k", "4k"],
        job_store: JobStore,
    ) -> RunResult:
        work_dir = job_store.work_dir(job_id)
        config_path = work_dir / "task.json"
        result_path = work_dir / "result.json"
        config_path.write_text(json.dumps({
            "jobId": job_id,
            "source": str(source),
            "facts": asdict(facts),
            "dimensions": asdict(dimensions),
            "target": target,
            "modelDir": str(self.model_dir),
            "outputRoot": str(self.output_root),
            "resultPath": str(result_path),
        }), encoding="utf-8")
        process = await job_store.spawn(job_id, [sys.executable, "-m", "flashvsr_worker.runner", "--task-config", str(config_path)])
        return_code = await process.wait()
        active = job_store.jobs.get(job_id)
        if active is not None and active.state == "cancelling":
            raise asyncio.CancelledError()
        if return_code != 0:
            raise RuntimeError(f"FlashVSR 子进程退出（状态 {return_code}）。")
        if not result_path.is_file():
            raise RuntimeError("FlashVSR 未写入已校验的结果描述。")
        payload = json.loads(result_path.read_text(encoding="utf-8"))
        filename = payload.get("filename")
        subfolder = payload.get("subfolder")
        if not isinstance(filename, str) or not isinstance(subfolder, str):
            raise RuntimeError("FlashVSR 结果描述不完整。")
        output = (self.output_root / subfolder / filename).resolve()
        try:
            output.relative_to(self.output_root)
        except ValueError as error:
            raise RuntimeError("FlashVSR 返回了不安全的输出路径。") from error
        if not output.is_file() or output.suffix.lower() != ".mp4":
            raise RuntimeError("FlashVSR 输出视频不存在。")
        return RunResult(filename=filename, subfolder=subfolder)


def _decode_source_frames(source: Path, frame_dir: Path, expected_count: int) -> list[Path]:
    frame_dir.mkdir(parents=True, exist_ok=True)
    _run_checked([
        "ffmpeg", "-y", "-v", "error", "-i", str(source), "-map", "0:v:0",
        "-vsync", "0", "-frames:v", str(expected_count), str(frame_dir / "%08d.png"),
    ])
    paths = sorted(frame_dir.glob("*.png"))
    if len(paths) < expected_count:
        raise RuntimeError("解码帧数少于源视频帧数。")
    return paths[:expected_count]


def _edge_pad(image: Any, *, width: int, height: int, pad_x: int, pad_y: int) -> Any:
    """Resize at 4× then pad only with source-edge pixels before FlashVSR."""
    from PIL import Image

    resampling = Image.Resampling.LANCZOS
    scaled_width = width - pad_x
    scaled_height = height - pad_y
    scaled = image.resize((scaled_width, scaled_height), resampling)
    if pad_x == 0 and pad_y == 0:
        return scaled
    left = pad_x // 2
    top = pad_y // 2
    canvas = Image.new("RGB", (width, height))
    canvas.paste(scaled, (left, top))
    if top:
        canvas.paste(scaled.crop((0, 0, scaled_width, 1)).resize((scaled_width, top)), (left, 0))
    if pad_y - top:
        bottom_height = pad_y - top
        canvas.paste(
            scaled.crop((0, scaled_height - 1, scaled_width, scaled_height)).resize((scaled_width, bottom_height)),
            (left, top + scaled_height),
        )
    if left:
        canvas.paste(canvas.crop((left, 0, left + 1, height)).resize((left, height)), (0, 0))
    if pad_x - left:
        right_width = pad_x - left
        canvas.paste(
            canvas.crop((left + scaled_width - 1, 0, left + scaled_width, height)).resize((right_width, height)),
            (left + scaled_width, 0),
        )
    return canvas


def _input_tensor(frame_paths: list[Path], dimensions: TargetDimensions) -> Any:
    import numpy as np
    import torch
    from PIL import Image

    tensors = []
    for frame_path in frame_paths:
        with Image.open(frame_path) as frame:
            prepared = _edge_pad(
                frame.convert("RGB"),
                width=dimensions.padded_width,
                height=dimensions.padded_height,
                pad_x=dimensions.pad_x,
                pad_y=dimensions.pad_y,
            )
        pixels = np.asarray(prepared, dtype=np.uint8).copy()
        tensor = torch.from_numpy(pixels).to(device="cuda", dtype=torch.float32)
        tensors.append((tensor.permute(2, 0, 1) / 255.0 * 2.0 - 1.0).to(torch.bfloat16))
    return torch.stack(tensors, 0).permute(1, 0, 2, 3).unsqueeze(0)


def _save_output_frames(
    video: Any,
    destination: Path,
    *,
    dimensions: TargetDimensions,
    source_frames: int,
) -> None:
    import numpy as np
    from PIL import Image

    tensor = video.detach().float().cpu()
    if tensor.ndim == 5:
        tensor = tensor[0]
    if tensor.ndim != 4 or tensor.shape[0] != 3:
        raise RuntimeError("官方 FlashVSR 返回了意外的视频张量形状。")
    if tensor.shape[1] < source_frames:
        raise RuntimeError("官方 FlashVSR 返回的视频帧数不足。")
    destination.mkdir(parents=True, exist_ok=True)
    crop_left = dimensions.pad_x // 2
    crop_top = dimensions.pad_y // 2
    crop_right = dimensions.padded_width - (dimensions.pad_x - crop_left)
    crop_bottom = dimensions.padded_height - (dimensions.pad_y - crop_top)
    for index in range(source_frames):
        image = tensor[:, index].permute(1, 2, 0)
        pixels = ((image + 1.0) * 127.5).clamp(0, 255).numpy().astype(np.uint8)
        frame = Image.fromarray(pixels, mode="RGB")
        frame = frame.crop((crop_left, crop_top, crop_right, crop_bottom))
        frame = frame.resize((dimensions.final_width, dimensions.final_height), Image.Resampling.LANCZOS)
        frame.save(destination / f"{index + 1:08d}.png")


def _verify_output(path: Path, expected: SourceFacts, dimensions: TargetDimensions) -> None:
    facts = FlashVsrRunner(output_root=path.parent, model_dir=Path("/")).probe_source(path)
    if (facts.width, facts.height) != (dimensions.final_width, dimensions.final_height):
        raise RuntimeError("输出视频尺寸校验失败。")
    if facts.frames != expected.frames:
        raise RuntimeError("输出视频帧数校验失败。")
    if facts.fps != expected.fps:
        raise RuntimeError("输出视频帧率校验失败。")
    if expected.has_audio and not facts.has_audio:
        raise RuntimeError("输出视频缺少源音频。")


def run_task(config_path: Path) -> RunResult:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    source = Path(payload["source"]).resolve()
    facts = SourceFacts(**payload["facts"])
    dimensions = TargetDimensions(**payload["dimensions"])
    model_dir = Path(payload["modelDir"])
    output_root = Path(payload["outputRoot"]).resolve()
    result_path = Path(payload["resultPath"]).resolve()
    job_id = str(payload["jobId"])
    work_dir = config_path.parent.resolve()
    if result_path.parent != work_dir:
        raise RuntimeError("结果描述路径不安全。")

    source_frames = _decode_source_frames(source, work_dir / "source-frames", facts.frames)
    padded_count = padded_input_frames(facts.frames)
    padded_paths = source_frames + [source_frames[-1]] * (padded_count - len(source_frames))
    output_frames_to_keep(facts.frames, len(padded_paths))

    lq_video = _input_tensor(padded_paths, dimensions)
    from flashvsr_worker.official_pipeline import OfficialFlashVsrPipeline

    output_video = OfficialFlashVsrPipeline(model_dir).enhance(
        lq_video,
        height=dimensions.padded_height,
        width=dimensions.padded_width,
        num_frames=padded_count,
    )
    rendered_frames = work_dir / "rendered-frames"
    _save_output_frames(output_video, rendered_frames, dimensions=dimensions, source_frames=facts.frames)

    subfolder = "H3Studio/upscaled"
    filename = f"{source.stem}_{job_id}.mp4"
    target_dir = (output_root / subfolder).resolve()
    try:
        target_dir.relative_to(output_root)
    except ValueError as error:
        raise RuntimeError("输出目录不安全。") from error
    target_dir.mkdir(parents=True, exist_ok=True)
    final_path = target_dir / filename
    partial_path = partial_video_path(final_path)
    _run_checked([
        "ffmpeg", "-y", "-v", "error", "-framerate", facts.fps,
        "-i", str(rendered_frames / "%08d.png"), "-i", str(source),
        "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-shortest", str(partial_path),
    ])
    _verify_output(partial_path, facts, dimensions)
    os.replace(partial_path, final_path)
    result = RunResult(filename=filename, subfolder=subfolder)
    result_path.write_text(json.dumps(asdict(result)), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-config", required=True)
    arguments = parser.parse_args()
    run_task(Path(arguments.task_config))


if __name__ == "__main__":
    main()
