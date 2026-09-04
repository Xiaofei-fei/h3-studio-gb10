from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from profiler import (  # noqa: E402
    CANONICAL_STAGES,
    ProfileAccumulator,
    make_profiled_vsa_forward,
)


class FastH3ProfilerTests(unittest.TestCase):
    def test_profile_measure_returns_the_original_result_and_only_aggregate_metadata(self):
        # This would fail if profiling changed a forward result or started
        # serializing prompt/tensor contents instead of aggregate telemetry.
        profiler = ProfileAccumulator(enabled=True, elapsed_ms=lambda: 2.5)

        result = profiler.measure(
            "qkv",
            shape=(124, 3072, 4096),
            callback=lambda: {"forward": "result"},
        )

        self.assertEqual(result, {"forward": "result"})
        self.assertEqual(profiler.records(), [{
            "stage": "qkv",
            "shape": [124, 3072, 4096],
            "count": 1,
            "cuda_ms": 2.5,
            "fallback_count": 0,
        }])

    def test_disabled_profiler_runs_work_without_emitting_records(self):
        # This would fail if an opt-out request still paid aggregation/logging cost.
        profiler = ProfileAccumulator(enabled=False, elapsed_ms=lambda: 99.0)

        self.assertEqual(
            profiler.measure("vsa", shape=(64, 32, 128), callback=lambda: "same-output"),
            "same-output",
        )
        self.assertEqual(profiler.records(), [])

    def test_snapshot_contains_every_canonical_stage_without_raw_request_data(self):
        # This would fail if a report omitted a stage or accepted arbitrary payload keys.
        profiler = ProfileAccumulator(enabled=True, elapsed_ms=lambda: 1.0)
        profiler.measure("gate", shape=(124, 4096, 3072), callback=lambda: None)
        snapshot = profiler.snapshot()

        self.assertEqual([entry["stage"] for entry in snapshot], list(CANONICAL_STAGES))
        gate = next(entry for entry in snapshot if entry["stage"] == "gate")
        self.assertEqual(gate, {
            "stage": "gate",
            "shape": [124, 4096, 3072],
            "count": 1,
            "cuda_ms": 1.0,
            "fallback_count": 0,
        })
        self.assertTrue(all(set(entry) == {
            "stage", "shape", "count", "cuda_ms", "fallback_count",
        } for entry in snapshot))

    def test_unrecognised_attention_forward_keeps_its_original_result_without_timing(self):
        # This would fail if the profiler tried to emulate an unknown attention
        # implementation instead of safely preserving its exact original path.
        calls = []

        class Recorder:
            def measure(self, stage, *, shape, callback):
                calls.append((stage, tuple(shape)))
                return callback()

        def ordinary_forward(x, rope_freqs=None, transformer_options={}):
            return (x, rope_freqs, transformer_options)

        profiled = make_profiled_vsa_forward(ordinary_forward, Recorder())

        self.assertEqual(
            profiled("original", rope_freqs="rope", transformer_options={"key": "value"}),
            ("original", "rope", {"key": "value"}),
        )
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
