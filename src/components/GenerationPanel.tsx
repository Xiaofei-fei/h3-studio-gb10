import { useEffect, useState } from 'react';
import type { StudioApi } from '../api';
import { formatOptimizationSummary } from '../optimization';
import type {
  GenerationJob,
  MediaReference,
  ServiceCapability,
  UpscaleMethod,
  UpscaleTarget,
  VideoEnhancement,
} from '../types';

interface GenerationPanelProps {
  job: GenerationJob | null;
  api: StudioApi;
  onRetry: () => void;
  onStop?: () => void;
  isStopping?: boolean;
  stopError?: string;
  flashVsr?: ServiceCapability & { supportedTargets?: UpscaleTarget[] };
  deterministicUpscale?: ServiceCapability & {
    supportedProfiles?: Array<{
      sourceWidth: number;
      sourceHeight: number;
      target: '2k';
      width: number;
      height: number;
    }>;
  };
  onStartUpscale?: (method: UpscaleMethod, target: UpscaleTarget) => void;
  onStopUpscale?: () => void;
  isUpscaling?: boolean;
  upscaleError?: string;
}

const stages = [
  ['queued', '排队'],
  ['preparing', '准备'],
  ['sampling', '生成'],
  ['decoding', '解码'],
  ['saving', '交付'],
] as const;

const stateIndex: Record<string, number> = {
  idle: -1,
  queued: 0,
  preparing: 1,
  sampling: 2,
  decoding: 3,
  saving: 4,
  cancelling: 2,
  completed: 5,
  failed: -1,
  cancelled: -1,
};

function formatEta(seconds: number | undefined) {
  if (seconds === undefined) return '正在校准';
  if (seconds < 60) return `约 ${seconds} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes.toString().padStart(2, '0')} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds.toString().padStart(2, '0')} 秒`;
  return `${seconds} 秒`;
}

interface MediaVariant {
  id: string;
  label: string;
  media: MediaReference;
}

function completedMediaVariants(job: GenerationJob): MediaVariant[] {
  const original = job.media ? [{ id: 'original', label: '原始视频', media: job.media }] : [];
  const enhanced = (job.enhancements || [])
    .filter((item): item is VideoEnhancement & { media: MediaReference } => item.state === 'completed' && Boolean(item.media))
    .map((item) => ({
      id: item.id,
      label: item.method === 'deterministic'
        ? `${item.target === '4k' ? '4K' : '2K'} 稳定增强`
        : `${item.target === '4k' ? '4K' : '2K'} 增强`,
      media: item.media,
    }));
  return [...original, ...enhanced];
}

interface EnhancementOption {
  method: UpscaleMethod;
  target: UpscaleTarget;
  label: string;
}

function targetOptions(
  job: GenerationJob,
  flashVsr?: GenerationPanelProps['flashVsr'],
  deterministicUpscale?: GenerationPanelProps['deterministicUpscale'],
): EnhancementOption[] {
  const options: EnhancementOption[] = [];
  if (deterministicUpscale?.available) {
    for (const profile of deterministicUpscale.supportedProfiles || []) {
      if (profile.sourceWidth === job.width && profile.sourceHeight === job.height) {
        options.push({
          method: 'deterministic',
          target: profile.target,
          label: `2K · ${profile.width} × ${profile.height} · 稳定增强`,
        });
      }
    }
  }
  if (!flashVsr?.available) return options;
  const supports = (target: UpscaleTarget) => !flashVsr.supportedTargets || flashVsr.supportedTargets.includes(target);
  if (job.width === 832 && job.height === 480) {
    return [
      ...options,
      ...(supports('2k') ? [{ method: 'flashvsr' as const, target: '2k' as const, label: '2K · 2560 × 1478 · FlashVSR' }] : []),
    ];
  }
  if (job.width === 1280 && job.height === 720) {
    return [
      ...options,
      ...(supports('2k') ? [{ method: 'flashvsr' as const, target: '2k' as const, label: '2K · 2560 × 1440 · FlashVSR' }] : []),
      ...(supports('4k') ? [{ method: 'flashvsr' as const, target: '4k' as const, label: '4K · 3840 × 2160 · FlashVSR' }] : []),
    ];
  }
  return options;
}

