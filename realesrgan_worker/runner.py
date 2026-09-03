"""Subprocess-backed deterministic RealESRGAN x2 video enhancement.

The HTTP process intentionally does not import Torch, PyAV, or Spandrel. A
fresh, tracked child process imports them only when it owns a job, letting a
cancel request terminate the entire inference/FFmpeg process group precisely.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from realesrgan_worker.contracts import (
    MIN_AVAILABLE_MEMORY_BYTES,
    MODEL_FILENAME,
    MODEL_SHA256,
    TILE_OVERLAP,
    TILE_SIZE,
    TargetDimensions,
)
from realesrgan_worker.jobs import JobStore


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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_model_path(model_dir: Path) -> Path:
    root = model_dir.resolve()
    model_path = (root / MODEL_FILENAME).resolve()
    try:
        model_path.relative_to(root)
    except ValueError as error:
        raise RuntimeError("RealESRGAN 模型路径不安全。") from error
    if not model_path.is_file():
        raise RuntimeError("未找到已验证的 RealESRGAN x2 模型。")
    if sha256_file(model_path) != MODEL_SHA256:
        raise RuntimeError("RealESRGAN 模型校验失败。")
    return model_path


def available_memory_bytes() -> int:
    """Return MemAvailable from the host view without importing a GPU package."""
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                fields = line.split()
                if len(fields) >= 2 and fields[1].isdigit():
                    return int(fields[1]) * 1024
    except OSError:
        pass
    return 0


def readiness_reason(model_dir: Path) -> str | None:
    try:
        verified_model_path(model_dir)
    except RuntimeError as error:
        return str(error)
    if available_memory_bytes() < MIN_AVAILABLE_MEMORY_BYTES:
        return "可用系统内存不足，稳定增强需要至少 20 GiB 空闲内存。"
    return None


def ffmpeg_encode_command(
    *,
    source: Path,
    facts: SourceFacts,
    dimensions: TargetDimensions,
    destination: Path,
) -> list[str]:
    """Build the one-pass RGB stream encoder used by the verified profile."""
    native_width = facts.width * 2
    native_height = facts.height * 2
    return [
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{native_width}x{native_height}", "-framerate", facts.fps, "-i", "pipe:0",
        "-i", str(source), "-map", "0:v:0", "-map", "1:a?",
        "-vf", f"scale={dimensions.final_width}:{dimensions.final_height}:flags=lanczos",
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy",
        str(destination),
    ]


def cleanup_failed_encoder(encoder: Any, partial_path: Path) -> None:
    """Stop the worker-owned encoder and remove only its unpublished output."""
    stdin = getattr(encoder, "stdin", None)
    if stdin is not None:
        try:
            stdin.close()
        except OSError:
            pass
    if encoder.poll() is None:
        encoder.terminate()
        try:
            encoder.wait(timeout=5)
        except subprocess.TimeoutExpired:
            encoder.kill()
            encoder.wait(timeout=5)
    partial_path.unlink(missing_ok=True)


class DeterministicRunner:
    def __init__(self, *, output_root: Path, model_dir: Path) -> None:
        self.output_root = output_root.resolve()
        self.model_dir = model_dir.resolve()

    def readiness_reason(self) -> str | None:
        return readiness_reason(self.model_dir)

    def cleanup_cancelled_output(self, source: Path, job_id: str) -> None:
        """Remove only this cancelled job's unpublished output names."""
        _, final_path, partial_path = _safe_output_paths(self.output_root, source, job_id)
        partial_path.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)

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
            [
                "ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=index", "-of", "json", str(source),
            ],
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
        target: str,
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
        process = await job_store.spawn(
            job_id,
            [sys.executable, "-m", "realesrgan_worker.runner", "--task-config", str(config_path)],
        )
        return_code = await process.wait()
        active = job_store.jobs.get(job_id)
        if active is not None and active.state == "cancelling":
            raise asyncio.CancelledError()
        if return_code != 0:
            raise RuntimeError(f"稳定增强子进程退出（状态 {return_code}）。")
        if not result_path.is_file():
            raise RuntimeError("稳定增强未写入已校验的结果描述。")
        payload = json.loads(result_path.read_text(encoding="utf-8"))
        filename = payload.get("filename")
        subfolder = payload.get("subfolder")
        if not isinstance(filename, str) or not isinstance(subfolder, str):
            raise RuntimeError("稳定增强结果描述不完整。")
        output = (self.output_root / subfolder / filename).resolve()
        try:
            output.relative_to(self.output_root)
        except ValueError as error:
            raise RuntimeError("稳定增强返回了不安全的输出路径。") from error
        if not output.is_file() or output.suffix.lower() != ".mp4":
            raise RuntimeError("稳定增强输出视频不存在。")
        return RunResult(filename=filename, subfolder=subfolder)


def _load_model(model_path: Path) -> Any:
    from spandrel import ImageModelDescriptor, ModelLoader

    descriptor = ModelLoader(device="cuda").load_from_file(model_path)
    if not isinstance(descriptor, ImageModelDescriptor):
        raise RuntimeError("RealESRGAN 模型不是图像超分模型。")
    if descriptor.scale != 2:
        raise RuntimeError("RealESRGAN 模型缩放倍率不符合 x2 配置。")
    return descriptor.eval().half()


