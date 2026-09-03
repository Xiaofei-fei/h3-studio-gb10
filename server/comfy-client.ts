import WebSocket from 'ws';
import type { ComfyPrompt, ComfyServiceCapabilities, InputAsset, InputAssetKind } from './types.js';

export interface ComfyHealth {
  connected: boolean;
  deviceName?: string;
  comfyVersion?: string;
  services?: ComfyServiceCapabilities;
}

export interface ComfyEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ComfyCancellation {
  state: 'cancelled' | 'cancelling' | 'rejected';
  message?: string;
}

export interface ComfyInputUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  kind: InputAssetKind;
}

export interface ComfyClient {
  health(): Promise<ComfyHealth>;
  enqueue(prompt: ComfyPrompt, clientId: string): Promise<{ promptId: string }>;
  cancel(promptId: string): Promise<ComfyCancellation>;
  getHistory(promptId: string): Promise<unknown | null>;
  openEvents(promptId: string, clientId: string, listener: (event: ComfyEvent) => void): () => void;
  getMedia(query: URLSearchParams, range?: string): Promise<Response | null>;
  uploadInput(asset: ComfyInputUpload): Promise<InputAsset>;
}

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}

export class HttpComfyClient implements ComfyClient {
  constructor(private readonly baseUrl = 'http://127.0.0.1:8188') {}

