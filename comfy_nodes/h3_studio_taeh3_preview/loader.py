"""A fixed, safe loader for the TAEH3 live-preview decoder.

The H3 model directory may be mounted read-only through ComfyUI's
``--models-directory`` setting.  The small TAEH3 decoder is intentionally
installed under the ComfyUI root instead, so the loader checks both locations
without accepting a user-provided path.
"""

from __future__ import annotations

from functools import lru_cache
import os
from typing import Callable, Mapping, TypeVar


MODEL_NAME = "taeh3_decoder.safetensors"
# Bump this when the node behavior changes; deployment uses it to avoid an
# unnecessary ComfyUI restart for ordinary H3 Studio frontend releases.
NODE_VERSION = "1"
T = TypeVar("T")


def find_tae_path(
    get_full_path: Callable[[str, str], str | None],
    fallback_directory: str,
    *,
    path_exists: Callable[[str], bool] = os.path.isfile,
) -> str:
    """Find the fixed decoder in a registered path or ComfyUI's root models path."""
    registered_path = get_full_path("vae_approx", MODEL_NAME)
    if registered_path and path_exists(registered_path):
        return registered_path

    fallback_path = os.path.join(fallback_directory, MODEL_NAME)
    if path_exists(fallback_path):
        return fallback_path

    raise FileNotFoundError(
        f"未找到 {MODEL_NAME}。请将其安装到 ComfyUI/models/vae_approx/。"
    )


def load_preview_vae(
    model_path: str,
    *,
    load_torch_file: Callable[..., Mapping[str, object]],
    vae_factory: Callable[..., T],
) -> T:
    """Load the decoder through ComfyUI's safe safetensors loader and VAE factory."""
    state_dict = load_torch_file(model_path, safe_load=True)
    return vae_factory(sd=state_dict)


@lru_cache(maxsize=1)
def _load_runtime_preview_vae(model_path: str):
    """Keep the 40 MB preview decoder resident after the first request."""
    import comfy.sd
    import comfy.utils

    return load_preview_vae(
        model_path,
        load_torch_file=comfy.utils.load_torch_file,
        vae_factory=comfy.sd.VAE,
    )


class H3StudioTAEH3PreviewLoader:
    """Expose TAEH3 as an optional ``tiny_vae`` input for PreviewOverride."""

    CATEGORY = "H3 Studio/preview"
    RETURN_TYPES = ("VAE",)
    RETURN_NAMES = ("tiny_vae",)
    FUNCTION = "load_preview_vae"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    @classmethod
    def IS_CHANGED(cls):
        return MODEL_NAME

    def load_preview_vae(self):
        import folder_paths

        comfy_root = os.path.dirname(os.path.abspath(folder_paths.__file__))
        fallback_directory = os.path.join(comfy_root, "models", "vae_approx")
        model_path = find_tae_path(folder_paths.get_full_path, fallback_directory)
        preview_vae = _load_runtime_preview_vae(model_path)
        preview_vae.throw_exception_if_invalid()
        return (preview_vae,)
