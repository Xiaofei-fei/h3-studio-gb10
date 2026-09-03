import type { GenerationJob, GenerationService } from './types';

export function serviceOf(job: GenerationJob): GenerationService {
  return job.service || 'h3_standard';
}

export function formatOptimizationSummary(job: GenerationJob): string {
  if (serviceOf(job) === 'music3') {
    return `MiniMax Music3${job.musicTiledDecode === false ? '' : ' + 分块音频解码'} + Euler`;
  }
  if (serviceOf(job) === 'fasth3_vsa') {
    const int8 = job.fastH3AdaGemmInt8
      ? ' + AdaGEMM INT8（实验性）'
      : job.fastH3CublasInt8 ? ' + GB10 cuBLAS INT8' : '';
    return `FastH3 VSA${int8}${
      job.fastH3VaeTileBatch ? ' + VAE Tile Batch 4' : ''
    }`;
  }

  const attention = job.spargeAttention === false ? 'Dense' : job.spargeProfile === 'fast' ? 'Sparge Fast' : 'Sparge';
  const int8 = job.h3StandardAdaGemmInt8
    ? ' + AdaGEMM INT8（实验性）'
    : job.h3StandardCublasInt8 ? ' + GB10 cuBLAS INT8' : '';
  const cache = job.easyCache
    ? ' + EasyCache'
    : job.featureCacheSafe
      ? ` + FirstBlockCache ${job.featureCacheProfile === 'aggressive' ? 'Aggressive' : job.featureCacheProfile === 'fast' ? 'Fast' : 'Safe'}`
      : '';
  const turbo = job.turbo8Step ? ' + Turbo 8-step' : '';
  const fused = job.fusedModulation ? ' + Fused Modulation' : '';
  const vaeTileBatch = job.vaeTileBatch ? ' + VAE Tile Batch' : '';
  const sampler = job.samplerName && job.samplerName !== 'res_multistep' ? ` + ${job.samplerName}` : '';
  return `Sage + ${attention}${int8}${turbo}${cache}${fused}${vaeTileBatch}${sampler}`;
}

function fastH3Int8Backend(job: GenerationJob): 'baseline' | 'cublas' | 'adagemm' {
  if (job.fastH3AdaGemmInt8 === true) return 'adagemm';
  return job.fastH3CublasInt8 === true ? 'cublas' : 'baseline';
}

function sameFastH3ExecutionExceptInt8Backend(left: GenerationJob, right: GenerationJob): boolean {
  const leftBackend = fastH3Int8Backend(left);
  const rightBackend = fastH3Int8Backend(right);
  return serviceOf(left) === 'fasth3_vsa'
    && serviceOf(right) === 'fasth3_vsa'
    && left.prompt === right.prompt
    && left.width === right.width
    && left.height === right.height
    && left.seconds === right.seconds
    && left.actualFrames === right.actualFrames
    && left.steps === right.steps
    && left.samplerName === right.samplerName
    && left.seed === right.seed
    && (left.fastH3VaeTileBatch === true) === (right.fastH3VaeTileBatch === true)
    && leftBackend !== rightBackend
    && (leftBackend === 'baseline' || rightBackend === 'baseline');
}

export function findComparableFastH3Job(job: GenerationJob, history: GenerationJob[]): GenerationJob | undefined {
  if (serviceOf(job) !== 'fasth3_vsa') return undefined;
  return history.find((candidate) => candidate.id !== job.id && sameFastH3ExecutionExceptInt8Backend(job, candidate));
}
