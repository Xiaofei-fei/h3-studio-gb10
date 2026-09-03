from pathlib import Path

import pytest

from realesrgan_worker.jobs import JobStore


@pytest.fixture
def output_root(tmp_path: Path) -> Path:
    root = tmp_path / "comfy-output"
    source = root / "H3Studio" / "coffee.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"not-a-real-video")
    return root


@pytest.fixture
def job_store(tmp_path: Path) -> JobStore:
    return JobStore(state_root=tmp_path / "state", work_root=tmp_path / "work")
