from pathlib import Path, PureWindowsPath

from realesrgan_worker.contracts import SourceRef, ValidationError

__all__ = ["ValidationError", "resolve_source"]


def resolve_source(output_root: Path, ref: SourceRef) -> Path:
    """Resolve only a real MP4 that remains contained by the mounted output root."""
    filename = ref.filename
    subfolder = ref.subfolder
    if (
        ref.type != "output"
        or not filename
        or "/" in filename
        or "\\" in filename
        or ".." in filename
        or Path(filename).is_absolute()
        or PureWindowsPath(filename).is_absolute()
    ):
        raise ValidationError("输出视频引用不安全。")
    if Path(filename).suffix.lower() != ".mp4":
        raise ValidationError("稳定增强仅接受 MP4 输出视频。")
    if subfolder is not None and (
        not subfolder
        or ".." in subfolder
        or "\\" in subfolder
        or Path(subfolder).is_absolute()
        or PureWindowsPath(subfolder).is_absolute()
    ):
        raise ValidationError("输出视频子目录不安全。")

    root = output_root.resolve()
    candidate = (root / subfolder / filename).resolve() if subfolder else (root / filename).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValidationError("输出视频必须位于 ComfyUI 输出目录内。") from error
    if not candidate.is_file():
        raise ValidationError("未找到可增强的原始 MP4 视频。")
    return candidate
