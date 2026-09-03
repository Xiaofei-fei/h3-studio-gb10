"""Prepare the private GB10 FlashVSR virtual environment.

The deployed Worker receives a copied ComfyUI virtual environment at
``/flashvsr-venv``.  This module is intentionally the only code path allowed
to add FlashVSR packages to that copy; it never writes to the active ComfyUI
environment.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from importlib.util import find_spec
from pathlib import Path


PRIVATE_VENV_ROOT = Path("/flashvsr-venv")
_TORCH_REQUIREMENTS = frozenset({"torch", "torchaudio", "torchvision"})
_GB10_NUMPY_COMPATIBLE_SCIPY = "scipy==1.14.1"
_REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")


def _requirement_name(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("-"):
        return None
    match = _REQUIREMENT_NAME.match(stripped)
    if not match:
        return None
    return match.group(1).lower().replace("_", "-").replace(".", "-")


def filtered_requirements(source: str) -> str:
    kept = [
        line
        for line in source.splitlines()
        if _requirement_name(line) not in _TORCH_REQUIREMENTS
    ]
    # FlashVSR pins NumPy 1.26.4 but leaves SciPy unpinned.  The GB10 base now
    # carries SciPy 1.18, whose NumPy >= 2.0 requirement makes that official
    # pair impossible to resolve.  Keep the newest Python 3.12 wheel that is
    # compatible with the official NumPy pin in the private sidecar only.
    if all(_requirement_name(line) != "scipy" for line in kept):
        kept.append(_GB10_NUMPY_COMPATIBLE_SCIPY)
    return "\n".join(kept) + ("\n" if kept else "")


def _require_private_venv() -> None:
    prefix = Path(sys.prefix).resolve()
    root = PRIVATE_VENV_ROOT.resolve()
    if prefix != root and root not in prefix.parents:
        raise RuntimeError("FlashVSR 依赖安装必须在私有虚拟环境中执行。")


def _run_pip(*arguments: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--no-cache-dir", *arguments],
        check=True,
    )


def _block_sparse_extension_is_installed() -> bool:
    return (
        find_spec("block_sparse_attn") is not None
        and find_spec("block_sparse_attn_cuda") is not None
    )


def install_runtime(repo_dir: Path, worker_dir: Path) -> None:
    _require_private_venv()
    requirements_path = repo_dir / "requirements.txt"
    if not requirements_path.is_file():
        raise RuntimeError("未找到 FlashVSR 官方 requirements.txt。")

    with tempfile.TemporaryDirectory(prefix="flashvsr-requirements-") as temporary_dir:
        filtered_path = Path(temporary_dir) / "requirements.txt"
        filtered_path.write_text(
            filtered_requirements(requirements_path.read_text(encoding="utf-8")),
            encoding="utf-8",
        )
        _run_pip("ninja")
        _run_pip("-r", str(filtered_path))

    # A later model/gate failure must not discard minutes of successful native
    # compilation.  The gate still imports and executes the extension before
    # making the UI available, so this is only a setup-time reuse shortcut.
    if not _block_sparse_extension_is_installed():
        _run_pip("--no-build-isolation", "-v", "/opt/Block-Sparse-Attention")
    # The private environment already owns a compatible setuptools.  Keeping
    # the editable install in that environment avoids an unnecessary isolated
    # PEP 517 build that would otherwise need to fetch setuptools from PyPI.
    _run_pip("--no-deps", "--no-build-isolation", "-e", str(repo_dir))
    _run_pip("-r", str(worker_dir / "requirements.txt"))


def main() -> None:
    repo_dir = Path(os.environ.get("FLASHVSR_REPO", "/opt/FlashVSR"))
    install_runtime(repo_dir, Path(__file__).resolve().parent)


if __name__ == "__main__":
    main()
