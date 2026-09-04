import { randomUUID } from 'node:crypto';
import {
  SUPPORTED_RESOLUTIONS,
  SUPPORTED_STEPS,
  type ComfyPrompt,
  type FeatureCacheProfile,
  type FastH3VaeTileBatchSize,
  type GenerationService,
  type GenerationRequest,
  type H3InputMode,
  type InputAsset,
  type InputAssetKind,
  type SamplerName,
  type SpargeProfile,
} from './types.js';

const VIDEO_VAE = 'minimax_h3_video_vae_fp16.safetensors';
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors';
const DIFFUSION_MODEL = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const REFERENCE_DIFFUSION_MODEL = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
const TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const MUSIC3_DIFFUSION_MODEL = 'minimax_music3_dit_fp16.safetensors';
const MUSIC3_TEXT_ENCODER = 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors';
const MUSIC3_VAE = 'minimax_music3_dav.safetensors';
const MUSIC3_STEPS = 30;
const MUSIC3_CFG = 1.7;
const MUSIC3_TOP_K = 250;
const MUSIC3_TILE_SIZE = 512;
const MUSIC3_TILE_OVERLAP = 64;
const TURBO_LORA = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors';
const TURBO_STEPS = 8;
const FASTH3_STEPS = 4;
const FASTH3_VSA_LORA = 'fasth3_vsa_4-steps-v5.safetensors';
const FASTH3_VSA_GATE = 'fasth3_vsa_gate.safetensors';
const VIDEO_VAE_TILE_BATCH_SIZE = 2;
const FASTH3_VIDEO_VAE_TILE_BATCH_SIZE = 4;
const EASY_CACHE_SETTINGS = {
  reuseThreshold: 0.2,
  startPercent: 0.15,
  endPercent: 0.95,
} as const;

const FEATURE_CACHE_PRESETS: Record<FeatureCacheProfile, {
  mode: string;
  threshold: number;
  startPercent: number;
  endPercent: number;
  maxConsecutiveHits: number;
}> = {
  safe: {
    mode: 'H3 Safe — 0.08 / max 2',
    threshold: 0.08,
    startPercent: 0.1,
    endPercent: 0.95,
    maxConsecutiveHits: 2,
  },
  fast: {
    mode: 'H3 Fast — 0.10 / max 2',
    threshold: 0.1,
    startPercent: 0.1,
    endPercent: 0.95,
    maxConsecutiveHits: 2,
  },
  aggressive: {
    mode: 'H3 Aggressive — 0.12 / max 2',
    threshold: 0.12,
    startPercent: 0.1,
    endPercent: 0.95,
    maxConsecutiveHits: 2,
  },
};

