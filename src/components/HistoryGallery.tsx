import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StudioApi } from '../api';
import { findComparableFastH3Job, formatOptimizationSummary } from '../optimization';
import type {
  GenerationJob,
  MediaReference,
  ServiceCapability,
  UpscaleMethod,
  UpscaleTarget,
  VideoEnhancement,
} from '../types';

interface HistoryGalleryProps {
  history: GenerationJob[];
  api: StudioApi;
  onReuse: (job: GenerationJob) => void;
  onRemove: (id: string) => void;
  deterministicUpscale?: ServiceCapability & {
    supportedProfiles?: Array<{
      sourceWidth: number;
      sourceHeight: number;
      target: '2k';
      width: number;
      height: number;
    }>;
  };
  onStartUpscale?: (job: GenerationJob, method: UpscaleMethod, target: UpscaleTarget) => void;
  onStopUpscale?: () => void;
  isUpscaling?: boolean;
  upscaleError?: string;
}

function formatVideoDuration(seconds: number) {
  const rounded = Math.round(Math.max(0, seconds) * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} 秒` : `${rounded.toFixed(1)} 秒`;
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds.toString().padStart(2, '0')} 秒` : `${seconds} 秒`;
}

function fastH3Comparison(job: GenerationJob, history: GenerationJob[]): string | undefined {
  if ((job.fastH3CublasInt8 !== true && job.fastH3AdaGemmInt8 !== true) || job.totalElapsedMs <= 0) return undefined;
  const baseline = findComparableFastH3Job(job, history);
  if (!baseline || baseline.totalElapsedMs <= 0) return undefined;
  const deltaMs = baseline.totalElapsedMs - job.totalElapsedMs;
  const percent = Math.abs(deltaMs / baseline.totalElapsedMs) * 100;
  const delta = formatElapsed(Math.abs(deltaMs));
  return deltaMs > 0
    ? `同配置内核对比：较基线快 ${delta}（${percent.toFixed(1)}%）`
    : deltaMs < 0
      ? `同配置内核对比：较基线慢 ${delta}（${percent.toFixed(1)}%）`
      : '同配置内核对比：与基线耗时相同';
}

interface HistoryMediaVariant {
  id: string;
  label: string;
  media: MediaReference;
}

