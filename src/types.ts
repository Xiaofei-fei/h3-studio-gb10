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

export type FeatureCacheProfile = 'safe' | 'fast' | 'aggressive';
export type SpargeProfile = 'balanced' | 'fast';
export type FastH3VaeTileBatchSize = 1 | 2 | 4;
export type SamplerName = 'res_multistep' | 'euler';
export type GenerationService = 'h3_standard' | 'fasth3_vsa' | 'music3';
export type H3InputMode = 'text' | 'keyframes' | 'references';
export type InputAssetKind = 'image' | 'video' | 'audio';
export type OutputAspect = 'landscape' | 'portrait' | 'square';
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
  /** Optional so a browser can still render while an older origin is rolling out. */
  h3StandardAdaGemmInt8?: ServiceCapability;
  fastH3Vsa: ServiceCapability;
  /** Optional so a browser can still render while an older origin is rolling out. */
  fastH3Gb10VsaKernel?: ServiceCapability;
  fastH3CublasInt8: ServiceCapability;
  /** Optional so a browser can still render while an older origin is rolling out. */
  fastH3AdaGemmInt8?: ServiceCapability;
  /** Optional so a browser can still render while an older origin is rolling out. */
  fastH3FusedModulation?: ServiceCapability;
  fastH3VaeTileBatch: ServiceCapability;
  /** Optional so a browser can still render while an older origin is rolling out. */
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

export interface GenerationForm {
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
  fastH3Gb10VsaKernel: boolean;
  fastH3CublasInt8: boolean;
  fastH3AdaGemmInt8: boolean;
  fastH3FusedModulation?: boolean;
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

export interface MediaReference {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface VideoEnhancement {
  id: string;
  /** Optional for browser-session history saved before method tracking existed. */
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

export interface GenerationJob extends Omit<GenerationForm,
  | 'service'
  | 'vaeTileBatch'
  | 'h3StandardCublasInt8'
  | 'h3StandardAdaGemmInt8'
  | 'fastH3Gb10VsaKernel'
  | 'fastH3CublasInt8'
  | 'fastH3AdaGemmInt8'
  | 'fastH3FusedModulation'
  | 'fastH3VaeTileBatch'
  | 'fastH3VaeTileBatchSize'
  | 'taeH3Preview'
  | 'inputMode'
  | 'firstFrame'
  | 'lastFrame'
  | 'referenceImages'
  | 'referenceVideos'
  | 'referenceAudios'
  | 'referenceImageSize'
  | 'lyrics'
  | 'musicTiledDecode'> {
  service?: GenerationService;
  vaeTileBatch?: boolean;
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
  id: string;
  state: JobState;
  actualFrames: number;
  actualSeconds: number;
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

export interface ConnectionStatus {
  connected: boolean;
  deviceName?: string;
  comfyVersion?: string;
  services?: ComfyServiceCapabilities;
}

export const DEFAULT_FORM: GenerationForm = {
  service: 'h3_standard',
  prompt: '',
  width: 1344,
  height: 768,
  seconds: 5,
  steps: 20,
  samplerName: 'res_multistep',
  seed: Math.floor(Math.random() * 4_294_967_296),
  turbo8Step: false,
  featureCacheSafe: false,
  featureCacheProfile: 'safe',
  easyCache: false,
  spargeAttention: true,
  spargeProfile: 'balanced',
  fusedModulation: false,
  vaeTileBatch: false,
  h3StandardCublasInt8: false,
  h3StandardAdaGemmInt8: false,
  fastH3Gb10VsaKernel: false,
  fastH3CublasInt8: false,
  fastH3AdaGemmInt8: false,
  fastH3FusedModulation: false,
  fastH3VaeTileBatch: false,
  fastH3VaeTileBatchSize: undefined,
  taeH3Preview: false,
  inputMode: 'text',
  firstFrame: undefined,
  lastFrame: undefined,
  referenceImages: [],
  referenceVideos: [],
  referenceAudios: [],
  referenceImageSize: 'match',
  lyrics: '',
  musicTiledDecode: true,
};

export const OUTPUT_ASPECT_PRESETS = [
  { id: 'landscape', label: '横屏', detail: '16:9' },
  { id: 'portrait', label: '竖屏', detail: '9:16' },
  { id: 'square', label: '方形', detail: '1:1' },
] as const;

export const RESOLUTION_PRESETS = [
  { id: 'landscape-480p', aspect: 'landscape', label: '480P', detail: '832 × 480 · 低时延', width: 832, height: 480, recommended: false },
  { id: 'landscape-576p', aspect: 'landscape', label: '576P', detail: '1024 × 576 · 均衡', width: 1024, height: 576, recommended: false },
  { id: 'landscape-768p', aspect: 'landscape', label: '768P', detail: '1344 × 768 · H3 原生', width: 1344, height: 768, recommended: true },
  { id: 'portrait-1024p', aspect: 'portrait', label: '1024P', detail: '576 × 1024', width: 576, height: 1024, recommended: true },
  { id: 'square-768p', aspect: 'square', label: '768P', detail: '768 × 768', width: 768, height: 768, recommended: true },
] as const;

export const KEYFRAME_RESOLUTION_PRESETS = RESOLUTION_PRESETS;
export const FASTH3_RESOLUTION_PRESETS = [RESOLUTION_PRESETS[0]] as const;