function useDisplayedElapsed(job: GenerationJob | null) {
  const isRunning = Boolean(job && !['idle', 'completed', 'failed', 'cancelled'].includes(job.state));
  const [clientNow, setClientNow] = useState(() => Date.now());

  useEffect(() => {
    setClientNow(Date.now());
    if (!isRunning) return undefined;
    const timer = window.setInterval(() => setClientNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, job?.id]);

  if (!job) return 0;
  if (!isRunning) return job.totalElapsedMs;
  const createdAtMs = Date.parse(job.createdAt);
  const browserElapsedMs = Number.isFinite(createdAtMs) ? clientNow - createdAtMs : 0;
  return Math.max(job.totalElapsedMs, browserElapsedMs, 0);
}

export function GenerationPanel({
  job,
  api,
  onRetry,
  onStop,
  isStopping = false,
  stopError,
  flashVsr,
  deterministicUpscale,
  onStartUpscale,
  onStopUpscale,
  isUpscaling = false,
  upscaleError,
}: GenerationPanelProps) {
  const state = job?.state || 'idle';
  const isMusic3 = job?.service === 'music3';
  const isCancelling = state === 'cancelling';
  const isSamplingProgress = state === 'sampling' || isCancelling;
  const displayedElapsedMs = useDisplayedElapsed(job);
  const [showUpscaleTargets, setShowUpscaleTargets] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState('original');

  useEffect(() => {
    setShowUpscaleTargets(false);
    setSelectedVariantId('original');
  }, [job?.id]);

  const variants = job ? completedMediaVariants(job) : [];
  const selectedVariant = variants.find((variant) => variant.id === selectedVariantId) || variants[0];
  const options = job ? targetOptions(job, flashVsr, deterministicUpscale) : [];
  const activeEnhancement = job?.enhancements?.find((item) => !['completed', 'failed', 'cancelled'].includes(item.state));
  const showUpscaleProgress = Boolean(activeEnhancement && (isUpscaling || !['completed', 'failed', 'cancelled'].includes(activeEnhancement.state)));
  const progress = isSamplingProgress && job?.totalSteps
    ? Math.min(100, Math.round(((job.step || 0) / job.totalSteps) * 100))
    : state === 'completed' ? 100 : 0;
  const currentStage = stateIndex[state];

  if (state === 'completed' && job?.media && selectedVariant) {
    const mediaUrl = api.mediaUrl(selectedVariant.media);
    return (
      <section className="generation-panel is-complete" aria-live="polite">
        <div className="panel-eyebrow"><span className="status-orb complete" />已完成 <span className="panel-time">本次生成</span></div>
        <div className={`video-frame ${isMusic3 ? 'audio-frame' : ''}`}>
          {isMusic3 ? <audio controls preload="metadata" src={mediaUrl} /> : <video key={selectedVariant.id} controls preload="metadata" src={mediaUrl} />}
        </div>
        {!isMusic3 && variants.length > 1 && (
          <div className="media-variant-selector" role="group" aria-label="视频版本">
            {variants.map((variant) => (
              <button
                type="button"
                key={variant.id}
                aria-pressed={selectedVariant.id === variant.id}
                onClick={() => setSelectedVariantId(variant.id)}
              >
                {variant.label}
              </button>
            ))}
          </div>
        )}
        {!isMusic3 && showUpscaleProgress && activeEnhancement && (
          <div className="upscale-status" role="status">
            <div>
              <span className="status-orb pulse" />
              <strong>正在提升清晰度</strong>
              <p>{activeEnhancement.message || (activeEnhancement.method === 'deterministic'
                ? '正在执行确定性 RealESRGAN 增强。'
                : '正在执行官方 FlashVSR 增强。')} · 已用 {formatElapsed(activeEnhancement.totalElapsedMs)}</p>
            </div>
            <button type="button" className="stop-action" onClick={onStopUpscale} disabled={!onStopUpscale || activeEnhancement.state === 'cancelling'}>
              {activeEnhancement.state === 'cancelling' ? '正在请求停止…' : '停止超分任务'}
            </button>
          </div>
        )}
        {!isMusic3 && !showUpscaleProgress && options.length > 0 && (
          <div className="upscale-actions">
            {!showUpscaleTargets ? (
              <button type="button" className="secondary-action" onClick={() => setShowUpscaleTargets(true)}>提升清晰度</button>
            ) : (
              <div className="upscale-targets" role="group" aria-label="增强清晰度">
                {options.map((option) => (
                  <button key={`${option.method}-${option.target}`} type="button" onClick={() => onStartUpscale?.(option.method, option.target)} disabled={!onStartUpscale}>
                    {option.label}
                  </button>
                ))}
                <button type="button" className="upscale-cancel" onClick={() => setShowUpscaleTargets(false)}>取消</button>
              </div>
            )}
            {upscaleError && <p className="stop-error" role="status">{upscaleError}</p>}
          </div>
        )}
        {!isMusic3 && !showUpscaleProgress && options.length === 0 && deterministicUpscale && !deterministicUpscale.available && deterministicUpscale.reason && (
          <p className="upscale-unavailable" role="status">稳定增强暂不可用：{deterministicUpscale.reason}</p>
        )}
        {!isMusic3 && !showUpscaleProgress && options.length === 0 && flashVsr && !flashVsr.available && flashVsr.reason && (
          <p className="upscale-unavailable" role="status">FlashVSR 暂不可用：{flashVsr.reason}</p>
        )}
        <div className="completion-footer">
          <div>
            <h2>{isMusic3 ? '音乐已准备就绪' : '视频已准备就绪'}</h2>
            <p>{isMusic3 ? `${job.actualSeconds} 秒 · ${job.steps} 步 · ${formatOptimizationSummary(job)}` : `${job.width} × ${job.height} · ${job.actualFrames} 帧 · ${job.actualSeconds} 秒 · ${job.steps} 步 · ${formatOptimizationSummary(job)}`}</p>
          </div>
          <div className="completion-metric">
            <span>端到端耗时</span>
            <strong>{formatElapsed(displayedElapsedMs)}</strong>
          </div>
          <a className="download-button" href={`${mediaUrl}&download=1`} download>
            下载 {isMusic3 ? 'MP3' : selectedVariant.label === '原始视频' ? 'MP4' : selectedVariant.label} <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>
    );
  }

  if (state === 'failed') {
    return (
      <section className="generation-panel failed-panel" aria-live="assertive">
        <div className="failure-icon">!</div>
        <p className="panel-eyebrow">本次任务未完成</p>
        <h2>{job?.message || '暂时无法创建这段视频。'}</h2>
        <p>请确认本机连接正常，或调整描述后再次尝试。</p>
        <button type="button" className="secondary-action" onClick={onRetry}>使用相同参数重试</button>
      </section>
    );
  }

  if (state === 'cancelled') {
    return (
      <section className="generation-panel cancelled-panel" aria-live="polite">
        <div className="cancelled-icon" aria-hidden="true">×</div>
        <p className="panel-eyebrow">本次任务已停止</p>
        <h2>{job?.message || '已停止本次视频生成。'}</h2>
        <p>已用时间 {formatElapsed(displayedElapsedMs)}。未完成的视频不会作为成片保存。</p>
        <button type="button" className="secondary-action" onClick={onRetry}>使用相同参数重新生成</button>
      </section>
    );
  }

  if (state === 'idle') {
    return (
      <section className="generation-panel idle-panel">
        <div className="ambient-canvas" aria-hidden="true">
          <div className="ambient-grid" />
          <div className="ambient-sphere sphere-one" />
          <div className="ambient-sphere sphere-two" />
          <div className="ambient-line line-one" />
          <div className="ambient-line line-two" />
          <div className="ambient-title">H3</div>
        </div>
        <div className="idle-copy">
          <span className="panel-eyebrow"><span className="status-orb" />创作空间已就绪</span>
          <h2>从一句描述，开始一段视听叙事。</h2>
          <p>输入场景、镜头和声音，H3 将把它们共同编织为一段完整视频。</p>
          <div className="idle-specs">
            <span>原生视听生成</span><i /> <span>24 FPS</span><i /> <span>本机私有连接</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="generation-panel progress-panel" aria-live="polite">
      <div className="progress-header">
        <div>
          <span className="panel-eyebrow"><span className="status-orb pulse" />实时生成中</span>
          <h2>{job?.message || '正在连接视频引擎'}</h2>
        </div>
        <div className="timing-summary">
          <div className="elapsed-block">
            <span>已用时间</span>
            <strong>{formatElapsed(displayedElapsedMs)}</strong>
          </div>
          <div className="eta-block">
            <span>预计剩余</span>
            <strong>{formatEta(job?.etaSeconds)}</strong>
          </div>
        </div>
      </div>
      <div className="progress-visual">
        <div className="orbital-progress" style={{ '--progress': `${progress}%` } as React.CSSProperties}>
          <div className="orbital-center">
            {isSamplingProgress ? <><strong>{progress}</strong><span>%</span></> : <span className="phase-glyph">✦</span>}
          </div>
        </div>
        <div className="progress-copy">
          <strong>{isSamplingProgress ? `${job?.step || 0} / ${job?.totalSteps || job?.steps || 0} 步` : '实时状态'}</strong>
          <span>{isCancelling ? '正在等待引擎确认停止' : isSamplingProgress ? '去噪采样进度' : '等待来自引擎的下一阶段事件'}</span>
        </div>
      </div>
      {isSamplingProgress && job?.preview && (
        <figure className="taeh3-live-preview">
          <div className="taeh3-live-preview-frame">
            <img
              src={job.preview.dataUrl}
              width={job.preview.width}
              height={job.preview.height}
              alt={`TAEH3 实时预览，第 ${job.preview.step} / ${job.preview.totalSteps} 步`}
            />
          </div>
          <figcaption>
            <strong>TAEH3 实时预览 · 非最终画质</strong>
            <span>第 {job.preview.step} / {job.preview.totalSteps} 步 · {job.preview.width} × {job.preview.height}</span>
            <small>最终成片仍使用官方视频 VAE 解码。</small>
          </figcaption>
        </figure>
      )}
      <ol className="stage-track" aria-label="生成阶段">
        {stages.map(([key, label], index) => {
          const status = currentStage > index || state === 'completed' ? 'done' : currentStage === index ? 'active' : '';
          return <li key={key} className={status}><span />{label}</li>;
        })}
      </ol>
      <div className="progress-meta">
        <span>{job?.width} × {job?.height}</span><i />
        <span>{job?.actualSeconds ? `输出 ${job.actualSeconds} 秒` : '正在计算时长'}</span><i />
        <span>{job?.steps} 步</span><i /><span>{job ? formatOptimizationSummary(job) : '正在读取优化配置'}</span>
      </div>
      <div className="progress-actions">
        <p className="stop-error" role="status">{stopError}</p>
        <button
          type="button"
          className="stop-action"
          onClick={onStop}
          disabled={!onStop || isStopping || isCancelling}
        >
          {isStopping || isCancelling ? '正在请求停止…' : '停止本次任务'}
        </button>
      </div>
    </section>
  );
}
