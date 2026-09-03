"""Fail-closed compatibility gate for FlashVSR on the GB10 sidecar.

The gate is deliberately more conservative than an import check: the UI is
enabled only after the exact official sparse pipeline has run in the intended
720P profile and the worker's process-group cancellation path has been proved.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

from flashvsr_worker.install_model import REQUIRED_MODEL_FILES
from flashvsr_worker.jobs import JobStore
from flashvsr_worker.media import padded_input_frames, target_dimensions
from flashvsr_worker.official_pipeline import add_official_import_paths
from flashvsr_worker.runner import FlashVsrRunner, SourceFacts


MODEL_NAME = "flashvsr-v1.1"
COMPATIBILITY_FILENAME = "compatibility.json"
SUPPORTED_RUNTIME_PYTHONS = frozenset({(3, 11), (3, 12)})
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_PATH = re.compile(r"(?:(?:[A-Za-z]:)?/(?:[^\s:/]+/?)+)")
_SECRET = re.compile(r"(?i)(token|secret|password|authorization)\s*[=:]\s*[^\s,;]+")


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def supports_runtime_python(version: tuple[int, int]) -> bool:
    return version in SUPPORTED_RUNTIME_PYTHONS


def sanitize(detail: object) -> str:
    text = _CONTROL.sub(" ", str(detail))
    text = _PATH.sub("<path>", text)
    text = _SECRET.sub(r"\1=<redacted>", text)
    text = " ".join(text.split())
    return (text or "未提供详细信息")[:240]


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def load_gate_status(state_dir: Path) -> dict[str, object]:
    path = state_dir / COMPATIBILITY_FILENAME
    if not path.is_file():
        return {
            "available": False,
            "model": MODEL_NAME,
            "supportedTargets": [],
            "reason": "FlashVSR 兼容性门槛尚未执行。",
        }
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "available": False,
            "model": MODEL_NAME,
            "supportedTargets": [],
            "reason": "FlashVSR 兼容性状态文件不可读取。",
        }
    if not isinstance(payload, dict):
        return {
            "available": False,
            "model": MODEL_NAME,
            "supportedTargets": [],
            "reason": "FlashVSR 兼容性状态格式不正确。",
        }
    return {
        "available": payload.get("available") is True,
        "model": MODEL_NAME,
        "supportedTargets": payload.get("supportedTargets") if payload.get("available") is True else [],
        **({"reason": payload["reason"]} if isinstance(payload.get("reason"), str) else {}),
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_imports(repo_dir: Path) -> None:
    if not supports_runtime_python(sys.version_info[:2]):
        raise RuntimeError(
            f"需要 Python 3.11 或 3.12，当前为 {sys.version_info.major}.{sys.version_info.minor}"
        )
    add_official_import_paths(repo_dir)
    import torch
    import block_sparse_attn  # noqa: F401
    from diffsynth import FlashVSRFullPipeline, ModelManager  # noqa: F401
    from utils.utils import Causal_LQ4x_Proj  # noqa: F401

    if not torch.cuda.is_available():
        raise RuntimeError("未检测到可用 CUDA 设备。")


def verify_assets(model_dir: Path, state_dir: Path) -> None:
    manifest_path = state_dir / "model-manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("未找到 ModelScope 资产清单。")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict):
        raise RuntimeError("ModelScope 资产清单格式不正确。")
    for filename in REQUIRED_MODEL_FILES:
        path = model_dir / filename
        entry = files.get(filename)
        if not isinstance(entry, dict) or not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"缺少模型文件：{filename}")
        if entry.get("bytes") != path.stat().st_size or entry.get("sha256") != _sha256(path):
            raise RuntimeError(f"模型文件校验失败：{filename}")


def _make_synthetic_mp4(path: Path, *, width: int, height: int, frames: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi",
        "-i", f"testsrc2=size={width}x{height}:rate=24", "-frames:v", str(frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
    ], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "无法创建合成 MP4").strip())


def run_tiny(repo_dir: Path, model_dir: Path, state_dir: Path) -> None:
    """Exercise LCSA on a small ffprobe-decodable synthetic source."""
    tiny_frames = padded_input_frames(1)
    tiny_source = state_dir / "gate-artifacts" / "tiny.mp4"
    _make_synthetic_mp4(tiny_source, width=128, height=128, frames=tiny_frames)
    facts = FlashVsrRunner(output_root=state_dir, model_dir=model_dir).probe_source(tiny_source)
    if (facts.width, facts.height, facts.frames, facts.fps) != (128, 128, tiny_frames, "24/1"):
        raise RuntimeError("tiny 合成源的 ffprobe 结果不符合预期。")
    import torch
    from flashvsr_worker.official_pipeline import OfficialFlashVsrPipeline

    pipeline = OfficialFlashVsrPipeline(model_dir, repo_dir)
    sample = torch.zeros((1, 3, tiny_frames, 128, 128), dtype=torch.bfloat16, device="cuda")
    result = pipeline.enhance(sample, height=128, width=128, num_frames=tiny_frames)
    if not hasattr(result, "shape"):
        raise RuntimeError("tiny 官方流水线未返回视频张量。")


async def _verify_tracked_child_cancellation(state_dir: Path) -> None:
    store = JobStore(state_dir / "gate-cancel-state", state_dir / "gate-cancel-work")
    store.create("gate-cancel")
    process = await store.spawn(
        "gate-cancel",
        [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    store.request_cancel("gate-cancel")
    try:
        await asyncio.wait_for(process.wait(), timeout=12)
    except asyncio.TimeoutError as error:
        raise RuntimeError("受跟踪子进程未在停止窗口内退出。") from error
    if process.returncode is None:
        raise RuntimeError("受跟踪子进程仍在运行。")
    await store.finish("gate-cancel", "cancelled")


async def run_gb10_720p(repo_dir: Path, model_dir: Path, state_dir: Path) -> None:
    """Run the exact 720P full profile, then prove scoped child cancellation."""
    root = state_dir / "gate-artifacts" / "gb10-720p"
    source = root / "H3Studio" / "gate-720p.mp4"
    _make_synthetic_mp4(source, width=1280, height=720, frames=5)
    runner = FlashVsrRunner(output_root=root, model_dir=model_dir)
    facts = runner.probe_source(source)
    if (facts.width, facts.height, facts.frames, facts.fps) != (1280, 720, 5, "24/1"):
        raise RuntimeError("gb10_720p 合成源的 ffprobe 结果不符合预期。")
    store = JobStore(state_dir / "gate-720-state", state_dir / "gate-720-work")
    store.create("gate-720")
    result = await runner.run(
        job_id="gate-720",
        source=source,
        facts=facts,
        dimensions=target_dimensions(1280, 720, "2k"),
        target="2k",
        job_store=store,
    )
    output = root / result.subfolder / result.filename
    rendered = runner.probe_source(output)
    if (rendered.width, rendered.height, rendered.frames, rendered.fps) != (2560, 1440, 5, "24/1"):
        raise RuntimeError("gb10_720p 输出校验失败。")
    await store.finish("gate-720", "completed")
    await _verify_tracked_child_cancellation(state_dir)


def run_gate(*, state_dir: Path, model_dir: Path, repo_dir: Path) -> dict[str, object]:
    stages: tuple[tuple[str, Callable[[], None]], ...] = (
        ("imports", lambda: verify_imports(repo_dir)),
        ("assets", lambda: verify_assets(model_dir, state_dir)),
        ("tiny", lambda: run_tiny(repo_dir, model_dir, state_dir)),
        ("gb10_720p", lambda: asyncio.run(run_gb10_720p(repo_dir, model_dir, state_dir))),
    )
    for stage, check in stages:
        try:
            check()
        except Exception as error:
            failure = {
                "available": False,
                "model": MODEL_NAME,
                "supportedTargets": [],
                "reason": f"{stage}: {sanitize(error)}",
                "checkedAt": _now(),
            }
            _atomic_json(state_dir / COMPATIBILITY_FILENAME, failure)
            return failure
    # This gate executes the 720P -> 2K profile only.  Do not advertise 4K
    # until it has an independent full-path validation; the API uses this
    # field as an enablement boundary for the frontend.
    success = {
        "available": True,
        "model": MODEL_NAME,
        "supportedTargets": ["2k"],
        "checkedAt": _now(),
    }
    _atomic_json(state_dir / COMPATIBILITY_FILENAME, success)
    return success


def main() -> None:
    state_dir = Path(os.environ.get("FLASHVSR_STATE_DIR", "/state"))
    model_dir = Path(os.environ.get("FLASHVSR_MODEL_DIR", "/models/FlashVSR"))
    repo_dir = Path(os.environ.get("FLASHVSR_REPO", "/opt/FlashVSR"))
    result = run_gate(state_dir=state_dir, model_dir=model_dir, repo_dir=repo_dir)
    print(json.dumps(result, ensure_ascii=False))
    if result.get("available") is not True:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
