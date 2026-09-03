import { extname } from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ComfyClient, ComfyEvent } from './comfy-client.js';
import {
  DisabledFlashVsrWorkerClient,
  type FlashVsrWorkerClient,
  type FlashVsrWorkerHealth,
  type FlashVsrWorkerJob,
} from './flashvsr-client.js';
import {
  DisabledDeterministicUpscaleWorkerClient,
  type DeterministicUpscaleWorkerClient,
  type DeterministicUpscaleWorkerHealth,
  type DeterministicUpscaleWorkerJob,
} from './deterministic-upscale-client.js';
import {
  calculateActualSeconds,
  calculateFrameLength,
  buildH3Workflow,
  InputError,
  normalizeGenerationRequest,
} from './workflow.js';
import type {
  InputAsset,
  InputAssetKind,
  JobSnapshot,
  JobState,
  MediaReference,
  TAEH3PreviewFrame,
  UpscaleJobSnapshot,
  UpscaleMethod,
  UpscaleState,
  UpscaleTarget,
  VideoEnhancement,
} from './types.js';

interface JobRecord {
  snapshot: JobSnapshot;
  clientId: string;
  startedAtMs: number;
  subscribers: Set<Response>;
  closeEvents: () => void;
  samplerStartedAt?: number;
  previousProgressAt?: number;
  progressIntervals: number[];
}

interface UpscaleJobRecord {
  snapshot: UpscaleJobSnapshot;
  workerJobId: string;
  sourceJobId: string;
  subscribers: Set<Response>;
  pollTimer?: ReturnType<typeof setTimeout>;
}

interface HistoricalUpscaleSource {
  sourceJobId: string;
  source: MediaReference & { type: 'output' };
  width: number;
  height: number;
}

interface CreateAppOptions {
  upscalePollIntervalMs?: number;
  deterministicUpscale?: DeterministicUpscaleWorkerClient;
}

function now(): string {
  return new Date().toISOString();
}

function findMedia(value: unknown): MediaReference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findMedia(item);
      if (match) return match;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.filename === 'string') {
    return {
      filename: record.filename,
      subfolder: typeof record.subfolder === 'string' ? record.subfolder : undefined,
      type: typeof record.type === 'string' ? record.type : 'output',
    };
  }
  for (const child of Object.values(record)) {
    const match = findMedia(child);
    if (match) return match;
  }
  return undefined;
}

function parseTAEH3Preview(data: Record<string, unknown>): TAEH3PreviewFrame | undefined {
  const image = typeof data.image === 'string' ? data.image : '';
  const mime = data.mime === 'image/jpeg' || data.mime === 'image/webp' ? data.mime : undefined;
  const width = typeof data.w === 'number' ? data.w : undefined;
  const height = typeof data.h === 'number' ? data.h : undefined;
  const step = typeof data.step === 'number' ? data.step : undefined;
  const totalSteps = typeof data.total === 'number' ? data.total : undefined;
  const hasSafeBase64 = image.length > 0 && image.length <= 1_500_000 && /^[A-Za-z0-9+/=]+$/.test(image);
  if (
    !mime || !hasSafeBase64
    || typeof width !== 'number' || typeof height !== 'number'
    || typeof step !== 'number' || typeof totalSteps !== 'number'
    || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 64 || height < 64 || width > 2048 || height > 2048
    || !Number.isInteger(step) || !Number.isInteger(totalSteps)
    || step < 1 || totalSteps < step
  ) return undefined;
  return {
    dataUrl: `data:${mime};base64,${image}`,
    mime,
    width,
    height,
    step,
    totalSteps,
  };
}

function phaseForNode(nodeId: unknown, service?: JobSnapshot['service']): JobState {
  if (service === 'music3') {
    if (nodeId === '7' || nodeId === 7) return 'sampling';
    if (nodeId === '8' || nodeId === 8) return 'decoding';
    if (nodeId === '9' || nodeId === 9) return 'saving';
    return 'preparing';
  }
  if (nodeId === '11' || nodeId === 11) return 'sampling';
  if (nodeId === '12' || nodeId === 12 || nodeId === '13' || nodeId === 13 || nodeId === '14' || nodeId === 14) {
    return 'decoding';
  }
  if (nodeId === '15' || nodeId === 15) return 'saving';
  return 'preparing';
}

function describeState(state: JobState, service?: JobSnapshot['service']): string {
  if (service === 'music3') {
    return {
      idle: '准备开始',
      queued: '正在等待音乐生成资源',
      preparing: '正在准备音乐模型与文本条件',
      sampling: '正在生成音乐',
      decoding: '正在解码音频',
      saving: '正在保存 MP3',
      cancelling: '正在请求停止…',
      completed: '音乐已生成',
      failed: '音乐生成未完成',
      cancelled: '本次音乐生成已停止',
    }[state];
  }
  return {
    idle: '准备开始',
    queued: '正在等待生成资源',
    preparing: '正在准备模型与画面条件',
    sampling: '正在生成视频画面',
    decoding: '正在解码视频与音频',
    saving: '正在保存成片',
    cancelling: '正在请求停止…',
    completed: '生成完成',
    failed: '生成未完成',
    cancelled: '本次生成已停止',
  }[state];
}

