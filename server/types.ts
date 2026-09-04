export type ResolutionPreset = '480p' | '720p';
export type FeatureCacheProfile = 'safe' | 'fast' | 'aggressive';
export type SpargeProfile = 'balanced' | 'fast';
export type FastH3VaeTileBatchSize = 1 | 2 | 4;
export type SamplerName = 'res_multistep' | 'euler';
export type GenerationService = 'h3_standard' | 'fasth3_vsa' | 'music3';
export type H3InputMode = 'text' | 'keyframes' | 'references';
export type InputAssetKind = 'image' | 'video' | 'audio';
export type UpscaleTarget = '2k' | '4k';
export type UpscaleMethod = 'flashvsr' | 'deterministic';
export type UpscaleState = 'queued' | 'preparing' | 'upscaling' | 'saving' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface InputAsset {
  filename: string;
  subfolder?: string;
  type: 'input';
  kind: InputAssetKind;
}

export interface ServiceCapability {
  available: boolean;
  reason?: string;
}

export interface ComfyServiceCapabilities {
  h3Standard: ServiceCapability;
  h3StandardCublasInt8: ServiceCapability;
  /** Optional so an older H3 Studio origin can roll out safely. */
  h3StandardAdaGemmInt8?: ServiceCapability;
  fastH3Vsa: ServiceCapability;
  /** Optional while an older H3 Studio origin is rolling out. */
  fastH3Gb10VsaKernel?: ServiceCapability;
  fastH3CublasInt8: ServiceCapability;
  /** Optional so an older H3 Studio origin can roll out safely. */
  fastH3AdaGemmInt8?: ServiceCapability;
  /** Optional while an older H3 Studio origin is rolling out. */
  fastH3FusedModulation?: ServiceCapability;
  fastH3VaeTileBatch: ServiceCapability;
  /** Optional for backward compatibility with an older H3 Studio origin. */
  taeH3Preview?: ServiceCapability;
  h3References?: ServiceCapability;
  music3?: ServiceCapability;
  flashVsr?: ServiceCapability & {
    model?: 'flashvsr-v1.1';
    supportedTargets?: UpscaleTarget[];
  };
  deterministicUpscale?: ServiceCapability & {
    model?: 'realesrgan-x2plus-fp16';
    supportedProfiles?: Array<{
      sourceWidth: number;
      sourceHeight: number;
      target: '2k';
      width: number;
      height: number;
    }>;
  };
}

export interface GenerationRequest {
  service: GenerationService;
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  steps: number;
  samplerName: SamplerName;
  seed: number;
  turbo8Step: boolean;
  featureCacheSafe: boolean;
  featureCacheProfile: FeatureCacheProfile;
  easyCache: boolean;
  spargeAttention: boolean;
  spargeProfile: SpargeProfile;
  fusedModulation: boolean;
  vaeTileBatch: boolean;
  h3StandardCublasInt8: boolean;
  h3StandardAdaGemmInt8: boolean;
  fastH3CublasInt8: boolean;
  fastH3AdaGemmInt8: boolean;
  fastH3FusedModulation?: boolean;
  /** Operator-only: emits aggregate CUDA timings for a FastH3 VSA run. */
  fastH3KernelProfile?: boolean;
  /** VSA Fused Layout Engine; available only on GB10. */
  fastH3Gb10VsaKernel?: boolean;
  fastH3VaeTileBatch: boolean;
  fastH3VaeTileBatchSize?: FastH3VaeTileBatchSize;
  taeH3Preview: boolean;
  inputMode: H3InputMode;
  firstFrame?: InputAsset;
  lastFrame?: InputAsset;
  referenceImages: InputAsset[];
  referenceVideos: InputAsset[];
  referenceAudios: InputAsset[];
  referenceImageSize: 'match' | 'max';
  lyrics: string;
  musicTiledDecode: boolean;
}

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export type ComfyPrompt = Record<string, ComfyNode>;

export type JobState =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'sampling'
  | 'decoding'
  | 'saving'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MediaReference {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface VideoEnhancement {
  id: string;
  /** Optional so previously stored browser-session history stays readable. */
  method?: UpscaleMethod;
  target: UpscaleTarget;
  state: UpscaleState;
  width: number;
  height: number;
  totalElapsedMs: number;
  message?: string;
  media?: MediaReference;
}

export interface UpscaleJobSnapshot extends VideoEnhancement {
  sourceJobId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TAEH3PreviewFrame {
  dataUrl: string;
  mime: 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  step: number;
  totalSteps: number;
}

export interface JobSnapshot {
  id: string;
  state: JobState;
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  actualFrames: number;
  actualSeconds: number;
  steps: number;
  samplerName: SamplerName;
  seed: number;
  turbo8Step: boolean;
  featureCacheSafe: boolean;
  featureCacheProfile: FeatureCacheProfile;
  easyCache: boolean;
  spargeAttention: boolean;
  spargeProfile: SpargeProfile;
  fusedModulation: boolean;
  vaeTileBatch: boolean;
  service?: GenerationService;
  h3StandardCublasInt8?: boolean;
  h3StandardAdaGemmInt8?: boolean;
  fastH3Gb10VsaKernel?: boolean;
  fastH3CublasInt8?: boolean;
  fastH3AdaGemmInt8?: boolean;
  fastH3FusedModulation?: boolean;
  fastH3VaeTileBatch?: boolean;
  fastH3VaeTileBatchSize?: FastH3VaeTileBatchSize;
  taeH3Preview?: boolean;
  inputMode?: H3InputMode;
  firstFrame?: InputAsset;
  lastFrame?: InputAsset;
  referenceImages?: InputAsset[];
  referenceVideos?: InputAsset[];
  referenceAudios?: InputAsset[];
  referenceImageSize?: 'match' | 'max';
  lyrics?: string;
  musicTiledDecode?: boolean;
  preview?: TAEH3PreviewFrame;
  step?: number;
  totalSteps?: number;
  elapsedMs?: number;
  totalElapsedMs: number;
  etaSeconds?: number;
  message?: string;
  media?: MediaReference;
  enhancements?: VideoEnhancement[];
  createdAt: string;
  updatedAt: string;
}

export const SUPPORTED_RESOLUTIONS = [
  { id: '480p', label: '480P', width: 832, height: 480 },
  { id: '720p', label: '720P', width: 1280, height: 720 },
] as const;

export const SUPPORTED_STEPS = [6, 10, 15, 20, 25] as const;