const SPARGE_PRESETS: Record<SpargeProfile, { routingValue: number; videoRoutingValue: number }> = {
  balanced: { routingValue: 0.15, videoRoutingValue: 0.12 },
  fast: { routingValue: 0.1, videoRoutingValue: 0.08 },
};

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('请求格式不正确，请重新填写生成参数。');
  }
  return input as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${label}不正确，请重新选择。`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, label: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new InputError(`${label}不正确，请重新选择。`);
  }
  return value;
}

function asOptionalFastH3VaeTileBatchSize(value: unknown): FastH3VaeTileBatchSize | undefined {
  if (value === undefined) return undefined;
  if (value === 1 || value === 2 || value === 4) return value;
  throw new InputError('FastH3 VAE Tile Batch 档位不正确，请重新选择。');
}

function asFeatureCacheProfile(value: unknown): FeatureCacheProfile {
  if (value === undefined) return 'safe';
  if (value === 'safe' || value === 'fast' || value === 'aggressive') return value;
  throw new InputError('Feature Cache 档位不正确，请重新选择。');
}

function asGenerationService(value: unknown): GenerationService {
  if (value === undefined) return 'h3_standard';
  if (value === 'h3_standard' || value === 'fasth3_vsa' || value === 'music3') return value;
  throw new InputError('推理服务不正确，请重新选择。');
}

function asSamplerName(value: unknown): SamplerName {
  if (value === undefined) return 'res_multistep';
  if (value === 'res_multistep' || value === 'euler') return value;
  throw new InputError('采样器不正确，请重新选择。');
}

function asSpargeProfile(value: unknown): SpargeProfile {
  if (value === undefined) return 'balanced';
  if (value === 'balanced' || value === 'fast') return value;
  throw new InputError('SpargeAttention 档位不正确，请重新选择。');
}

function asInputMode(value: unknown): H3InputMode {
  if (value === undefined) return 'text';
  if (value === 'text' || value === 'keyframes' || value === 'references') return value;
  throw new InputError('输入模式不正确，请重新选择。');
}

function asReferenceImageSize(value: unknown): 'match' | 'max' {
  if (value === undefined) return 'match';
  if (value === 'match' || value === 'max') return value;
  throw new InputError('参考图像尺寸策略不正确，请重新选择。');
}

function asInputAsset(value: unknown, kind: InputAssetKind, label: string): InputAsset {
  const record = asRecord(value);
  const filename = typeof record.filename === 'string' ? record.filename : '';
  const type = record.type;
  const assetKind = record.kind;
  const subfolder = record.subfolder;
  const unsafeName = !filename || filename.length > 180 || filename.includes('..') || filename.includes('/') || filename.includes('\\');
  if (unsafeName || type !== 'input' || assetKind !== kind) {
    throw new InputError(`${label}不正确，请重新上传后再试。`);
  }
  if (subfolder !== undefined && (typeof subfolder !== 'string' || subfolder.includes('..') || subfolder.startsWith('/') || subfolder.includes('\\'))) {
    throw new InputError(`${label}不正确，请重新上传后再试。`);
  }
  return {
    filename,
    type: 'input',
    kind,
    subfolder: typeof subfolder === 'string' && subfolder ? subfolder : undefined,
  };
}

function asOptionalInputAsset(value: unknown, kind: InputAssetKind, label: string): InputAsset | undefined {
  return value === undefined || value === null ? undefined : asInputAsset(value, kind, label);
}

function asInputAssets(value: unknown, kind: InputAssetKind, label: string, max: number): InputAsset[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError(`${label}不正确，请重新上传后再试。`);
  if (value.length > max) throw new InputError(`${label}最多可添加 ${max} 个。`);
  return value.map((asset, index) => asInputAsset(asset, kind, `${label} ${index + 1}`));
}

function inputFilename(asset: InputAsset): string {
  return asset.subfolder ? `${asset.subfolder}/${asset.filename}` : asset.filename;
}

export function calculateFrameLength(seconds: number): number {
  const rawFrames = Math.max(5, Math.round(seconds * 24));
  return rawFrames + ((5 - (rawFrames % 17)) % 17);
}

export function calculateActualSeconds(seconds: number): number {
  return Number((calculateFrameLength(seconds) / 24).toFixed(2));
}

export function normalizeGenerationRequest(input: unknown): GenerationRequest {
  const value = asRecord(input);
  const service = asGenerationService(value.service);
  const inputMode = asInputMode(value.inputMode);
  if (service === 'music3' && inputMode !== 'text') {
    throw new InputError('MiniMax Music3 不支持视频参考输入。');
  }
  if (service === 'fasth3_vsa' && inputMode !== 'text') {
    throw new InputError('FastH3 VSA 当前只支持纯文本视频生成。');
  }
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!prompt) {
    throw new InputError(service === 'music3' ? '请先描述您想生成的音乐。' : '请先描述您想生成的视频内容。');
  }
  if (prompt.length > 4000) {
    throw new InputError('提示词请控制在 4000 个字符以内。');
  }

  const width = asFiniteNumber(value.width, '清晰度');
  const height = asFiniteNumber(value.height, '清晰度');
  const isSupportedResolution = SUPPORTED_RESOLUTIONS.some(
    (resolution) => resolution.width === width && resolution.height === height,
  );
  if (!isSupportedResolution) {
    throw new InputError('当前演示仅支持 480P 或 720P。');
  }

  const seconds = asFiniteNumber(value.seconds, service === 'music3' ? '音乐时长' : '视频时长');
  const minimumSeconds = service === 'music3' ? 5 : 3;
  const maximumSeconds = service === 'music3' ? 300 : 15;
  if (!Number.isInteger(seconds) || seconds < minimumSeconds || seconds > maximumSeconds) {
    throw new InputError(service === 'music3' ? '音乐时长可设置为 5 到 300 秒。' : '视频时长可设置为 3 到 15 秒。');
  }

  const requestedSteps = asFiniteNumber(value.steps, '采样步数');
  const requestedTurbo8Step = asOptionalBoolean(value.turbo8Step, 'Turbo LoRA 8 steps');
  const turbo8Step = service === 'h3_standard' && inputMode !== 'references' ? requestedTurbo8Step : false;
  if (service === 'h3_standard' && !turbo8Step && !SUPPORTED_STEPS.includes(requestedSteps as (typeof SUPPORTED_STEPS)[number])) {
    throw new InputError('采样步数可选择 6、10、15、20 或 25。');
  }
  const requestedSamplerName = asSamplerName(value.samplerName);
  const steps = service === 'music3' ? MUSIC3_STEPS : service === 'fasth3_vsa' ? FASTH3_STEPS : turbo8Step ? TURBO_STEPS : requestedSteps;
  const samplerName = service === 'music3' || service === 'fasth3_vsa' ? 'euler' : requestedSamplerName;

  const seed = asFiniteNumber(value.seed, '随机种子');
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new InputError('随机种子不正确，请重新生成。');
  }

  const featureCacheSafe = asOptionalBoolean(value.featureCacheSafe, 'Feature Cache Safe');
  const featureCacheProfile = asFeatureCacheProfile(value.featureCacheProfile);
  const easyCache = asOptionalBoolean(value.easyCache, 'EasyCache');
  if (service === 'h3_standard' && featureCacheSafe && easyCache) {
    throw new InputError('EasyCache 与 FirstBlockCache 不能同时开启。');
  }
  const spargeAttention = asOptionalBoolean(value.spargeAttention, 'SpargeAttention', true);
  const spargeProfile = asSpargeProfile(value.spargeProfile);
  const fusedModulation = asOptionalBoolean(value.fusedModulation, 'Fused Modulation');
  const vaeTileBatch = asOptionalBoolean(value.vaeTileBatch, 'VAE Tile Batch');
  const requestedH3StandardCublasInt8 = asOptionalBoolean(value.h3StandardCublasInt8, 'H3 Standard GB10 cuBLAS INT8');
  const requestedH3StandardAdaGemmInt8 = asOptionalBoolean(value.h3StandardAdaGemmInt8, 'H3 Standard AdaGEMM INT8');
  const requestedFastH3CublasInt8 = asOptionalBoolean(value.fastH3CublasInt8, 'FastH3 GB10 cuBLAS INT8');
  const requestedFastH3AdaGemmInt8 = asOptionalBoolean(value.fastH3AdaGemmInt8, 'FastH3 AdaGEMM INT8');
  const requestedFastH3FusedModulation = asOptionalBoolean(value.fastH3FusedModulation, 'FastH3 Fused Modulation');
  const requestedFastH3KernelProfile = asOptionalBoolean(value.fastH3KernelProfile, 'FastH3 kernel profiling');
  const requestedFastH3Gb10VsaKernel = asOptionalBoolean(value.fastH3Gb10VsaKernel, 'VSA Fused Layout Engine');
  const fastH3VaeTileBatch = asOptionalBoolean(value.fastH3VaeTileBatch, 'FastH3 VAE Tile Batch');
  const requestedFastH3VaeTileBatchSize = asOptionalFastH3VaeTileBatchSize(value.fastH3VaeTileBatchSize);
  const taeH3Preview = asOptionalBoolean(value.taeH3Preview, 'TAEH3 实时预览');
  const h3StandardCublasInt8 = service === 'h3_standard' ? requestedH3StandardCublasInt8 : false;
  const h3StandardAdaGemmInt8 = service === 'h3_standard' ? requestedH3StandardAdaGemmInt8 : false;
  const fastH3CublasInt8 = service === 'fasth3_vsa' ? requestedFastH3CublasInt8 : false;
  const fastH3AdaGemmInt8 = service === 'fasth3_vsa' ? requestedFastH3AdaGemmInt8 : false;
  const fastH3FusedModulation = service === 'fasth3_vsa' ? requestedFastH3FusedModulation : false;
  const fastH3KernelProfile = service === 'fasth3_vsa' ? requestedFastH3KernelProfile : false;
  const fastH3Gb10VsaKernel = service === 'fasth3_vsa' ? requestedFastH3Gb10VsaKernel : false;
  const fastH3VaeTileBatchEnabled = service === 'fasth3_vsa'
    && (fastH3VaeTileBatch || requestedFastH3VaeTileBatchSize !== undefined);
  if (h3StandardCublasInt8 && h3StandardAdaGemmInt8) {
    throw new InputError('H3 Standard 不能同时启用 GB10 cuBLAS INT8 与 AdaGEMM INT8。');
  }
  if (fastH3CublasInt8 && fastH3AdaGemmInt8) {
    throw new InputError('FastH3 不能同时启用 GB10 cuBLAS INT8 与 AdaGEMM INT8。');
  }
  if (fastH3KernelProfile && fastH3Gb10VsaKernel) {
    throw new InputError('FastH3 kernel profiling 与 VSA Fused Layout Engine 不能同时启用。');
  }
  const firstFrame = inputMode === 'keyframes' ? asOptionalInputAsset(value.firstFrame, 'image', '首帧') : undefined;
  const lastFrame = inputMode === 'keyframes' ? asOptionalInputAsset(value.lastFrame, 'image', '尾帧') : undefined;
  if (inputMode === 'keyframes' && !firstFrame) {
    throw new InputError('首尾帧模式需要先添加首帧。');
  }
  const referenceImages = inputMode === 'references'
    ? asInputAssets(value.referenceImages, 'image', '参考图片', 9)
    : [];
  const referenceVideos = inputMode === 'references'
    ? asInputAssets(value.referenceVideos, 'video', '参考视频', 3)
    : [];
  const referenceAudios = inputMode === 'references'
    ? asInputAssets(value.referenceAudios, 'audio', '参考音频', 3)
    : [];
  if (inputMode === 'references' && referenceImages.length + referenceVideos.length + referenceAudios.length === 0) {
    throw new InputError('多模态参考模式至少添加一个图片、视频或音频参考。');
  }
  const referenceImageSize = asReferenceImageSize(value.referenceImageSize);
  const lyrics = typeof value.lyrics === 'string' ? value.lyrics.trim() : '';
  if (lyrics.length > 8000) {
    throw new InputError('歌词请控制在 8000 个字符以内。');
  }
  const musicTiledDecode = asOptionalBoolean(value.musicTiledDecode, 'Music3 分块音频解码', true);

  return {
    service,
    prompt,
    width,
    height,
    seconds,
    steps,
    samplerName,
    seed,
    turbo8Step,
    featureCacheSafe: service === 'h3_standard' ? featureCacheSafe : false,
    featureCacheProfile,
    easyCache: service === 'h3_standard' ? easyCache : false,
    spargeAttention: service === 'h3_standard' ? spargeAttention : false,
    spargeProfile,
    fusedModulation: service === 'h3_standard' ? fusedModulation : false,
    vaeTileBatch: service === 'h3_standard' ? vaeTileBatch : false,
    h3StandardCublasInt8,
    h3StandardAdaGemmInt8,
    fastH3CublasInt8,
    fastH3AdaGemmInt8,
    fastH3FusedModulation,
    fastH3KernelProfile,
    fastH3Gb10VsaKernel,
    fastH3VaeTileBatch: fastH3VaeTileBatchEnabled,
    fastH3VaeTileBatchSize: fastH3VaeTileBatchEnabled ? requestedFastH3VaeTileBatchSize ?? FASTH3_VIDEO_VAE_TILE_BATCH_SIZE : undefined,
    taeH3Preview: service === 'music3' ? false : taeH3Preview,
    inputMode,
    firstFrame,
    lastFrame,
    referenceImages,
    referenceVideos,
    referenceAudios,
    referenceImageSize,
    lyrics,
    musicTiledDecode,
  };
}

export function buildH3Workflow(request: GenerationRequest): ComfyPrompt {
  if (request.service === 'music3') return buildMusic3Workflow(request);
  // Comfy's intermediate-output cache otherwise reuses an identical sampler
  // result for a repeated prompt/seed, which makes an A/B run look faster
  // without executing the DiT. The unknown RandomNoise input is deliberately
  // ignored by the node implementation but included in Comfy's cache key.
  const runNonce = randomUUID();
  return request.service === 'fasth3_vsa'
    ? buildFastH3VsaWorkflow(request, runNonce)
    : buildStandardH3Workflow(request, runNonce);
}

function buildStandardH3Workflow(request: GenerationRequest, runNonce: string): ComfyPrompt {
  const length = calculateFrameLength(request.seconds);
  const cachePreset = FEATURE_CACHE_PRESETS[request.featureCacheProfile];
  const spargePreset = SPARGE_PRESETS[request.spargeProfile];
  const baseModelInput: [string, number] = request.turbo8Step ? ['17', 0] : ['1', 0];
  const modelAfterCache: [string, number] = request.featureCacheSafe
    ? ['16', 0]
    : request.easyCache
      ? ['19', 0]
      : baseModelInput;
  const modelAfterFusedModulation: [string, number] = request.fusedModulation ? ['18', 0] : modelAfterCache;
  const modelAfterSparge: [string, number] = request.spargeAttention ? ['2', 0] : modelAfterFusedModulation;
  const modelInput: [string, number] = request.h3StandardCublasInt8 || request.h3StandardAdaGemmInt8
    ? ['20', 0]
    : modelAfterSparge;
  const modelWithPreview: [string, number] = request.taeH3Preview ? ['91', 0] : modelInput;
  const turboNode: ComfyPrompt = request.turbo8Step
    ? {
        '17': {
          class_type: 'LoraLoaderModelOnly',
          inputs: {
            model: ['1', 0],
            lora_name: TURBO_LORA,
            strength_model: 1,
          },
        },
      }
    : {};
  const cacheNode: ComfyPrompt = request.featureCacheSafe
    ? {
        '16': {
          class_type: 'ApplyMiniMaxH3FirstBlockCache',
          inputs: {
            model: baseModelInput,
            mode: cachePreset.mode,
            threshold: cachePreset.threshold,
            start_percent: cachePreset.startPercent,
            end_percent: cachePreset.endPercent,
            max_consecutive_hits: cachePreset.maxConsecutiveHits,
            temporal_guard: false,
          },
        },
    }
    : {};
  const easyCacheNode: ComfyPrompt = request.easyCache
    ? {
        '19': {
          class_type: 'EasyCache',
          inputs: {
            model: baseModelInput,
            reuse_threshold: EASY_CACHE_SETTINGS.reuseThreshold,
            start_percent: EASY_CACHE_SETTINGS.startPercent,
            end_percent: EASY_CACHE_SETTINGS.endPercent,
            verbose: false,
          },
        },
      }
    : {};
  const fusedModulationNode: ComfyPrompt = request.fusedModulation
    ? {
        '18': {
          class_type: 'MiniMaxH3FusedModulation',
          inputs: {
            model: modelAfterCache,
            enabled: true,
          },
        },
      }
    : {};
  const spargeNode: ComfyPrompt = request.spargeAttention
    ? {
        '2': {
          class_type: 'H3SpargeAttention',
          inputs: {
            model: modelAfterFusedModulation,
            routing_mode: 'topk',
            routing_value: spargePreset.routingValue,
            similarity_threshold: 0.1,
            block_size: '64',
            min_seq_len: 8192,
            dense_last_steps: 1,
            protect_audio: true,
            enabled: true,
            kernel_impl: 'branch_map',
            selector_impl: 'topk_fast',
            multimodal_mode: 'legacy_uniform',
            video_routing_value: spargePreset.videoRoutingValue,
            video_similarity_threshold: 0.1,
            dense_backend: 'inherit',
          },
        },
    }
    : {};
  const cublasNode: ComfyPrompt = request.h3StandardCublasInt8
    ? {
        '20': {
          class_type: 'MiniMaxH3GB10CublasInt8',
          inputs: {
            model: modelAfterSparge,
            enabled: true,
            scope: 'qkv_out_mlp',
            force_full_load: false,
            allow_standard: true,
          },
        },
    }
    : request.h3StandardAdaGemmInt8
      ? {
          '20': {
            class_type: 'MiniMaxH3GB10AdaGemmInt8',
            inputs: {
              model: modelAfterSparge,
              enabled: true,
              scope: 'qkv_out_mlp',
            },
          },
        }
      : {};
  const taePreviewNode: ComfyPrompt = request.taeH3Preview
    ? {
        '90': {
          class_type: 'H3StudioTAEH3PreviewLoader',
          inputs: {},
        },
        '91': {
          class_type: 'MiniMaxH3PreviewOverride',
          inputs: {
            model: modelInput,
            max_resolution: 720,
            jpeg_quality: 80,
            suppress_default_preview: true,
            preview_frames: 1,
            preview_fps: 12,
            tiny_vae: ['90', 0],
            vae_name: 'taeh3_decoder.safetensors',
          },
        },
    }
    : {};
  const inputNodes: ComfyPrompt = {};
  const conditioningInputs: Record<string, unknown> = {
    clip: ['4', 0],
    vae: ['5', 0],
    prompt: request.prompt,
    width: request.width,
    height: request.height,
    length,
  };
  let conditioningClass = 'MiniMaxH3ImageToVideo';

  if (request.inputMode === 'keyframes') {
    inputNodes['30'] = {
      class_type: 'LoadImage',
      inputs: { image: inputFilename(request.firstFrame!) },
    };
    conditioningInputs.first_frame = ['30', 0];
    if (request.lastFrame) {
      inputNodes['31'] = {
        class_type: 'LoadImage',
        inputs: { image: inputFilename(request.lastFrame) },
      };
      conditioningInputs.last_frame = ['31', 0];
    }
  }

  if (request.inputMode === 'references') {
    conditioningClass = 'MiniMaxH3ReferenceToVideo';
    conditioningInputs.audio_vae = ['6', 0];
    conditioningInputs.ref_image_size = request.referenceImageSize;
    let nodeId = 40;
    request.referenceImages.forEach((asset, index) => {
      const id = String(nodeId++);
      inputNodes[id] = { class_type: 'LoadImage', inputs: { image: inputFilename(asset) } };
      conditioningInputs[`ref_images.ref_image_${index}`] = [id, 0];
    });
    request.referenceVideos.forEach((asset, index) => {
      const videoId = String(nodeId++);
      const componentsId = String(nodeId++);
      inputNodes[videoId] = { class_type: 'LoadVideo', inputs: { video: inputFilename(asset) } };
      inputNodes[componentsId] = { class_type: 'GetVideoComponents', inputs: { video: [videoId, 0] } };
      conditioningInputs[`ref_videos.ref_video_${index}`] = [componentsId, 0];
      conditioningInputs[`ref_video_audios.ref_video_audio_${index}`] = [componentsId, 1];
    });
    request.referenceAudios.forEach((asset, index) => {
      const id = String(nodeId++);
      inputNodes[id] = { class_type: 'LoadAudio', inputs: { audio: inputFilename(asset) } };
      conditioningInputs[`ref_audios.ref_audio_${index}`] = [id, 0];
    });
  }

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: request.inputMode === 'references' ? REFERENCE_DIFFUSION_MODEL : DIFFUSION_MODEL, weight_dtype: 'default' },
    },
    ...turboNode,
    ...cacheNode,
    ...easyCacheNode,
    ...fusedModulationNode,
    ...spargeNode,
    ...cublasNode,
    ...taePreviewNode,
    '3': {
      class_type: 'BasicScheduler',
      inputs: { model: modelWithPreview, scheduler: 'simple', steps: request.steps, denoise: 1 },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: TEXT_ENCODER, type: 'minimax', device: 'default' },
    },
    '5': {
      class_type: 'VAELoader',
      inputs: { vae_name: VIDEO_VAE },
    },
    '6': {
      class_type: 'VAELoader',
      inputs: { vae_name: AUDIO_VAE },
    },
    ...inputNodes,
    '7': {
      class_type: conditioningClass,
      inputs: conditioningInputs,
    },
    '8': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: request.seed, h3_studio_run_nonce: runNonce },
    },
    '9': {
      class_type: 'KSamplerSelect',
      inputs: { sampler_name: request.samplerName },
    },
    '10': {
      class_type: 'BasicGuider',
      inputs: { model: modelWithPreview, conditioning: ['7', 0] },
    },
    '11': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['8', 0],
        guider: ['10', 0],
        sampler: ['9', 0],
        sigmas: ['3', 0],
        latent_image: ['7', 1],
      },
    },
    '12': {
      class_type: request.vaeTileBatch ? 'MiniMaxH3VAEDecodeBatched' : 'VAEDecode',
      inputs: request.vaeTileBatch
        ? { samples: ['11', 0], vae: ['5', 0], tile_batch_size: VIDEO_VAE_TILE_BATCH_SIZE }
        : { samples: ['11', 0], vae: ['5', 0] },
    },
    '13': {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['11', 0], vae: ['6', 0] },
    },
    '14': {
      class_type: 'CreateVideo',
      inputs: { images: ['12', 0], audio: ['13', 0], fps: 24, bit_depth: 8 },
    },
    '15': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['14', 0],
        filename_prefix: 'H3Studio/H3_%date:yyyy-MM-dd_hh-mm-ss%',
        format: 'mp4',
        codec: 'auto',
      },
    },
  };
}

function buildMusic3Workflow(request: GenerationRequest): ComfyPrompt {
  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: MUSIC3_DIFFUSION_MODEL, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: MUSIC3_TEXT_ENCODER, type: 'minimax', device: 'default' },
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: MUSIC3_VAE },
    },
    '4': {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: {
        clip: ['2', 0],
        caption: request.prompt,
        lyrics: request.lyrics,
        seed: request.seed,
        max_duration: request.seconds,
        cfg_scale: MUSIC3_CFG,
        top_k: MUSIC3_TOP_K,
      },
    },
    '5': {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['4', 0] },
    },
    '6': {
      class_type: 'EmptyMiniMaxMusic3LatentAudio',
      inputs: { seconds: ['4', 1], batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        seed: request.seed,
        steps: MUSIC3_STEPS,
        cfg: MUSIC3_CFG,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        denoise: 1,
      },
    },
    '8': request.musicTiledDecode
      ? {
          class_type: 'VAEDecodeAudioTiled',
          inputs: {
            samples: ['7', 0],
            vae: ['3', 0],
            tile_size: MUSIC3_TILE_SIZE,
            overlap: MUSIC3_TILE_OVERLAP,
          },
        }
      : {
          class_type: 'VAEDecodeAudio',
          inputs: { samples: ['7', 0], vae: ['3', 0] },
        },
    '9': {
      class_type: 'SaveAudioMP3',
      inputs: {
        audio: ['8', 0],
        filename_prefix: 'H3Studio/Music3_%date:yyyy-MM-dd_hh-mm-ss%',
        quality: '320k',
      },
    },
  };
}

function buildFastH3VsaWorkflow(request: GenerationRequest, runNonce: string): ComfyPrompt {
  const length = calculateFrameLength(request.seconds);
  const modelAfterVsa: [string, number] = ['2', 0];
  const modelAfterFusedModulation: [string, number] = request.fastH3FusedModulation ? ['18', 0] : modelAfterVsa;
  const modelAfterInt8: [string, number] = request.fastH3CublasInt8 || request.fastH3AdaGemmInt8
    ? ['21', 0]
    : modelAfterFusedModulation;
  // The packer captures the active QKV/out-projection methods.  Keep it after
  // an INT8 node so it retains the selected GEMM implementation instead of
  // closing over the pre-patched attention modules.
  const modelAfterGb10Vsa: [string, number] = request.fastH3Gb10VsaKernel ? ['23', 0] : modelAfterInt8;
  const modelAfterProfile: [string, number] = request.fastH3KernelProfile ? ['22', 0] : modelAfterGb10Vsa;
  const modelInput: [string, number] = modelAfterProfile;
  const fusedModulationNode: ComfyPrompt = request.fastH3FusedModulation
    ? {
        '18': {
          class_type: 'MiniMaxH3FusedModulation',
          inputs: { model: modelAfterVsa, enabled: true },
        },
      }
    : {};
  const profileNode: ComfyPrompt = request.fastH3KernelProfile
    ? {
        '22': {
          class_type: 'H3StudioFastH3Profile',
          inputs: { model: modelAfterGb10Vsa, enabled: true, expected_calls: 200 },
        },
      }
    : {};
  const gb10VsaNode: ComfyPrompt = request.fastH3Gb10VsaKernel
    ? {
        '23': {
          class_type: 'H3StudioFastH3GB10VSA',
          inputs: { model: modelAfterInt8, enabled: true },
        },
      }
    : {};
  const modelWithPreview: [string, number] = request.taeH3Preview ? ['91', 0] : modelInput;
  const cublasNode: ComfyPrompt = request.fastH3CublasInt8
    ? {
        '21': {
          class_type: 'MiniMaxH3GB10CublasInt8',
          inputs: {
            model: modelAfterFusedModulation,
            enabled: true,
            scope: 'qkv_out_mlp',
            force_full_load: false,
            allow_standard: false,
          },
        },
    }
    : request.fastH3AdaGemmInt8
      ? {
          '21': {
          class_type: 'MiniMaxH3GB10AdaGemmInt8',
          inputs: {
            model: modelAfterFusedModulation,
              enabled: true,
              scope: 'qkv_out_mlp',
            },
          },
        }
      : {};
  const taePreviewNode: ComfyPrompt = request.taeH3Preview
    ? {
        '90': {
          class_type: 'H3StudioTAEH3PreviewLoader',
          inputs: {},
        },
        '91': {
          class_type: 'MiniMaxH3PreviewOverride',
          inputs: {
            model: modelInput,
            max_resolution: 720,
            jpeg_quality: 80,
            suppress_default_preview: true,
            preview_frames: 1,
            preview_fps: 12,
            tiny_vae: ['90', 0],
            vae_name: 'taeh3_decoder.safetensors',
          },
        },
      }
    : {};
  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: DIFFUSION_MODEL, weight_dtype: 'default' },
    },
    '17': {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['1', 0],
        lora_name: FASTH3_VSA_LORA,
        strength_model: 1,
      },
    },
    '2': {
      class_type: 'H3VSA',
      inputs: {
        model: ['17', 0],
        gate_file: FASTH3_VSA_GATE,
        topk_ratio: 0.1,
        min_tokens: 4096,
        gate_residency: 'resident',
      },
    },
    ...gb10VsaNode,
    ...profileNode,
    ...fusedModulationNode,
    ...cublasNode,
    ...taePreviewNode,
    '3': {
      class_type: 'BasicScheduler',
      inputs: { model: modelWithPreview, scheduler: 'simple', steps: FASTH3_STEPS, denoise: 1 },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: TEXT_ENCODER, type: 'minimax', device: 'default' },
    },
    '5': {
      class_type: 'VAELoader',
      inputs: { vae_name: VIDEO_VAE },
    },
    '6': {
      class_type: 'VAELoader',
      inputs: { vae_name: AUDIO_VAE },
    },
    '7': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['4', 0],
        vae: ['5', 0],
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        length,
      },
    },
    '8': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: request.seed, h3_studio_run_nonce: runNonce },
    },
    '9': {
      class_type: 'KSamplerSelect',
      inputs: { sampler_name: 'euler' },
    },
    '10': {
      class_type: 'BasicGuider',
      inputs: { model: modelWithPreview, conditioning: ['7', 0] },
    },
    '11': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['8', 0],
        guider: ['10', 0],
        sampler: ['9', 0],
        sigmas: ['3', 0],
        latent_image: ['7', 1],
      },
    },
    '12': {
      class_type: request.fastH3VaeTileBatch ? 'MiniMaxH3VAEDecodeBatched' : 'VAEDecode',
      inputs: request.fastH3VaeTileBatch
        ? { samples: ['11', 0], vae: ['5', 0], tile_batch_size: request.fastH3VaeTileBatchSize ?? FASTH3_VIDEO_VAE_TILE_BATCH_SIZE }
        : { samples: ['11', 0], vae: ['5', 0] },
    },
    '13': {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['11', 0], vae: ['6', 0] },
    },
    '14': {
      class_type: 'CreateVideo',
      inputs: { images: ['12', 0], audio: ['13', 0], fps: 24, bit_depth: 8 },
    },
    '15': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['14', 0],
        filename_prefix: 'H3Studio/FastH3_%date:yyyy-MM-dd_hh-mm-ss%',
        format: 'mp4',
        codec: 'auto',
      },
    },
  };
}