const UPLOAD_RULES: Record<InputAssetKind, { extensions: string[]; mimeTypes: string[]; maxBytes: number }> = {
  image: {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxBytes: 30 * 1024 * 1024,
  },
  video: {
    extensions: ['.mp4', '.mov', '.webm'],
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxBytes: 150 * 1024 * 1024,
  },
  audio: {
    extensions: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'],
    mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'],
    maxBytes: 50 * 1024 * 1024,
  },
};

function uploadKind(value: unknown): InputAssetKind {
  if (value === 'image' || value === 'video' || value === 'audio') return value;
  throw new InputError('上传类型不正确。');
}

function safeUploadFilename(request: Request): string {
  const header = request.header('x-file-name');
  if (!header) throw new InputError('上传文件缺少文件名。');
  let filename = '';
  try {
    filename = decodeURIComponent(header);
  } catch {
    throw new InputError('上传文件名编码不正确。');
  }
  const unsafeName = !filename
    || filename.length > 180
    || filename.includes('..')
    || filename.includes('/')
    || filename.includes('\\')
    || filename.includes('\0');
  if (unsafeName) throw new InputError('上传文件名不正确。');
  return filename;
}

function normalizedMimeType(request: Request): string {
  return (request.header('content-type') || '').split(';', 1)[0].trim().toLowerCase();
}

function validatedUploadedAsset(asset: InputAsset, kind: InputAssetKind): InputAsset {
  const invalid = !asset.filename
    || asset.filename.includes('..')
    || asset.filename.includes('/')
    || asset.filename.includes('\\')
    || asset.type !== 'input'
    || asset.kind !== kind
    || (asset.subfolder !== undefined && (asset.subfolder.includes('..') || asset.subfolder.startsWith('/') || asset.subfolder.includes('\\')));
  if (invalid) throw new InputError('生成引擎返回了不安全的上传文件引用。');
  return asset;
}

