"""Download and verify the official FlashVSR v1.1 ModelScope asset set."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


MODEL_ID = "AI-ModelScope/FlashVSR"
REQUIRED_MODEL_FILES = (
    "diffusion_pytorch_model_streaming_dmd.safetensors",
    "LQ_proj_in.ckpt",
    "TCDecoder.ckpt",
    "Wan2.1_VAE.pth",
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def _has_complete_required_assets(model_dir: Path) -> bool:
    return all(
        (model_dir / filename).is_file() and (model_dir / filename).stat().st_size > 0
        for filename in REQUIRED_MODEL_FILES
    )


def install_model(model_dir: Path, state_dir: Path) -> dict[str, object]:
    model_dir.mkdir(parents=True, exist_ok=True)
    # A complete ModelScope snapshot may be staged locally and transferred to
    # GB10 when its direct download path is slow.  In that case, preserve the
    # offline deployment guarantee instead of issuing a redundant network call.
    if not _has_complete_required_assets(model_dir):
        from modelscope import snapshot_download

        snapshot_download(MODEL_ID, local_dir=str(model_dir))
    files: dict[str, dict[str, object]] = {}
    for filename in REQUIRED_MODEL_FILES:
        path = model_dir / filename
        if not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"ModelScope 下载后缺少或为空：{filename}")
        files[filename] = {"bytes": path.stat().st_size, "sha256": _sha256(path)}
    manifest: dict[str, object] = {"model": "flashvsr-v1.1", "modelId": MODEL_ID, "files": files}
    _atomic_json(state_dir / "model-manifest.json", manifest)
    return manifest


def main() -> None:
    model_dir = Path(os.environ.get("FLASHVSR_MODEL_DIR", "/models/FlashVSR"))
    state_dir = Path(os.environ.get("FLASHVSR_STATE_DIR", "/state"))
    install_model(model_dir, state_dir)


if __name__ == "__main__":
    main()
