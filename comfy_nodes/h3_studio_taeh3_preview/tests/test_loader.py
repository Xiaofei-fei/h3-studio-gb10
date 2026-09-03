from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loader import find_tae_path, load_preview_vae  # noqa: E402


class TAEH3PreviewLoaderTests(unittest.TestCase):
    def test_prefers_the_registered_vae_approx_path(self):
        path = find_tae_path(
            lambda category, name: "/registered/taeh3_decoder.safetensors",
            "/fallback",
            path_exists=lambda candidate: candidate.startswith("/registered/"),
        )

        self.assertEqual(path, "/registered/taeh3_decoder.safetensors")

    def test_uses_comfy_root_fallback_when_the_models_directory_is_read_only(self):
        path = find_tae_path(
            lambda category, name: None,
            "/comfy/mnt/ComfyUI/models/vae_approx",
            path_exists=lambda candidate: candidate == "/comfy/mnt/ComfyUI/models/vae_approx/taeh3_decoder.safetensors",
        )

        self.assertEqual(path, "/comfy/mnt/ComfyUI/models/vae_approx/taeh3_decoder.safetensors")

    def test_loads_the_fixed_decoder_with_the_comfy_vae_factory(self):
        loaded_paths = []
        state = {"taehv_decoder.conv_in.weight": object()}
        created = []

        vae = load_preview_vae(
            "/comfy/mnt/ComfyUI/models/vae_approx/taeh3_decoder.safetensors",
            load_torch_file=lambda path, safe_load: loaded_paths.append((path, safe_load)) or state,
            vae_factory=lambda *, sd: created.append(sd) or "preview-vae",
        )

        self.assertEqual(vae, "preview-vae")
        self.assertEqual(loaded_paths, [
            ("/comfy/mnt/ComfyUI/models/vae_approx/taeh3_decoder.safetensors", True),
        ])
        self.assertEqual(created, [state])


if __name__ == "__main__":
    unittest.main()