function isTerminalState(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function isTerminalUpscaleState(state: UpscaleState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function isUpscaleState(value: unknown): value is UpscaleState {
  return value === 'queued'
    || value === 'preparing'
    || value === 'upscaling'
    || value === 'saving'
    || value === 'cancelling'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function serialize(snapshot: JobSnapshot): JobSnapshot {
  return { ...snapshot };
}

function safeMediaQuery(value: unknown): URLSearchParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const media = value as Record<string, unknown>;
  const filename = typeof media.filename === 'string' ? media.filename : '';
  const subfolder = media.subfolder;
  const type = media.type;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
  if (typeof subfolder === 'string' && (subfolder.includes('..') || subfolder.startsWith('/') || subfolder.includes('\\'))) return null;
  if (type !== undefined && type !== 'output' && type !== 'temp') return null;
  const query = new URLSearchParams({ filename, type: typeof type === 'string' ? type : 'output' });
  if (typeof subfolder === 'string' && subfolder) query.set('subfolder', subfolder);
  return query;
}

function safeOutputMedia(value: unknown): (MediaReference & { type: 'output' }) | undefined {
  const query = safeMediaQuery(value);
  if (!query || query.get('type') !== 'output') return undefined;
  const filename = query.get('filename');
  if (!filename || !filename.toLowerCase().endsWith('.mp4')) return undefined;
  const subfolder = query.get('subfolder') || undefined;
  return { filename, subfolder, type: 'output' };
}

function readHistoricalUpscaleSource(value: unknown): HistoricalUpscaleSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sourceJobId = typeof record.sourceJobId === 'string' ? record.sourceJobId.trim() : '';
  const source = safeOutputMedia(record.source);
  const width = record.width;
  const height = record.height;
  if (
    !sourceJobId || sourceJobId.length > 180 || !source
    || typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 4096
    || typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > 4096
  ) return undefined;
  return { sourceJobId, source, width, height };
}

function readUpscaleTarget(value: unknown): UpscaleTarget | undefined {
  return value === '2k' || value === '4k' ? value : undefined;
}

function readUpscaleMethod(value: unknown): UpscaleMethod | undefined {
  return value === 'flashvsr' || value === 'deterministic' ? value : undefined;
}

function targetDimensionsError(
  job: Pick<JobSnapshot, 'width' | 'height'>,
  target: UpscaleTarget,
  method: UpscaleMethod,
): string | undefined {
  if (method === 'deterministic') {
    const isVerifiedSource = (job.width === 832 && job.height === 480)
      || (job.width === 1280 && job.height === 720);
    return isVerifiedSource && target === '2k'
      ? undefined
      : '当前稳定增强仅支持 832×480 或 1280×720 视频提升至 2K。';
  }
  if (job.width === 832 && job.height === 480) {
    return target === '2k' ? undefined : '480P H3 视频仅支持提升至 2K。';
  }
  if (job.width === 1280 && job.height === 720) return undefined;
  return '仅支持 832×480 或 1280×720 的 H3 输出视频。';
}

function fallbackFlashVsrHealth(): FlashVsrWorkerHealth {
  return {
    available: false,
    model: 'flashvsr-v1.1',
    supportedTargets: [],
    reason: '本地 FlashVSR 服务未启动。',
  };
}

function fallbackDeterministicUpscaleHealth(): DeterministicUpscaleWorkerHealth {
  return {
    available: false,
    model: 'realesrgan-x2plus-fp16',
    supportedProfiles: [],
    reason: '本地稳定增强服务未启动。',
  };
}

function labelForUpscaleMethod(method: UpscaleMethod | undefined): string {
  return method === 'deterministic' ? '稳定增强' : 'FlashVSR';
}

export function createApp(
  client: ComfyClient,
  flashVsr: FlashVsrWorkerClient = new DisabledFlashVsrWorkerClient(),
  options: CreateAppOptions = {},
) {
  const app = express();
  const deterministicUpscale = options.deterministicUpscale ?? new DisabledDeterministicUpscaleWorkerClient();
  const jobs = new Map<string, JobRecord>();
  const upscaleJobs = new Map<string, UpscaleJobRecord>();
  const upscalePollIntervalMs = options.upscalePollIntervalMs ?? 750;

  const notify = (job: JobRecord) => {
    const payload = `event: update\ndata: ${JSON.stringify(serialize(job.snapshot))}\n\n`;
    for (const subscriber of job.subscribers) subscriber.write(payload);
  };

  const serializeUpscale = (snapshot: UpscaleJobSnapshot): UpscaleJobSnapshot => ({ ...snapshot });

  const notifyUpscale = (record: UpscaleJobRecord) => {
    const payload = `event: update\ndata: ${JSON.stringify(serializeUpscale(record.snapshot))}\n\n`;
    for (const subscriber of record.subscribers) subscriber.write(payload);
  };

  const toVideoEnhancement = (snapshot: UpscaleJobSnapshot): VideoEnhancement => ({
    id: snapshot.id,
    ...(snapshot.method ? { method: snapshot.method } : {}),
    target: snapshot.target,
    state: snapshot.state,
    width: snapshot.width,
    height: snapshot.height,
    totalElapsedMs: snapshot.totalElapsedMs,
    ...(snapshot.message ? { message: snapshot.message } : {}),
    ...(snapshot.state === 'completed' && snapshot.media ? { media: snapshot.media } : {}),
  });

  const attachEnhancement = (record: UpscaleJobRecord) => {
    const source = jobs.get(record.sourceJobId);
    if (!source) return;
    const next = toVideoEnhancement(record.snapshot);
    const existing = source.snapshot.enhancements ?? [];
    const position = existing.findIndex((item) => item.id === next.id);
    const enhancements = position === -1
      ? [...existing, next]
      : existing.map((item, index) => index === position ? next : item);
    source.snapshot = {
      ...source.snapshot,
      enhancements,
      updatedAt: now(),
    };
    notify(source);
  };

  const clearUpscalePoll = (record: UpscaleJobRecord) => {
    if (record.pollTimer) clearTimeout(record.pollTimer);
    record.pollTimer = undefined;
  };

  const applyWorkerSnapshot = (
    record: UpscaleJobRecord,
    worker: FlashVsrWorkerJob | DeterministicUpscaleWorkerJob,
  ) => {
    const workerLabel = labelForUpscaleMethod(record.snapshot.method);
    const trustedState = isUpscaleState(worker.state) ? worker.state : 'failed';
    const safeMedia = trustedState === 'completed' && worker.media ? safeOutputMedia(worker.media) : undefined;
    const invalidCompletedMedia = trustedState === 'completed' && !safeMedia;
    const state: UpscaleState = invalidCompletedMedia ? 'failed' : trustedState;
    const mismatchedTarget = worker.target !== record.snapshot.target;
    const finalState: UpscaleState = mismatchedTarget ? 'failed' : state;
    record.snapshot = {
      ...record.snapshot,
      state: finalState,
      width: worker.width,
      height: worker.height,
      totalElapsedMs: Math.max(0, worker.totalElapsedMs),
      ...(mismatchedTarget
        ? { message: `${workerLabel} 返回了不一致的清晰度目标。` }
        : invalidCompletedMedia
          ? { message: `${workerLabel} 返回的增强视频不安全或不可用。` }
          : (worker.message ? { message: worker.message } : {})),
      ...(finalState === 'completed' && safeMedia ? { media: safeMedia } : { media: undefined }),
      updatedAt: now(),
    };
    attachEnhancement(record);
    notifyUpscale(record);
    if (isTerminalUpscaleState(record.snapshot.state)) clearUpscalePoll(record);
  };

  const pollUpscale = async (record: UpscaleJobRecord): Promise<void> => {
    if (isTerminalUpscaleState(record.snapshot.state)) return;
    try {
      const worker = record.snapshot.method === 'deterministic'
        ? await deterministicUpscale.getJob(record.workerJobId)
        : await flashVsr.getJob(record.workerJobId);
      applyWorkerSnapshot(record, worker);
    } catch {
      record.snapshot = {
        ...record.snapshot,
        state: 'failed',
        message: `无法获取${labelForUpscaleMethod(record.snapshot.method)}任务状态。`,
        updatedAt: now(),
      };
      attachEnhancement(record);
      notifyUpscale(record);
      clearUpscalePoll(record);
      return;
    }
    if (!isTerminalUpscaleState(record.snapshot.state)) scheduleUpscalePoll(record);
  };

  const scheduleUpscalePoll = (record: UpscaleJobRecord) => {
    clearUpscalePoll(record);
    record.pollTimer = setTimeout(() => {
      void pollUpscale(record);
    }, upscalePollIntervalMs);
    (record.pollTimer as unknown as { unref?: () => void }).unref?.();
  };

  const createUpscaleRecord = async (
    sourceJobId: string,
    sourceMedia: MediaReference & { type: 'output' },
    method: UpscaleMethod,
    target: UpscaleTarget,
  ): Promise<UpscaleJobSnapshot> => {
    const worker = method === 'deterministic'
      ? await deterministicUpscale.createJob({ source: sourceMedia, target: '2k' })
      : await flashVsr.createJob({ source: sourceMedia, target });
    const timestamp = now();
    const initialMedia = worker.state === 'completed' ? safeOutputMedia(worker.media) : undefined;
    const invalidCompletedMedia = worker.state === 'completed' && !initialMedia;
    const mismatchedTarget = worker.target !== target;
    const snapshot: UpscaleJobSnapshot = {
      id: worker.id,
      sourceJobId,
      method,
      target,
      state: invalidCompletedMedia || mismatchedTarget ? 'failed' : worker.state,
      width: worker.width,
      height: worker.height,
      totalElapsedMs: Math.max(0, worker.totalElapsedMs),
      ...(mismatchedTarget
        ? { message: `${labelForUpscaleMethod(method)} 返回了不一致的清晰度目标。` }
        : invalidCompletedMedia
          ? { message: `${labelForUpscaleMethod(method)} 返回的增强视频不安全或不可用。` }
          : (worker.message ? { message: worker.message } : {})),
      ...(initialMedia ? { media: initialMedia } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const record: UpscaleJobRecord = {
      snapshot,
      workerJobId: worker.id,
      sourceJobId,
      subscribers: new Set(),
    };
    upscaleJobs.set(snapshot.id, record);
    attachEnhancement(record);
    if (!isTerminalUpscaleState(snapshot.state)) scheduleUpscalePoll(record);
    return snapshot;
  };

  const update = (job: JobRecord, patch: Partial<JobSnapshot>) => {
    job.snapshot = {
      ...job.snapshot,
      ...patch,
      totalElapsedMs: Math.max(0, Date.now() - job.startedAtMs),
      updatedAt: now(),
    };
    if (!job.snapshot.message) job.snapshot.message = describeState(job.snapshot.state, job.snapshot.service);
    notify(job);
  };

  const complete = async (job: JobRecord) => {
    if (job.snapshot.state === 'cancelled') return;
    const history = await client.getHistory(job.snapshot.id).catch(() => null);
    const media = findMedia(history);
    update(job, {
      state: 'completed',
      message: media ? '生成完成，可以预览或下载。' : '生成完成，正在同步成片信息。',
      media,
    });
    job.closeEvents();
  };

  const processEvent = (job: JobRecord, event: ComfyEvent) => {
    if (isTerminalState(job.snapshot.state)) return;
    const data = event.data ?? {};
    if (event.type === 'execution_interrupted' && job.snapshot.state === 'cancelling') {
      update(job, {
        state: 'cancelled',
        etaSeconds: undefined,
        message: describeState('cancelled', job.snapshot.service),
      });
      job.closeEvents();
      return;
    }
    if (event.type === 'execution_error') {
      if (job.snapshot.state === 'cancelling') {
        update(job, {
          state: 'cancelled',
          etaSeconds: undefined,
          message: describeState('cancelled', job.snapshot.service),
        });
      } else {
        update(job, { state: 'failed', message: '本次生成未完成，请调整提示词后重试。' });
      }
      job.closeEvents();
      return;
    }
    if (event.type === 'execution_success') {
      void complete(job);
      return;
    }
    if (event.type === 'executing' && data.node === null) {
      void complete(job);
      return;
    }
    if (job.snapshot.state === 'cancelling') return;
    if (event.type === 'minimax_h3_preview_override') {
      const preview = job.snapshot.taeH3Preview ? parseTAEH3Preview(data) : undefined;
      if (!preview) return;
      const averageStepMs = typeof data.avg_step_ms === 'number' && Number.isFinite(data.avg_step_ms)
        ? data.avg_step_ms
        : undefined;
      update(job, {
        state: 'sampling',
        step: preview.step,
        totalSteps: preview.totalSteps,
        preview,
        etaSeconds: averageStepMs ? Math.ceil((preview.totalSteps - preview.step) * averageStepMs / 1000) : undefined,
        message: `正在生成第 ${preview.step} / ${preview.totalSteps} 步画面`,
      });
      return;
    }
    if (event.type === 'progress') {
      const value = typeof data.value === 'number' ? data.value : 0;
      const max = typeof data.max === 'number' ? data.max : job.snapshot.steps;
      const timestamp = Date.now();
      if (!job.samplerStartedAt) job.samplerStartedAt = timestamp;
      if (job.previousProgressAt) job.progressIntervals.push(timestamp - job.previousProgressAt);
      job.previousProgressAt = timestamp;
      const elapsedMs = timestamp - job.samplerStartedAt;
      const averageStepMs = job.progressIntervals.length >= 2
        ? job.progressIntervals.reduce((sum, interval) => sum + interval, 0) / job.progressIntervals.length
        : undefined;
      update(job, {
        state: 'sampling',
        step: value,
        totalSteps: max,
        elapsedMs,
        etaSeconds: averageStepMs ? Math.ceil((max - value) * averageStepMs / 1000) : undefined,
        message: averageStepMs
          ? `正在生成第 ${value} / ${max} 步画面`
          : `正在校准生成速度（第 ${value} / ${max} 步）`,
      });
      return;
    }
    if (event.type === 'executing') {
      const node = data.node;
      const state = phaseForNode(node, job.snapshot.service);
      update(job, { state, message: describeState(state, job.snapshot.service) });
      return;
    }
  };

  app.use(express.json({ limit: '16kb' }));

  app.post('/api/assets', express.raw({ type: '*/*', limit: '150mb' }), async (request, response) => {
    try {
      const kind = uploadKind(request.query.kind);
      const filename = safeUploadFilename(request);
      const rule = UPLOAD_RULES[kind];
      const mimeType = normalizedMimeType(request);
      const extension = extname(filename).toLowerCase();
      if (!rule.extensions.includes(extension) || !rule.mimeTypes.includes(mimeType)) {
        throw new InputError('文件类型与上传类别不匹配。');
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        throw new InputError('上传文件为空。');
      }
      if (request.body.length > rule.maxBytes) {
        throw new InputError(`上传文件过大，${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}请控制在 ${Math.floor(rule.maxBytes / 1024 / 1024)} MB 以内。`);
      }
      const asset = await client.uploadInput({
        filename,
        mimeType,
        bytes: new Uint8Array(request.body),
        kind,
      });
      response.status(201).json(validatedUploadedAsset(asset, kind));
    } catch (error) {
      if (error instanceof InputError) {
        response.status(400).json({ message: error.message });
        return;
      }
      response.status(502).json({ message: '参考文件暂时无法上传到生成引擎，请稍后重试。' });
    }
  });

  app.get('/api/health', async (_request, response) => {
    const health = await client.health();
    if (!health.connected) {
      response.status(503).json({ connected: false });
      return;
    }
    const [flashHealth, deterministicHealth] = await Promise.all([
      flashVsr.health().catch(fallbackFlashVsrHealth),
      deterministicUpscale.health().catch(fallbackDeterministicUpscaleHealth),
    ]);
    response.json({
      ...health,
      services: {
        ...health.services,
        flashVsr: {
          available: flashHealth.available,
          model: flashHealth.model,
          supportedTargets: flashHealth.available ? flashHealth.supportedTargets : [],
          ...(flashHealth.reason ? { reason: flashHealth.reason } : {}),
        },
        deterministicUpscale: {
          available: deterministicHealth.available,
          model: deterministicHealth.model,
          supportedProfiles: deterministicHealth.available ? deterministicHealth.supportedProfiles : [],
          ...(deterministicHealth.reason ? { reason: deterministicHealth.reason } : {}),
        },
      },
    });
  });

  app.post('/api/jobs', async (request, response) => {
    try {
      const input = normalizeGenerationRequest(request.body);
      if (input.taeH3Preview) {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('视频生成引擎未连接，暂时无法使用 TAEH3 实时预览。');
        }
        const capability = health.services?.taeH3Preview;
        if (!capability?.available) {
          throw new InputError(capability?.reason || 'TAEH3 实时预览当前不可用。');
        }
      }
      if (input.inputMode === 'references') {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('视频生成引擎未连接，暂时无法使用多模态参考。');
        }
        const capability = health.services?.h3References;
        if (!capability?.available) {
          throw new InputError(capability?.reason || '多模态参考当前不可用。');
        }
      }
      if (input.service === 'music3') {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('音乐生成引擎未连接，暂时无法使用 MiniMax Music3。');
        }
        const capability = health.services?.music3;
        if (!capability?.available) {
          throw new InputError(capability?.reason || 'MiniMax Music3 当前不可用。');
        }
      }
      if (input.service === 'h3_standard' && input.h3StandardCublasInt8) {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('视频生成引擎未连接，暂时无法使用 H3 Standard GB10 cuBLAS INT8。');
        }
        const capabilities = health.services;
        if (!capabilities?.h3StandardCublasInt8.available) {
          throw new InputError(capabilities?.h3StandardCublasInt8.reason || 'H3 Standard GB10 cuBLAS INT8 优化当前不可用。');
        }
      }
      if (input.service === 'h3_standard' && input.h3StandardAdaGemmInt8) {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('视频生成引擎未连接，暂时无法使用 H3 Standard AdaGEMM INT8。');
        }
        const capability = health.services?.h3StandardAdaGemmInt8;
        if (!capability?.available) {
          throw new InputError(capability?.reason || 'H3 Standard AdaGEMM INT8 优化当前不可用。');
        }
      }
      if (input.service === 'fasth3_vsa') {
        const health = await client.health();
        if (!health.connected) {
          throw new InputError('视频生成引擎未连接，暂时无法使用 FastH3 VSA。');
        }
        const capabilities = health.services;
        if (!capabilities?.fastH3Vsa.available) {
          throw new InputError(capabilities?.fastH3Vsa.reason || 'FastH3 VSA 当前不可用。');
        }
        if (input.fastH3CublasInt8 && !capabilities.fastH3CublasInt8.available) {
          throw new InputError(capabilities.fastH3CublasInt8.reason || 'GB10 cuBLAS INT8 优化当前不可用。');
        }
        if (input.fastH3AdaGemmInt8 && !capabilities.fastH3AdaGemmInt8?.available) {
          throw new InputError(capabilities.fastH3AdaGemmInt8?.reason || 'FastH3 AdaGEMM INT8 优化当前不可用。');
        }
        if (input.fastH3VaeTileBatch && !capabilities.fastH3VaeTileBatch.available) {
          throw new InputError(capabilities.fastH3VaeTileBatch.reason || 'FastH3 VAE Tile Batch 当前不可用。');
        }
      }
      const clientId = crypto.randomUUID();
      const result = await client.enqueue(buildH3Workflow(input), clientId);
      const startedAtMs = Date.now();
      const timestamp = new Date(startedAtMs).toISOString();
      const snapshot: JobSnapshot = {
        id: result.promptId,
        state: 'queued',
        prompt: input.prompt,
        width: input.width,
        height: input.height,
        seconds: input.seconds,
        actualFrames: input.service === 'music3' ? 0 : calculateFrameLength(input.seconds),
        actualSeconds: input.service === 'music3' ? input.seconds : calculateActualSeconds(input.seconds),
        steps: input.steps,
        samplerName: input.samplerName,
        seed: input.seed,
        turbo8Step: input.turbo8Step,
        featureCacheSafe: input.featureCacheSafe,
        featureCacheProfile: input.featureCacheProfile,
        easyCache: input.easyCache,
        spargeAttention: input.spargeAttention,
        spargeProfile: input.spargeProfile,
        fusedModulation: input.fusedModulation,
        vaeTileBatch: input.vaeTileBatch,
        service: input.service,
        h3StandardCublasInt8: input.h3StandardCublasInt8,
        h3StandardAdaGemmInt8: input.h3StandardAdaGemmInt8,
        fastH3CublasInt8: input.fastH3CublasInt8,
        fastH3AdaGemmInt8: input.fastH3AdaGemmInt8,
        fastH3VaeTileBatch: input.fastH3VaeTileBatch,
        taeH3Preview: input.taeH3Preview,
        inputMode: input.inputMode,
        firstFrame: input.firstFrame,
        lastFrame: input.lastFrame,
        referenceImages: input.referenceImages,
        referenceVideos: input.referenceVideos,
        referenceAudios: input.referenceAudios,
        referenceImageSize: input.referenceImageSize,
        lyrics: input.lyrics,
        musicTiledDecode: input.musicTiledDecode,
        totalElapsedMs: 0,
        message: describeState('queued', input.service),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const job: JobRecord = {
        snapshot,
        clientId,
        startedAtMs,
        subscribers: new Set(),
        closeEvents: () => undefined,
        progressIntervals: [],
      };
      job.closeEvents = client.openEvents(snapshot.id, job.clientId, (event) => processEvent(job, event));
      jobs.set(snapshot.id, job);
      response.status(202).json(serialize(snapshot));
    } catch (error) {
      if (error instanceof InputError) {
        response.status(400).json({ message: error.message });
        return;
      }
      response.status(502).json({ message: '暂时无法连接到视频生成引擎，请检查本机连接后重试。' });
    }
  });

  app.post('/api/jobs/:sourceJobId/upscale', async (request, response) => {
    const source = jobs.get(request.params.sourceJobId);
    if (!source) {
      response.status(404).json({ message: '未找到本次生成任务。' });
      return;
    }
    if (source.snapshot.state !== 'completed') {
      response.status(409).json({ message: '请在视频生成完成后再提升清晰度。' });
      return;
    }
    if (source.snapshot.service === 'music3') {
      response.status(400).json({ message: '音乐结果不支持视频增强。' });
      return;
    }
    const sourceMedia = safeOutputMedia(source.snapshot.media);
    if (!sourceMedia) {
      response.status(400).json({ message: '原始视频引用不安全或不可用于本地增强。' });
      return;
    }
    const target = readUpscaleTarget(request.body?.target);
    if (!target) {
      response.status(400).json({ message: '请选择 2K 或 4K 增强目标。' });
      return;
    }
    const suppliedMethod = request.body?.method;
    const method = suppliedMethod === undefined ? 'flashvsr' : readUpscaleMethod(suppliedMethod);
    if (!method) {
      response.status(400).json({ message: '请选择有效的视频增强方法。' });
      return;
    }
    const dimensionsError = targetDimensionsError(source.snapshot, target, method);
    if (dimensionsError) {
      response.status(400).json({ message: dimensionsError });
      return;
    }

    if (method === 'deterministic') {
      const health = await deterministicUpscale.health().catch(fallbackDeterministicUpscaleHealth);
      const supportsProfile = health.supportedProfiles.some((profile) => (
        profile.sourceWidth === source.snapshot.width
        && profile.sourceHeight === source.snapshot.height
        && profile.target === target
      ));
      if (!health.available || !supportsProfile) {
        response.status(503).json({ message: health.reason || '稳定增强服务尚未通过当前规格校验。' });
        return;
      }
    } else {
      const health = await flashVsr.health().catch(fallbackFlashVsrHealth);
      if (!health.available || !health.supportedTargets.includes(target)) {
        response.status(503).json({ message: health.reason || 'FlashVSR 兼容性门槛尚未通过。' });
        return;
      }
    }
    if ([...jobs.values()].some((job) => !isTerminalState(job.snapshot.state))) {
      response.status(409).json({ message: '请等待当前 H3 Studio 生成任务结束后再启动超分。' });
      return;
    }
    if ([...upscaleJobs.values()].some((record) => (
      record.sourceJobId === source.snapshot.id && !isTerminalUpscaleState(record.snapshot.state)
    ))) {
      response.status(409).json({ message: '该视频已有正在执行的超分任务。' });
      return;
    }

    try {
      const snapshot = await createUpscaleRecord(source.snapshot.id, sourceMedia, method, target);
      response.status(202).json(serializeUpscale(snapshot));
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : `无法创建${labelForUpscaleMethod(method)}本地增强任务。`;
      response.status(502).json({ message });
    }
  });

  app.post('/api/history/upscale', async (request, response) => {
    const source = readHistoricalUpscaleSource(request.body);
    if (!source) {
      response.status(400).json({ message: '历史视频参数无效，需使用保存在 ComfyUI 输出目录中的 MP4。' });
      return;
    }
    const target = readUpscaleTarget(request.body?.target);
    const method = readUpscaleMethod(request.body?.method);
    if (!target || !method) {
      response.status(400).json({ message: '请选择有效的视频增强方法和清晰度目标。' });
      return;
    }
    const dimensionsError = targetDimensionsError(source, target, method);
    if (dimensionsError) {
      response.status(400).json({ message: dimensionsError });
      return;
    }
    if (method === 'deterministic') {
      const health = await deterministicUpscale.health().catch(fallbackDeterministicUpscaleHealth);
      const supportsProfile = health.supportedProfiles.some((profile) => (
        profile.sourceWidth === source.width
        && profile.sourceHeight === source.height
        && profile.target === target
      ));
      if (!health.available || !supportsProfile) {
        response.status(503).json({ message: health.reason || '稳定增强服务尚未通过当前规格校验。' });
        return;
      }
    } else {
      const health = await flashVsr.health().catch(fallbackFlashVsrHealth);
      if (!health.available || !health.supportedTargets.includes(target)) {
        response.status(503).json({ message: health.reason || 'FlashVSR 兼容性门槛尚未通过。' });
        return;
      }
    }
    if ([...jobs.values()].some((job) => !isTerminalState(job.snapshot.state))) {
      response.status(409).json({ message: '请等待当前 H3 Studio 生成任务结束后再启动超分。' });
      return;
    }
    if ([...upscaleJobs.values()].some((record) => (
      record.sourceJobId === source.sourceJobId && !isTerminalUpscaleState(record.snapshot.state)
    ))) {
      response.status(409).json({ message: '该历史视频已有正在执行的超分任务。' });
      return;
    }
    try {
      const snapshot = await createUpscaleRecord(source.sourceJobId, source.source, method, target);
      response.status(202).json(serializeUpscale(snapshot));
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : `无法创建${labelForUpscaleMethod(method)}本地增强任务。`;
      response.status(502).json({ message });
    }
  });

  app.get('/api/jobs/:id', (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ message: '未找到本次生成任务。' });
      return;
    }
    response.json(serialize(job.snapshot));
  });

  app.post('/api/jobs/:id/stop', async (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ message: '未找到本次生成任务。' });
      return;
    }
    if (job.snapshot.state === 'cancelled' || job.snapshot.state === 'cancelling') {
      response.json(serialize(job.snapshot));
      return;
    }
    if (isTerminalState(job.snapshot.state)) {
      response.status(409).json({ message: '本次任务已经结束，无法停止。' });
      return;
    }

    try {
      const result = await client.cancel(job.snapshot.id);
      if (result.state === 'rejected') {
        response.status(409).json({ message: result.message || '任务状态已变化，未发送停止请求。' });
        return;
      }
      if (result.state === 'cancelled') {
        job.closeEvents();
        update(job, {
          state: 'cancelled',
          etaSeconds: undefined,
          message: result.message || describeState('cancelled', job.snapshot.service),
        });
      } else {
        update(job, {
          state: 'cancelling',
          etaSeconds: undefined,
          message: result.message || describeState('cancelling', job.snapshot.service),
        });
      }
      response.json(serialize(job.snapshot));
    } catch {
      response.status(502).json({ message: '停止请求暂时未成功，请稍后重试。' });
    }
  });

  app.get('/api/jobs/:id/events', (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ message: '未找到本次生成任务。' });
      return;
    }
    response.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    job.subscribers.add(response);
    response.write(`event: update\ndata: ${JSON.stringify(serialize(job.snapshot))}\n\n`);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
    request.on('close', () => {
      clearInterval(heartbeat);
      job.subscribers.delete(response);
    });
  });

  app.get('/api/upscale-jobs/:id', (request, response) => {
    const record = upscaleJobs.get(request.params.id);
    if (!record) {
      response.status(404).json({ message: '未找到本次超分任务。' });
      return;
    }
    response.json(serializeUpscale(record.snapshot));
  });

  app.post('/api/upscale-jobs/:id/stop', async (request, response) => {
    const record = upscaleJobs.get(request.params.id);
    if (!record) {
      response.status(404).json({ message: '未找到本次超分任务。' });
      return;
    }
    if (isTerminalUpscaleState(record.snapshot.state)) {
      response.status(409).json({ message: '本次超分任务已经结束，无法停止。' });
      return;
    }
    try {
      const worker = record.snapshot.method === 'deterministic'
        ? await deterministicUpscale.cancelJob(record.workerJobId)
        : await flashVsr.cancelJob(record.workerJobId);
      applyWorkerSnapshot(record, worker);
      if (!isTerminalUpscaleState(record.snapshot.state)) scheduleUpscalePoll(record);
      response.json(serializeUpscale(record.snapshot));
    } catch {
      response.status(502).json({ message: '停止超分任务暂时未成功，请稍后重试。' });
    }
  });

  app.get('/api/upscale-jobs/:id/events', (request, response) => {
    const record = upscaleJobs.get(request.params.id);
    if (!record) {
      response.status(404).json({ message: '未找到本次超分任务。' });
      return;
    }
    response.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    record.subscribers.add(response);
    response.write(`event: update\ndata: ${JSON.stringify(serializeUpscale(record.snapshot))}\n\n`);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
    request.on('close', () => {
      clearInterval(heartbeat);
      record.subscribers.delete(response);
    });
  });

  app.get('/api/media', async (request, response) => {
    const query = safeMediaQuery({
      filename: request.query.filename,
      subfolder: request.query.subfolder,
      type: request.query.type,
    });
    if (!query) {
      response.status(400).json({ message: '视频文件参数不正确。' });
      return;
    }
    const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
    const media = await client.getMedia(query, range).catch(() => null);
    if (!media) {
      response.status(404).json({ message: '视频文件暂不可用。' });
      return;
    }
    const headersToProxy = ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified'] as const;
    for (const header of headersToProxy) {
      const value = media.headers.get(header);
      if (value) response.set(header, value);
    }
    response.status(media.status);
    response.set('Content-Type', media.headers.get('content-type') || 'video/mp4');
    response.set('Content-Disposition', `inline; filename="${query.get('filename')}"`);
    response.send(Buffer.from(await media.arrayBuffer()));
  });

  return app;
}
