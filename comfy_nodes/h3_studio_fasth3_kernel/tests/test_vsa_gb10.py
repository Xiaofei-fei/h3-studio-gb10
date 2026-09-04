from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vsa_gb10 import (  # noqa: E402
    gate_source_offset,
    hsd_destination_offset,
    hsd_source_offset,
    padded_token_count,
    qkv_source_offset,
    select_projection_forward,
)


class FastH3GB10VSAPackTests(unittest.TestCase):
    def test_fused_pack_uses_the_same_qkv_and_gate_row_major_addresses_as_the_reference_path(self):
        # This would fail if a fused pack mixed Q/K/V planes, heads, or token rows.
        heads = 2
        head_dim = 4
        token = 2
        head = 1
        dim = 3

        self.assertEqual(qkv_source_offset(token, 0, head, dim, heads, head_dim), 55)
        self.assertEqual(qkv_source_offset(token, 1, head, dim, heads, head_dim), 63)
        self.assertEqual(qkv_source_offset(token, 2, head, dim, heads, head_dim), 71)
        self.assertEqual(gate_source_offset(token, head, dim, heads, head_dim), 23)

    def test_fused_pack_writes_hsd_layout_and_zero_padded_tail_without_reallocating_an_intermediate(self):
        # This would fail if the destination kept the source [S,H,D] layout or
        # calculated a padded stride from the unpadded token count.
        padded = padded_token_count(5, 4)

        self.assertEqual(padded, 8)
        self.assertEqual(hsd_destination_offset(2, 1, 3, heads=2, head_dim=4, padded_tokens=padded), 43)
        self.assertEqual(hsd_destination_offset(7, 1, 3, heads=2, head_dim=4, padded_tokens=padded), 63)

    def test_aligned_token_count_does_not_add_a_spurious_padding_block(self):
        # This would fail if the fast path changed the exact block count/top-k input.
        self.assertEqual(padded_token_count(128, 64), 128)
        self.assertEqual(padded_token_count(129, 64), 192)

    def test_fused_pack_honours_post_norm_tensor_strides_instead_of_assuming_qkv_storage(self):
        # This would fail if a no-RoPE attention path read stale Q/K values from
        # the original QKV allocation after RMSNorm returned a new tensor.
        self.assertEqual(hsd_source_offset(2, 1, 3, stride_s=24, stride_h=4, stride_d=1), 55)
        self.assertEqual(hsd_source_offset(2, 1, 3, stride_s=8, stride_h=4, stride_d=1), 23)

    def test_fused_vsa_uses_a_model_patched_projection_callable_when_one_is_supplied(self):
        # This would fail if the fused attention closure called the captured
        # pre-patch module and silently bypassed cuBLASLt INT8.
        def dense(value):
            return f"dense:{value}"

        def cublas_int8(value):
            return f"int8:{value}"

        self.assertEqual(select_projection_forward(dense, cublas_int8)('qkv'), 'int8:qkv')
        self.assertEqual(select_projection_forward(dense, None)('qkv'), 'dense:qkv')

if __name__ == "__main__":
    unittest.main()
