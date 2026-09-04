import { describe, expect, it } from 'vitest';
import { findComparableFastH3Job, formatOptimizationSummary } from '../src/optimization';
import type { GenerationJob } from '../src/types';

const fastH3Baseline: GenerationJob = {
  id: 'baseline',
  state: 'completed',
  service: 'fasth3_vsa',
  prompt: 'A cinematic cup of coffee with gentle steam',
  width: 832,
  height: 480,
  seconds: 5,
  actualFrames: 124,
  actualSeconds: 5.17,
  steps: 4,
  samplerName: 'euler',
  seed: 42,
  turbo8Step: false,
  featureCacheSafe: false,
  featureCacheProfile: 'safe',
  easyCache: false,
  spargeAttention: false,
  spargeProfile: 'balanced',
  fusedModulation: false,
  vaeTileBatch: false,
  fastH3CublasInt8: false,
  fastH3VaeTileBatch: true,
  totalElapsedMs: 63_000,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:01:03.000Z',
};

const fastH3Optimized: GenerationJob = {
  ...fastH3Baseline,
  id: 'optimized',
  fastH3CublasInt8: true,
  totalElapsedMs: 55_000,
  createdAt: '2026-09-02T00:02:00.000Z',
  updatedAt: '2026-09-02T00:02:55.000Z',
};

const fastH3AdaGemm: GenerationJob = {
  ...fastH3Baseline,
  id: 'adagemm',
  fastH3AdaGemmInt8: true,
  totalElapsedMs: 56_000,
  createdAt: '2026-09-03T00:02:00.000Z',
  updatedAt: '2026-09-03T00:02:56.000Z',
};

const standardJob: GenerationJob = {
  ...fastH3Baseline,
  id: 'standard',
  service: 'h3_standard',
  steps: 20,
  samplerName: 'res_multistep',
  spargeAttention: true,
  fastH3VaeTileBatch: false,
};

describe('FastH3 result summaries', () => {
  it('labels a FastH3 run from the active optimization switches instead of a profile name', () => {
    expect(formatOptimizationSummary(fastH3Optimized)).toBe(
      'FastH3 VSA + GB10 cuBLAS INT8 + VAE Tile Batch 4',
    );
  });

  it('labels AdaGEMM as an experimental FastH3 optimization', () => {
    expect(formatOptimizationSummary(fastH3AdaGemm)).toBe(
      'FastH3 VSA + AdaGEMM INT8（实验性） + VAE Tile Batch 4',
    );
    expect(formatOptimizationSummary({ ...standardJob, h3StandardAdaGemmInt8: true })).toBe(
      'Sage + Sparge + AdaGEMM INT8（实验性）',
    );
  });

  it('does not treat TAEH3 preview as an inference optimization', () => {
    expect(formatOptimizationSummary({ ...standardJob, taeH3Preview: true })).toBe('Sage + Sparge');
    expect(formatOptimizationSummary({ ...fastH3Optimized, taeH3Preview: true })).toBe(
      'FastH3 VSA + GB10 cuBLAS INT8 + VAE Tile Batch 4',
    );
  });

  it('finds a FastH3 counterpart only when cuBLAS is the sole execution difference', () => {
    expect(findComparableFastH3Job(fastH3Optimized, [fastH3Baseline])?.id).toBe('baseline');
    expect(findComparableFastH3Job(fastH3Optimized, [{ ...fastH3Baseline, seed: 43 }])).toBeUndefined();
  });

  it('compares an AdaGEMM run to the baseline but not to a cuBLAS run', () => {
    expect(findComparableFastH3Job(fastH3AdaGemm, [fastH3Baseline])?.id).toBe('baseline');
    expect(findComparableFastH3Job(fastH3AdaGemm, [fastH3Optimized])).toBeUndefined();
  });

  it('keeps FastH3 Fused Modulation and VAE batch choices out of an INT8-only comparison', () => {
    const fusedBatchTwo: GenerationJob = {
      ...fastH3Optimized,
      fastH3FusedModulation: true,
      fastH3VaeTileBatchSize: 2,
    };

    expect(formatOptimizationSummary(fusedBatchTwo)).toBe(
      'FastH3 VSA + GB10 cuBLAS INT8 + Fused Modulation + VAE Tile Batch 2',
    );
    expect(findComparableFastH3Job(fusedBatchTwo, [fastH3Baseline])).toBeUndefined();
  });

  it('labels the VSA layout engine without appending its lossless property to the name', () => {
    const fusedLayout: GenerationJob = {
      ...fastH3Optimized,
      fastH3Gb10VsaKernel: true,
    };

    expect(formatOptimizationSummary(fusedLayout)).toBe(
      'FastH3 VSA + VSA Fused Layout Engine + GB10 cuBLAS INT8 + VAE Tile Batch 4',
    );
    expect(findComparableFastH3Job(fusedLayout, [fastH3Baseline])).toBeUndefined();
  });
});
