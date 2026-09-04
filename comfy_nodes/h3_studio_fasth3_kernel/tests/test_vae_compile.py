from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vae_compile import inductor_mode_for_allocator, is_supported_h3_video_vae  # noqa: E402


class FastH3VaeCompileTests(unittest.TestCase):
    def test_only_the_minimax_h3_video_vae_is_eligible_for_regional_compilation(self):
        # This would fail if an unrelated VAE were compiled through the H3
        # tile path and produced an incompatible output layout.
        MiniMaxH3VideoVAE = type('MiniMaxH3VideoVAE', (), {'_decode_pixels': lambda self, value: value})
        OtherVideoVAE = type('OtherVideoVAE', (), {})

        self.assertTrue(is_supported_h3_video_vae(MiniMaxH3VideoVAE()))
        self.assertFalse(is_supported_h3_video_vae(OtherVideoVAE()))

    def test_async_cuda_allocator_uses_compile_without_inductor_cudagraph_capture(self):
        # reduce-overhead enables CUDA Graphs, which PyTorch 2.11 rejects with
        # the active cudaMallocAsync allocator on this GB10 service.
        self.assertEqual(inductor_mode_for_allocator('cudaMallocAsync'), 'default')
        self.assertEqual(inductor_mode_for_allocator('native'), 'reduce-overhead')


if __name__ == '__main__':
    unittest.main()