function completedMediaVariants(job: GenerationJob): HistoryMediaVariant[] {
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

function supportsStable2K(
  job: GenerationJob,
  deterministicUpscale: HistoryGalleryProps['deterministicUpscale'],
): boolean {
  if (!job.media || job.service === 'music3' || !deterministicUpscale?.available) return false;
  return (deterministicUpscale.supportedProfiles || []).some((profile) => (
    profile.sourceWidth === job.width
    && profile.sourceHeight === job.height
    && profile.target === '2k'
  ));
}

function activeStableEnhancement(job: GenerationJob): VideoEnhancement | undefined {
  return job.enhancements?.find((item) => (
    item.method === 'deterministic'
    && !['completed', 'failed', 'cancelled'].includes(item.state)
  ));
}

function hasCompletedStableEnhancement(job: GenerationJob): boolean {
  return Boolean(job.enhancements?.some((item) => item.method === 'deterministic' && item.state === 'completed'));
}

export function titleFor(prompt: string) {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  const withoutRequest = compact.replace(
    /^(?:请(?:帮我)?|帮我|为我)?(?:生成|创建|制作|做)(?:一段|一条|一个)?(?:\s*(?:约?\s*)?\d+(?:\s*[~～-]\s*\d+)?\s*秒)?(?:的)?(?:视频|短片|影像)?\s*[：:，,]?\s*/i,
    '',
  );
  const withoutParameters = withoutRequest.split(/(?:参数(?:配置)?|配置)\s*[：:]/i)[0] || withoutRequest;
  const firstScene = withoutParameters.split(/[。！？!?；;，,]/)[0]?.trim().replace(/^[：:，,\s]+|[：:，,\s]+$/g, '');
  const title = firstScene || compact || '未命名视频';
  return title.length > 28 ? `${title.slice(0, 28)}…` : title;
}

interface HistoryPreviewProps {
  job: GenerationJob;
  api: StudioApi;
  onClose: () => void;
  onReuse: (job: GenerationJob) => void;
}

function HistoryPreview({ job, api, onClose, onReuse }: HistoryPreviewProps) {
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState('original');
  const promptId = useId();
  const variants = completedMediaVariants(job);
  const selectedVariant = variants.find((variant) => variant.id === selectedVariantId) || variants[0];
  const mediaUrl = selectedVariant ? api.mediaUrl(selectedVariant.media) : undefined;
  const title = titleFor(job.prompt);
  const isMusic3 = job.service === 'music3';

  useEffect(() => {
    setSelectedVariantId('original');
  }, [job.id]);

  return (
    <div className="history-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`history-modal ${mediaUrl ? 'has-media' : 'media-unavailable'} ${isMusic3 ? 'music-history-modal' : ''}`} role="dialog" aria-modal="true" aria-label={isMusic3 ? '音乐预览' : '视频预览'}>
        <header className="history-modal-header">
          <div className="history-modal-title-block">
            <span>{isMusic3 ? '音乐预览' : '视频预览'}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="history-modal-close" onClick={onClose} aria-label={`关闭${isMusic3 ? '音乐' : '视频'}预览`}>×</button>
        </header>
        <div className="history-modal-layout">
          <div className="history-modal-stage">
            <div className="history-modal-video">
              {mediaUrl ? (
                isMusic3 ? <audio controls autoPlay preload="metadata" src={mediaUrl} /> : <video key={selectedVariant?.id} controls autoPlay preload="metadata" src={mediaUrl} />
              ) : (
                <div className="history-modal-unavailable">
                  <span aria-hidden="true">{isMusic3 ? '♫' : 'H3'}</span>
                  <strong>{isMusic3 ? '音乐文件当前不可用' : '视频文件当前不可用'}</strong>
                  <p>这条旧记录没有可播放的本地媒体文件。</p>
                </div>
              )}
            </div>
            {!isMusic3 && variants.length > 1 && (
              <div className="media-variant-selector history-media-variant-selector" role="group" aria-label="视频版本">
                {variants.map((variant) => (
                  <button
                    key={variant.id}
                    type="button"
                    aria-pressed={selectedVariant?.id === variant.id}
                    onClick={() => setSelectedVariantId(variant.id)}
                  >
                    {variant.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <aside className="history-modal-aside">
            <div className="history-modal-summary">
              <span>本次输出</span>
              <strong>{isMusic3 ? `MP3 · ${formatVideoDuration(job.actualSeconds || job.seconds)}` : `${job.width} × ${job.height} · ${formatVideoDuration(job.actualSeconds || job.seconds)}`}</strong>
            </div>
            <dl className="history-modal-specs">
              <div>
                <dt>采样设置</dt>
                <dd>{job.steps} 步</dd>
              </div>
              <div>
                <dt>推理优化</dt>
                <dd>{formatOptimizationSummary(job)}</dd>
              </div>
              <div>
                <dt>生成耗时</dt>
                <dd>{formatElapsed(job.totalElapsedMs)}</dd>
              </div>
            </dl>
            <div className={`history-prompt-disclosure ${isPromptExpanded ? 'is-expanded' : ''}`}>
              <button
                type="button"
                aria-expanded={isPromptExpanded}
                aria-controls={promptId}
                onClick={() => setIsPromptExpanded((expanded) => !expanded)}
              >
                <span>{isPromptExpanded ? '收起原始提示词' : '查看原始提示词'}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
              </button>
              {isPromptExpanded && <p id={promptId}>{job.prompt}</p>}
            </div>
            <div className="history-modal-actions">
              <button type="button" className="history-action" onClick={() => onReuse(job)}>复用参数</button>
              {mediaUrl && <a className="history-download-action" href={`${mediaUrl}&download=1`} download>下载 {isMusic3 ? 'MP3' : selectedVariant?.label === '原始视频' ? 'MP4' : selectedVariant?.label}</a>}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

export function HistoryGallery({
  history,
  api,
  onReuse,
  onRemove,
  deterministicUpscale,
  onStartUpscale,
  onStopUpscale,
  isUpscaling = false,
  upscaleError,
}: HistoryGalleryProps) {
  const [selectedJob, setSelectedJob] = useState<GenerationJob | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedJob) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedJob(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedJob]);

  const remove = (id: string) => {
    onRemove(id);
    setDeleteCandidateId(null);
    if (selectedJob?.id === id) setSelectedJob(null);
  };

  const reuse = (job: GenerationJob) => {
    onReuse(job);
    setSelectedJob(null);
  };

  return (
    <section className="history-section">
      <div className="history-heading">
        <div>
          <span className="section-kicker">SESSION LIBRARY</span>
          <h2>最近生成</h2>
        </div>
        <span className="history-count">{history.length ? `${history.length} 个作品` : '当前会话'}</span>
      </div>
      {history.length === 0 ? (
        <div className="empty-history">
          <span className="empty-history-mark">＋</span>
          <div><strong>你的作品会保留在这里</strong><p>完成后可直接回看、下载或复用相同的创作参数。</p></div>
        </div>
      ) : (
        <div className="history-grid">
          {history.map((job, index) => {
            const mediaUrl = job.media ? api.mediaUrl(job.media) : undefined;
            const title = titleFor(job.prompt);
            const comparison = fastH3Comparison(job, history);
            const isMusic3 = job.service === 'music3';
            const canStartStable2K = supportsStable2K(job, deterministicUpscale);
            const stableEnhancement = activeStableEnhancement(job);
            const hasStable2K = hasCompletedStableEnhancement(job);
            return (
              <article className="history-card" key={job.id} aria-label={title}>
                <div className={`history-cover cover-${index % 4}`}>
                  {mediaUrl && !isMusic3 ? <video aria-hidden="true" muted preload="metadata" src={mediaUrl} /> : <span>{isMusic3 ? '♫' : 'H3'}</span>}
                  <div className="history-cover-shade" />
                  <button
                    type="button"
                    className="history-open-overlay"
                    onClick={() => setSelectedJob(job)}
                    aria-label={`打开${isMusic3 ? '音乐' : '视频'}：${title}`}
                  >
                    <span className="history-play-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="M8 5.4v13.2L18.7 12 8 5.4Z" /></svg>
                    </span>
                    <span className="history-open-copy">{isMusic3 ? '播放音乐' : '打开预览'}</span>
                  </button>
                  <span className="history-duration">{formatVideoDuration(job.actualSeconds || job.seconds)}</span>
                </div>
                <div className="history-card-body">
                  <div className="history-title-row">
                    <h3 title={title}>{title}</h3>
                    <span className="history-state">已完成</span>
                  </div>
                  <div className="history-meta" aria-label={isMusic3 ? '音乐参数' : '视频参数'}>
                    {!isMusic3 && <><span>{job.width} × {job.height}</span><i /></>}
                    <span>{formatVideoDuration(job.actualSeconds || job.seconds)}</span><i />
                    <span>{job.steps} 步</span>
                  </div>
                  <div className="history-optimization" title="本次实际启用的推理优化">
                    <span className="history-optimization-label">推理优化</span>
                    <strong>{formatOptimizationSummary(job)}</strong>
                  </div>
                  {comparison && <p className="history-comparison">{comparison}</p>}
                  <div className="history-run-time">
                    <span>端到端生成</span>
                    <strong>耗时 {formatElapsed(job.totalElapsedMs)}</strong>
                  </div>
                  <div className="history-card-actions">
                    <button type="button" className="history-action history-open-action" onClick={() => setSelectedJob(job)}>打开</button>
                    {stableEnhancement ? (
                      <>
                        <span className="history-upscale-status" role="status">正在 2K 稳定增强</span>
                        <button type="button" className="history-action" onClick={onStopUpscale} disabled={!onStopUpscale}>停止超分</button>
                      </>
                    ) : canStartStable2K && !hasStable2K ? (
                      <button
                        type="button"
                        className="history-action history-upscale-action"
                        onClick={() => onStartUpscale?.(job, 'deterministic', '2k')}
                        disabled={!onStartUpscale || isUpscaling}
                        title={isUpscaling ? '请等待当前稳定增强任务结束。' : undefined}
                      >
                        2K 稳定增强
                      </button>
                    ) : null}
                    <button type="button" className="history-action" onClick={() => reuse(job)}>复用参数</button>
                    {deleteCandidateId === job.id ? (
                      <div className="history-delete-confirm" role="status">
                        <span>仅从本地历史移除</span>
                        <button type="button" onClick={() => remove(job.id)}>确认删除</button>
                        <button type="button" onClick={() => setDeleteCandidateId(null)}>取消</button>
                      </div>
                    ) : (
                      <button type="button" className="history-delete-action" onClick={() => setDeleteCandidateId(job.id)}>删除记录</button>
                    )}
                  </div>
                  {upscaleError && !stableEnhancement && canStartStable2K && <p className="history-upscale-error" role="status">{upscaleError}</p>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selectedJob && createPortal(
        <HistoryPreview job={selectedJob} api={api} onClose={() => setSelectedJob(null)} onReuse={reuse} />,
        document.body,
      )}
    </section>
  );
}
