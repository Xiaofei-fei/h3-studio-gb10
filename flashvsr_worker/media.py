from pathlib import Path, PureWindowsPath

from flashvsr_worker.contracts import SourceRef, TargetDimensions, UpscaleTarget


class ValidationError(ValueError):
    """Raised when a worker request falls outside the local media contract."""


def resolve_source(output_root: Path, ref: SourceRef) -> Path:
    """Resolve only a real MP4 contained by ComfyUI's mounted output directory."""
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
        raise ValidationError("FlashVSR 仅接受 MP4 输出视频。")
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


def target_dimensions(source_width: int, source_height: int, target: UpscaleTarget) -> TargetDimensions:
    if (source_width, source_height) == (832, 480):
        if target != "2k":
            raise ValidationError("480P H3 视频仅支持提升至 2K。")
        return TargetDimensions(2560, 1478, 3328, 1920, 0, 0)
    if (source_width, source_height) == (1280, 720):
        if target == "2k":
            return TargetDimensions(2560, 1440, 5120, 2944, 0, 64)
        if target == "4k":
            return TargetDimensions(3840, 2160, 5120, 2944, 0, 64)
    raise ValidationError("仅支持 832×480 或 1280×720 的 H3 输出视频。")


def padded_input_frames(source_frames: int) -> int:
    if source_frames < 1:
        raise ValidationError("源视频至少需要一帧。")
    # The official full streaming loop computes ``(num_frames - 1) // 8 - 2``
    # process windows, so its first valid 8n+1 input is 25 frames.
    return max(25, ((source_frames + 4 - 1 + 7) // 8) * 8 + 1)


def output_frames_to_keep(source_frames: int, padded_frames: int) -> int:
    if source_frames < 1 or padded_frames < source_frames + 4 or (padded_frames - 1) % 8 != 0:
        raise ValidationError("FlashVSR 帧填充参数不正确。")
    return source_frames