def _upscale_tiled(model: Any, image: Any) -> Any:
    """Run x2 tiles sequentially, retaining only each tile's overlap-safe centre."""
    import torch

    _, channels, height, width = image.shape
    scale = int(model.scale)
    output = image.new_empty((1, channels, height * scale, width * scale))
    for top in range(0, height, TILE_SIZE):
        bottom = min(top + TILE_SIZE, height)
        source_top = max(0, top - TILE_OVERLAP)
        source_bottom = min(height, bottom + TILE_OVERLAP)
        for left in range(0, width, TILE_SIZE):
            right = min(left + TILE_SIZE, width)
            source_left = max(0, left - TILE_OVERLAP)
            source_right = min(width, right + TILE_OVERLAP)
            tile = image[:, :, source_top:source_bottom, source_left:source_right]
            with torch.inference_mode():
                enhanced = model(tile)
            crop_top = (top - source_top) * scale
            crop_bottom = crop_top + (bottom - top) * scale
            crop_left = (left - source_left) * scale
            crop_right = crop_left + (right - left) * scale
            output[:, :, top * scale:bottom * scale, left * scale:right * scale] = enhanced[
                :, :, crop_top:crop_bottom, crop_left:crop_right
            ]
    return output


def _enhance_rgb_frame(model: Any, rgb: Any) -> Any:
    import torch

    pixels = torch.from_numpy(rgb.copy()).permute(2, 0, 1).unsqueeze(0)
    image = pixels.to(device="cuda", dtype=torch.float16).div_(255.0)
    enhanced = _upscale_tiled(model, image)
    return (
        enhanced.clamp_(0, 1)
        .mul_(255.0)
        .round_()
        .to(dtype=torch.uint8)
        .squeeze(0)
        .permute(1, 2, 0)
        .contiguous()
        .cpu()
        .numpy()
    )


def _verify_output(path: Path, expected: SourceFacts, dimensions: TargetDimensions) -> None:
    facts = DeterministicRunner(output_root=path.parent, model_dir=Path("/")).probe_source(path)
    if (facts.width, facts.height) != (dimensions.final_width, dimensions.final_height):
        raise RuntimeError("输出视频尺寸校验失败。")
    if facts.frames != expected.frames:
        raise RuntimeError("输出视频帧数校验失败。")
    if facts.fps != expected.fps:
        raise RuntimeError("输出视频帧率校验失败。")
    if expected.has_audio and not facts.has_audio:
        raise RuntimeError("输出视频缺少源音频。")


def _safe_output_paths(output_root: Path, source: Path, job_id: str) -> tuple[Path, Path, Path]:
    subfolder = "H3Studio/upscaled"
    target_dir = (output_root / subfolder).resolve()
    try:
        target_dir.relative_to(output_root)
    except ValueError as error:
        raise RuntimeError("输出目录不安全。") from error
    target_dir.mkdir(parents=True, exist_ok=True)
    final_path = target_dir / f"{source.stem}_{job_id}.mp4"
    return target_dir, final_path, partial_video_path(final_path)


def run_task(config_path: Path) -> RunResult:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    source = Path(payload["source"]).resolve()
    facts = SourceFacts(**payload["facts"])
    dimensions = TargetDimensions(**payload["dimensions"])
    model_dir = Path(payload["modelDir"]).resolve()
    output_root = Path(payload["outputRoot"]).resolve()
    result_path = Path(payload["resultPath"]).resolve()
    job_id = str(payload["jobId"])
    work_dir = config_path.parent.resolve()
    if result_path.parent != work_dir:
        raise RuntimeError("结果描述路径不安全。")
    readiness_failure = readiness_reason(model_dir)
    if readiness_failure is not None:
        raise RuntimeError(readiness_failure)
    try:
        source.relative_to(output_root)
    except ValueError as error:
        raise RuntimeError("原始视频路径不安全。") from error

    model = _load_model(verified_model_path(model_dir))
    _, final_path, partial_path = _safe_output_paths(output_root, source, job_id)
    encoder = subprocess.Popen(
        ffmpeg_encode_command(
            source=source,
            facts=facts,
            dimensions=dimensions,
            destination=partial_path,
        ),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    frame_count = 0
    try:
        import av

        container = av.open(str(source))
        try:
            video_stream = container.streams.video[0]
            for frame in container.decode(video_stream):
                enhanced = _enhance_rgb_frame(model, frame.to_ndarray(format="rgb24"))
                if enhanced.shape != (facts.height * 2, facts.width * 2, 3):
                    raise RuntimeError("RealESRGAN 输出帧尺寸不符合 x2 配置。")
                if encoder.stdin is None:
                    raise RuntimeError("FFmpeg 编码管线未就绪。")
                encoder.stdin.write(enhanced.tobytes())
                frame_count += 1
        finally:
            container.close()
        if frame_count != facts.frames:
            raise RuntimeError("解码帧数与 ffprobe 结果不一致。")
        if encoder.stdin is not None:
            encoder.stdin.close()
            encoder.stdin = None
        _, stderr = encoder.communicate()
        if encoder.returncode != 0:
            detail = stderr.decode(errors="replace") if stderr else "FFmpeg 编码失败"
            raise RuntimeError(detail[:240])
        _verify_output(partial_path, facts, dimensions)
        os.replace(partial_path, final_path)
    except BaseException:
        cleanup_failed_encoder(encoder, partial_path)
        raise

    result = RunResult(filename=final_path.name, subfolder="H3Studio/upscaled")
    result_path.write_text(json.dumps(asdict(result)), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-config", required=True)
    arguments = parser.parse_args()
    run_task(Path(arguments.task_config))


if __name__ == "__main__":
    main()
