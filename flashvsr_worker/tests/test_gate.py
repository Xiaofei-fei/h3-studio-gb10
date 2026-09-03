import sys
from pathlib import Path

from flashvsr_worker import gate
from flashvsr_worker.gate import supports_runtime_python
from flashvsr_worker.official_pipeline import (
    add_official_import_paths,
    official_prompt_tensor_path,
)


def test_gate_accepts_the_official_and_gb10_runtime_versions() -> None:
    assert supports_runtime_python((3, 11)) is True
    assert supports_runtime_python((3, 12)) is True
    assert supports_runtime_python((3, 10)) is False
    assert supports_runtime_python((3, 13)) is False


def test_add_official_import_paths_exposes_wanvsr_utils(
    tmp_path: Path, monkeypatch
) -> None:
    repo_dir = tmp_path / "FlashVSR"
    example_dir = repo_dir / "examples" / "WanVSR"
    (example_dir / "utils").mkdir(parents=True)
    monkeypatch.setattr(sys, "path", [])

    add_official_import_paths(repo_dir)

    assert sys.path[:2] == [str(example_dir), str(repo_dir)]


def test_official_prompt_tensor_path_is_independent_of_working_directory(
    tmp_path: Path, monkeypatch
) -> None:
    repo_dir = tmp_path / "FlashVSR"
    expected = repo_dir / "examples" / "WanVSR" / "prompt_tensor" / "posi_prompt.pth"
    expected.parent.mkdir(parents=True)
    expected.write_bytes(b"official-prompt")
    monkeypatch.chdir(tmp_path)

    assert official_prompt_tensor_path(repo_dir) == expected


def test_720p_gate_only_advertises_the_verified_2k_target(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(gate, "verify_imports", lambda _repo_dir: None)
    monkeypatch.setattr(gate, "verify_assets", lambda _model_dir, _state_dir: None)
    monkeypatch.setattr(gate, "run_tiny", lambda _repo_dir, _model_dir, _state_dir: None)

    async def verify_720p(_repo_dir: Path, _model_dir: Path, _state_dir: Path) -> None:
        return None

    monkeypatch.setattr(gate, "run_gb10_720p", verify_720p)

    result = gate.run_gate(
        state_dir=tmp_path / "state",
        model_dir=tmp_path / "models",
        repo_dir=tmp_path / "repo",
    )

    assert result["available"] is True
    assert result["supportedTargets"] == ["2k"]
