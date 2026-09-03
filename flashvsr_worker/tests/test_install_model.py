from __future__ import annotations

import sys
from types import ModuleType
from pathlib import Path

from flashvsr_worker.install_model import REQUIRED_MODEL_FILES, install_model


def test_install_model_reuses_complete_pre_staged_assets_without_network(
    tmp_path: Path, monkeypatch
) -> None:
    model_dir = tmp_path / "model"
    state_dir = tmp_path / "state"
    model_dir.mkdir()
    for index, filename in enumerate(REQUIRED_MODEL_FILES, start=1):
        (model_dir / filename).write_bytes(bytes([index]) * index)

    modelscope = ModuleType("modelscope")

    def unexpected_download(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("完整预置模型不应发起网络下载")

    modelscope.snapshot_download = unexpected_download  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "modelscope", modelscope)

    manifest = install_model(model_dir, state_dir)

    assert set(manifest["files"]) == set(REQUIRED_MODEL_FILES)
    assert (state_dir / "model-manifest.json").is_file()
