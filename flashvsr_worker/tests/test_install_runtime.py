from flashvsr_worker import install_runtime as runtime
from flashvsr_worker.install_runtime import filtered_requirements


def test_filtered_requirements_preserves_official_packages_but_not_torch_wheels() -> None:
    result = filtered_requirements(
        "torch==2.6.0+cu124\n"
        "torchaudio==2.6.0+cu124\n"
        "torchvision==0.21.0+cu124\n"
        "accelerate==1.8.1\n"
    )

    assert result == "accelerate==1.8.1\nscipy==1.14.1\n"


def test_installer_reuses_the_private_pep517_toolchain(tmp_path, monkeypatch) -> None:
    repo_dir = tmp_path / "FlashVSR"
    worker_dir = tmp_path / "worker"
    repo_dir.mkdir()
    worker_dir.mkdir()
    (repo_dir / "requirements.txt").write_text("accelerate==1.8.1\n", encoding="utf-8")
    (worker_dir / "requirements.txt").write_text("", encoding="utf-8")
    calls: list[tuple[str, ...]] = []

    monkeypatch.setattr(runtime, "_require_private_venv", lambda: None)
    monkeypatch.setattr(runtime, "_run_pip", lambda *arguments: calls.append(arguments))
    monkeypatch.setattr(runtime, "_block_sparse_extension_is_installed", lambda: True)

    runtime.install_runtime(repo_dir, worker_dir)

    assert ("--no-deps", "--no-build-isolation", "-e", str(repo_dir)) in calls
    assert ("--no-build-isolation", "-v", "/opt/Block-Sparse-Attention") not in calls