  async health(): Promise<ComfyHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { connected: false };
      const stats = await response.json() as {
        system?: { comfyui_version?: string };
        devices?: Array<{ name?: string }>;
      };
      const [
        h3Vsa,
        loraLoader,
        cublasInt8,
        adaGemmInt8,
        fusedModulation,
        vaeDecodeBatched,
        taePreviewOverride,
        taePreviewLoader,
        h3Reference,
        loadImage,
        loadVideo,
        getVideoComponents,
        loadAudio,
        unetLoader,
        clipLoader,
        vaeLoader,
        musicTextEncode,
        musicLatent,
        conditioningZeroOut,
        kSampler,
        vaeDecodeAudio,
        vaeDecodeAudioTiled,
        saveAudioMp3,
      ] = await Promise.all([
        this.objectInfo('H3VSA'),
        this.objectInfo('LoraLoaderModelOnly'),
        this.objectInfo('MiniMaxH3GB10CublasInt8'),
        this.objectInfo('MiniMaxH3GB10AdaGemmInt8'),
        this.objectInfo('MiniMaxH3FusedModulation'),
        this.objectInfo('MiniMaxH3VAEDecodeBatched'),
        this.objectInfo('MiniMaxH3PreviewOverride'),
        this.objectInfo('H3StudioTAEH3PreviewLoader'),
        this.objectInfo('MiniMaxH3ReferenceToVideo'),
        this.objectInfo('LoadImage'),
        this.objectInfo('LoadVideo'),
        this.objectInfo('GetVideoComponents'),
        this.objectInfo('LoadAudio'),
        this.objectInfo('UNETLoader'),
        this.objectInfo('CLIPLoader'),
        this.objectInfo('VAELoader'),
        this.objectInfo('MiniMaxMusic3TextEncode'),
        this.objectInfo('EmptyMiniMaxMusic3LatentAudio'),
        this.objectInfo('ConditioningZeroOut'),
        this.objectInfo('KSampler'),
        this.objectInfo('VAEDecodeAudio'),
        this.objectInfo('VAEDecodeAudioTiled'),
        this.objectInfo('SaveAudioMP3'),
      ]);
      return {
        connected: true,
        deviceName: stats.devices?.[0]?.name,
        comfyVersion: stats.system?.comfyui_version,
        services: detectServiceCapabilities({
          h3Vsa,
          loraLoader,
          cublasInt8,
          adaGemmInt8,
          fusedModulation,
          vaeDecodeBatched,
          taePreviewOverride,
          taePreviewLoader,
          h3Reference,
          loadImage,
          loadVideo,
          getVideoComponents,
          loadAudio,
          unetLoader,
          clipLoader,
          vaeLoader,
          musicTextEncode,
          musicLatent,
          conditioningZeroOut,
          kSampler,
          vaeDecodeAudio,
          vaeDecodeAudioTiled,
          saveAudioMp3,
        }),
      };
    } catch {
      return { connected: false };
    }
  }

  private async objectInfo(nodeClass: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${this.baseUrl}/object_info/${encodeURIComponent(nodeClass)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  async enqueue(prompt: ComfyPrompt, clientId: string): Promise<{ promptId: string }> {
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({})) as {
      prompt_id?: string;
      error?: { message?: string };
      node_errors?: Record<string, unknown>;
    };
    if (!response.ok || !payload.prompt_id) {
      const reason = payload.error?.message || (payload.node_errors ? '工作流校验未通过' : '提交失败');
      throw new Error(reason);
    }
    return { promptId: payload.prompt_id };
  }

  async cancel(promptId: string): Promise<ComfyCancellation> {
    const response = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return this.cancelLegacyPrompt(promptId);
    if (!response.ok) {
      throw new Error(`停止请求失败（${response.status}）`);
    }
    return { state: 'cancelling' };
  }

  private async cancelLegacyPrompt(promptId: string): Promise<ComfyCancellation> {
    const queue = await this.getQueue();
    if (!this.isPending(queue, promptId)) return this.cancelRunningPrompt(queue, promptId);

    const response = await fetch(`${this.baseUrl}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`排队任务停止失败（${response.status}）`);

    const remainingQueue = await this.getQueue();
    if (!this.isPending(remainingQueue, promptId) && !this.isRunning(remainingQueue, promptId)) {
      return { state: 'cancelled', message: '已从等待队列移除。' };
    }
    return this.cancelRunningPrompt(remainingQueue, promptId);
  }

  private async cancelRunningPrompt(queue: unknown, promptId: string): Promise<ComfyCancellation> {
    if (!this.isRunning(queue, promptId)) {
      return {
        state: 'rejected',
        message: '当前任务不在本服务可安全停止的队列中。',
      };
    }
    const response = await fetch(`${this.baseUrl}/interrupt`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`停止正在执行的任务失败（${response.status}）`);
    return { state: 'cancelling', message: '已请求停止正在执行的任务。' };
  }

  private async getQueue(): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/queue`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`无法读取生成队列（${response.status}）`);
    return response.json();
  }

  private isPending(queue: unknown, promptId: string): boolean {
    if (!queue || typeof queue !== 'object') return false;
    const pending = (queue as { queue_pending?: unknown }).queue_pending;
    return Array.isArray(pending) && pending.some((item) => this.queuePromptId(item) === promptId);
  }

  private isRunning(queue: unknown, promptId: string): boolean {
    if (!queue || typeof queue !== 'object') return false;
    const running = (queue as { queue_running?: unknown }).queue_running;
    return Array.isArray(running) && running.some((item) => this.queuePromptId(item) === promptId);
  }

  private queuePromptId(entry: unknown): string | undefined {
    return Array.isArray(entry) && typeof entry[1] === 'string' ? entry[1] : undefined;
  }

  async getHistory(promptId: string): Promise<unknown | null> {
    const response = await fetch(`${this.baseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as Record<string, unknown>;
    return payload[promptId] ?? null;
  }

  openEvents(promptId: string, clientId: string, listener: (event: ComfyEvent) => void): () => void {
    const socket = new WebSocket(`${websocketUrl(this.baseUrl)}?clientId=${encodeURIComponent(clientId)}`);
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as ComfyEvent;
        if (event.data?.prompt_id === promptId || event.type === 'minimax_h3_preview_override') listener(event);
      } catch {
        // Ignore non-JSON heartbeat messages from a local ComfyUI server.
      }
    });
    return () => socket.close();
  }

  async getMedia(query: URLSearchParams, range?: string): Promise<Response | null> {
    const response = await fetch(`${this.baseUrl}/view?${query.toString()}`, {
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(30000),
    });
    return response.ok ? response : null;
  }

  async uploadInput(asset: ComfyInputUpload): Promise<InputAsset> {
    const form = new FormData();
    const bytes = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    ) as ArrayBuffer;
    form.append('image', new Blob([bytes], { type: asset.mimeType }), asset.filename);
    const response = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const payload = await response.json().catch(() => ({})) as { name?: string; subfolder?: string; type?: string; error?: string };
    if (!response.ok || !payload.name || payload.type !== 'input') {
      throw new Error(payload.error || '参考文件上传到 ComfyUI 失败。');
    }
    return {
      filename: payload.name,
      subfolder: typeof payload.subfolder === 'string' && payload.subfolder ? payload.subfolder : undefined,
      type: 'input',
      kind: asset.kind,
    };
  }
}

function selectOptions(objectInfo: Record<string, unknown> | null, nodeClass: string, inputName: string): string[] {
  if (!objectInfo) return [];
  const node = objectInfo[nodeClass];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const input = (node as { input?: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const required = (input as { required?: unknown }).required;
  if (!required || typeof required !== 'object' || Array.isArray(required)) return [];
  const definition = (required as Record<string, unknown>)[inputName];
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return [];
  return definition[0].filter((option): option is string => typeof option === 'string');
}

function hasInput(objectInfo: Record<string, unknown> | null, nodeClass: string, inputName: string): boolean {
  if (!objectInfo) return false;
  const node = objectInfo[nodeClass];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const input = (node as { input?: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return ['required', 'optional'].some((section) => {
    const definitions = (input as Record<string, unknown>)[section];
    return Boolean(definitions && typeof definitions === 'object' && !Array.isArray(definitions)
      && Object.hasOwn(definitions, inputName));
  });
}

interface CapabilityObjectInfo {
  h3Vsa: Record<string, unknown> | null;
  loraLoader: Record<string, unknown> | null;
  cublasInt8: Record<string, unknown> | null;
  adaGemmInt8: Record<string, unknown> | null;
  fusedModulation: Record<string, unknown> | null;
  vaeDecodeBatched: Record<string, unknown> | null;
  taePreviewOverride: Record<string, unknown> | null;
  taePreviewLoader: Record<string, unknown> | null;
  h3Reference: Record<string, unknown> | null;
  loadImage: Record<string, unknown> | null;
  loadVideo: Record<string, unknown> | null;
  getVideoComponents: Record<string, unknown> | null;
  loadAudio: Record<string, unknown> | null;
  unetLoader: Record<string, unknown> | null;
  clipLoader: Record<string, unknown> | null;
  vaeLoader: Record<string, unknown> | null;
  musicTextEncode: Record<string, unknown> | null;
  musicLatent: Record<string, unknown> | null;
  conditioningZeroOut: Record<string, unknown> | null;
  kSampler: Record<string, unknown> | null;
  vaeDecodeAudio: Record<string, unknown> | null;
  vaeDecodeAudioTiled: Record<string, unknown> | null;
  saveAudioMp3: Record<string, unknown> | null;
}

function hasNode(objectInfo: Record<string, unknown> | null, nodeClass: string): boolean {
  return Boolean(objectInfo?.[nodeClass]);
}

function detectServiceCapabilities(info: CapabilityObjectInfo): ComfyServiceCapabilities {
  const {
    h3Vsa,
    loraLoader,
    cublasInt8,
    adaGemmInt8,
    fusedModulation,
    vaeDecodeBatched,
    taePreviewOverride,
    taePreviewLoader,
    h3Reference,
    loadImage,
    loadVideo,
    getVideoComponents,
    loadAudio,
    unetLoader,
    clipLoader,
    vaeLoader,
    musicTextEncode,
    musicLatent,
    conditioningZeroOut,
    kSampler,
    vaeDecodeAudio,
    vaeDecodeAudioTiled,
    saveAudioMp3,
  } = info;
  const hasH3Vsa = Boolean(h3Vsa?.H3VSA);
  const hasCublasInt8 = Boolean(cublasInt8?.MiniMaxH3GB10CublasInt8);
  const hasAdaGemmInt8 = Boolean(adaGemmInt8?.MiniMaxH3GB10AdaGemmInt8);
  const hasStandardCublas = hasInput(cublasInt8, 'MiniMaxH3GB10CublasInt8', 'allow_standard');
  const hasGate = selectOptions(h3Vsa, 'H3VSA', 'gate_file').includes('fasth3_vsa_gate.safetensors');
  const hasLora = selectOptions(loraLoader, 'LoraLoaderModelOnly', 'lora_name').includes('fasth3_vsa_4-steps-v5.safetensors');
  const fastH3Reason = !hasH3Vsa
    ? '缺少 H3VSA 节点。'
    : !hasGate
      ? 'H3VSA 中未发现 fasth3_vsa_gate.safetensors。'
      : !hasLora
        ? '未发现 fasth3_vsa_4-steps-v5.safetensors。'
        : undefined;
  const hasReferenceNode = hasNode(h3Reference, 'MiniMaxH3ReferenceToVideo');
  const hasReferenceLoaders = hasNode(loadImage, 'LoadImage')
    && hasNode(loadVideo, 'LoadVideo')
    && hasNode(getVideoComponents, 'GetVideoComponents')
    && hasNode(loadAudio, 'LoadAudio');
  const hasReferenceModel = selectOptions(unetLoader, 'UNETLoader', 'unet_name')
    .includes('minimax_h3_ref2va_pruned_int8_convrot.safetensors');
  const h3ReferencesReason = !hasReferenceNode
    ? '未检测到 MiniMaxH3ReferenceToVideo 节点。'
    : !hasReferenceLoaders
      ? '多模态参考所需的图片、视频或音频加载节点不完整。'
      : !hasReferenceModel
        ? '未检测到 Ref2VA 模型（minimax_h3_ref2va_pruned_int8_convrot.safetensors），正在下载或尚未重启 ComfyUI。'
        : undefined;
  const hasMusicNodes = [
    hasNode(musicTextEncode, 'MiniMaxMusic3TextEncode'),
    hasNode(musicLatent, 'EmptyMiniMaxMusic3LatentAudio'),
    hasNode(conditioningZeroOut, 'ConditioningZeroOut'),
    hasNode(kSampler, 'KSampler'),
    hasNode(vaeDecodeAudio, 'VAEDecodeAudio'),
    hasNode(vaeDecodeAudioTiled, 'VAEDecodeAudioTiled'),
    hasNode(saveAudioMp3, 'SaveAudioMP3'),
  ].every(Boolean);
  const hasMusicModels = selectOptions(unetLoader, 'UNETLoader', 'unet_name').includes('minimax_music3_dit_fp16.safetensors')
    && selectOptions(clipLoader, 'CLIPLoader', 'clip_name').includes('minimax_music3_text_encoder_pruned_int8_convrot.safetensors')
    && selectOptions(vaeLoader, 'VAELoader', 'vae_name').includes('minimax_music3_dav.safetensors');
  const music3Reason = !hasMusicNodes
    ? '未检测到完整的 MiniMax Music3 核心节点。'
    : !hasMusicModels
      ? 'MiniMax Music3 的 DiT、文本编码器或音频 VAE 权重不完整。'
      : undefined;

  return {
    h3Standard: { available: true },
    h3StandardCublasInt8: !hasCublasInt8
      ? { available: false, reason: '未检测到 MiniMaxH3GB10CublasInt8 节点。' }
      : !hasStandardCublas
        ? { available: false, reason: '当前 GB10 cuBLAS INT8 节点尚未启用 H3 Standard 兼容路径。' }
        : { available: true },
    h3StandardAdaGemmInt8: hasAdaGemmInt8
      ? { available: true }
      : { available: false, reason: '未检测到 MiniMaxH3GB10AdaGemmInt8 节点。' },
    fastH3Vsa: fastH3Reason
      ? { available: false, reason: fastH3Reason }
      : { available: true },
    fastH3CublasInt8: hasCublasInt8
      ? { available: true }
      : { available: false, reason: '未检测到 MiniMaxH3GB10CublasInt8 节点。' },
    fastH3AdaGemmInt8: hasAdaGemmInt8
      ? { available: true }
      : { available: false, reason: '未检测到 MiniMaxH3GB10AdaGemmInt8 节点。' },
    fastH3FusedModulation: fusedModulation?.MiniMaxH3FusedModulation
      ? { available: true }
      : { available: false, reason: '未检测到 MiniMaxH3FusedModulation 节点。' },
    fastH3VaeTileBatch: vaeDecodeBatched?.MiniMaxH3VAEDecodeBatched
      ? { available: true }
      : { available: false, reason: '未检测到 MiniMaxH3VAEDecodeBatched 节点。' },
    taeH3Preview: !taePreviewOverride?.MiniMaxH3PreviewOverride
      ? { available: false, reason: '未检测到 MiniMaxH3PreviewOverride 节点。' }
      : !taePreviewLoader?.H3StudioTAEH3PreviewLoader
        ? { available: false, reason: '未检测到 H3 Studio TAEH3 预览解码器。' }
        : { available: true },
    h3References: h3ReferencesReason
      ? { available: false, reason: h3ReferencesReason }
      : { available: true },
    music3: music3Reason
      ? { available: false, reason: music3Reason }
      : { available: true },
  };
}
