import { useState } from 'react';
import { studioApi, type StudioApi } from './api';
import { ConnectionBadge } from './components/ConnectionBadge';
import { GenerationControls } from './components/GenerationControls';
import { GenerationPanel } from './components/GenerationPanel';
import { HistoryGallery } from './components/HistoryGallery';
import { Music3Composer } from './components/Music3Composer';
import { PromptComposer } from './components/PromptComposer';
import { ReferenceInputs } from './components/ReferenceInputs';
import { useGeneration } from './hooks/useGeneration';
import { DEFAULT_FORM, type GenerationForm, type GenerationJob } from './types';

interface AppProps {
  api?: StudioApi;
}

export function App({ api = studioApi }: AppProps) {
  const [form, setForm] = useState<GenerationForm>(DEFAULT_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isUploadingAssets, setIsUploadingAssets] = useState(false);
  const {
    connection,
    currentJob,
    history,
    generate,
    retry,
    stop,
    isStopping,
    stopError,
    startUpscale,
    startHistoryUpscale,
    stopUpscale,
    isUpscaling,
    upscaleError,
    removeHistory,
  } = useGeneration(api);
  const busy = Boolean(currentJob && !['completed', 'failed', 'cancelled'].includes(currentJob.state)) || isStopping || isUpscaling;

  const patchForm = (patch: Partial<GenerationForm>) => setForm((current) => {
    const next = { ...current, ...patch };
    if (patch.h3StandardCublasInt8 === true) next.h3StandardAdaGemmInt8 = false;
    if (patch.h3StandardAdaGemmInt8 === true) next.h3StandardCublasInt8 = false;
    if (patch.fastH3CublasInt8 === true) next.fastH3AdaGemmInt8 = false;
    if (patch.fastH3AdaGemmInt8 === true) next.fastH3CublasInt8 = false;
    if (patch.service === 'fasth3_vsa') {
      return {
        ...next,
        service: 'fasth3_vsa',
        steps: 4,
        samplerName: 'euler',
        turbo8Step: false,
        featureCacheSafe: false,
        easyCache: false,
        spargeAttention: false,
        fusedModulation: false,
        vaeTileBatch: false,
        h3StandardCublasInt8: false,
        h3StandardAdaGemmInt8: false,
        fastH3FusedModulation: false,
        inputMode: 'text',
      };
    }
    if (patch.service === 'music3') {
      return {
        ...next,
        service: 'music3',
        inputMode: 'text',
        seconds: Math.max(5, next.seconds),
        steps: 30,
        samplerName: 'euler',
        turbo8Step: false,
        featureCacheSafe: false,
        easyCache: false,
        spargeAttention: false,
        fusedModulation: false,
        vaeTileBatch: false,
        h3StandardCublasInt8: false,
        h3StandardAdaGemmInt8: false,
        fastH3CublasInt8: false,
        fastH3AdaGemmInt8: false,
        fastH3FusedModulation: false,
        fastH3VaeTileBatch: false,
        fastH3VaeTileBatchSize: undefined,
        taeH3Preview: false,
      };
    }
    if (patch.service === 'h3_standard' && current.service !== 'h3_standard') {
      return {
        ...next,
        service: 'h3_standard',
        inputMode: 'text',
        seconds: Math.min(15, Math.max(3, next.seconds)),
        steps: 20,
        samplerName: 'res_multistep',
        turbo8Step: false,
        featureCacheSafe: false,
        easyCache: false,
        spargeAttention: true,
        fusedModulation: false,
        vaeTileBatch: false,
        fastH3CublasInt8: false,
        fastH3AdaGemmInt8: false,
        fastH3FusedModulation: false,
        fastH3VaeTileBatch: false,
        fastH3VaeTileBatchSize: undefined,
      };
    }
    if (current.service === 'fasth3_vsa') {
      return { ...next, steps: 4, samplerName: 'euler' };
    }
    if (current.service === 'music3') {
      return { ...next, steps: 30, samplerName: 'euler', inputMode: 'text' };
    }
    if (patch.inputMode === 'references') {
      return {
        ...next,
        inputMode: 'references',
        turbo8Step: false,
        steps: current.turbo8Step ? 20 : next.steps,
        taeH3Preview: false,
      };
    }
    if (patch.easyCache === true) next.featureCacheSafe = false;
    if (patch.featureCacheSafe === true) next.easyCache = false;
    if (patch.turbo8Step === true) return { ...next, steps: 8 };
    if (patch.turbo8Step === false && current.turbo8Step) return { ...next, steps: patch.steps ?? 20 };
    return next;
  });
  const reuse = (job: GenerationJob) => {
    setForm({
      service: job.service || 'h3_standard',
      prompt: job.prompt,
      width: job.width,
      height: job.height,
      seconds: job.seconds,
      steps: job.steps,
      samplerName: job.samplerName || 'res_multistep',
      seed: job.seed,
      turbo8Step: job.turbo8Step === true,
      featureCacheSafe: job.featureCacheSafe,
      featureCacheProfile: job.featureCacheProfile || 'safe',
      easyCache: job.easyCache === true,
      spargeAttention: job.spargeAttention !== false,
      spargeProfile: job.spargeProfile || 'balanced',
      fusedModulation: job.fusedModulation === true,
      vaeTileBatch: job.vaeTileBatch === true,
      h3StandardCublasInt8: job.h3StandardCublasInt8 === true,
      h3StandardAdaGemmInt8: job.h3StandardAdaGemmInt8 === true,
      fastH3CublasInt8: job.fastH3CublasInt8 === true,
      fastH3AdaGemmInt8: job.fastH3AdaGemmInt8 === true,
      fastH3FusedModulation: job.fastH3FusedModulation === true,
      fastH3VaeTileBatch: job.fastH3VaeTileBatch === true,
      fastH3VaeTileBatchSize: job.fastH3VaeTileBatchSize,
      taeH3Preview: job.taeH3Preview === true,
      inputMode: job.inputMode || 'text',
      firstFrame: job.firstFrame,
      lastFrame: job.lastFrame,
      referenceImages: job.referenceImages || [],
      referenceVideos: job.referenceVideos || [],
      referenceAudios: job.referenceAudios || [],
      referenceImageSize: job.referenceImageSize || 'match',
      lyrics: job.lyrics || '',
      musicTiledDecode: job.musicTiledDecode !== false,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const submit = async () => {
    try {
      await generate(form);
    } catch {
      // The hook stores a customer-friendly failure state in the preview panel.
    }
  };
  const isMusic3 = form.service === 'music3';
  const isStandardH3 = form.service === 'h3_standard';
  const referenceCapability = connection.services?.h3References;
  const referenceModeReady = referenceCapability?.available === true;
  const hasRequiredInputs = isMusic3
    || form.inputMode === 'text'
    || (form.inputMode === 'keyframes' && Boolean(form.firstFrame))
    || (form.inputMode === 'references' && form.referenceImages.length + form.referenceVideos.length + form.referenceAudios.length > 0);
  const canGenerate = Boolean(form.prompt.trim()) && !busy && !isUploadingAssets && hasRequiredInputs;

  return (
    <main className="app-shell">
      <div className="page-glow glow-top" aria-hidden="true" />
      <div className="page-glow glow-bottom" aria-hidden="true" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><i /><i /><i /></div>
          <div><span>H3 STUDIO</span><small>GENERATIVE VIDEO</small></div>
        </div>
        <div className="topbar-meta">
          <span className="engine-chip"><i />{form.service === 'fasth3_vsa' ? 'FASTH3 VSA' : isMusic3 ? 'MINIMAX MUSIC3' : 'MINIMAX H3'}</span>
          <ConnectionBadge connection={connection} />
        </div>
      </header>

      <section className="hero-intro">
        <span className="section-kicker">PRIVATE GENERATIVE ENVIRONMENT</span>
        <h1>让每一个想法，<em>成为正在发生的画面。</em></h1>
        <p>H3 Studio 将提示词、镜头语言与声音描述，编织成一段完整的视听内容。</p>
      </section>

      <section className="studio-grid">
        <div className="creation-card glass-card">
          <div className="card-heading">
            <div><span className="section-kicker">CREATE</span><h2>创建一段视频</h2></div>
            <span className="private-chip"><i />本机私有会话</span>
          </div>
          {isMusic3 ? (
            <Music3Composer
              caption={form.prompt}
              lyrics={form.lyrics}
              onCaptionChange={(prompt) => patchForm({ prompt })}
              onLyricsChange={(lyrics) => patchForm({ lyrics })}
            />
          ) : (
            <>
              <PromptComposer value={form.prompt} onChange={(prompt) => patchForm({ prompt })} />
              {isStandardH3 && (
                <section className="input-mode-control field-group" aria-label="视频输入模式">
                  <div className="field-heading"><span>视频输入模式</span><span className="subtle-label">H3 Standard</span></div>
                  <div className="segmented-control input-mode-selector" role="group" aria-label="视频输入模式">
                    <button
                      type="button"
                      aria-label="纯文本"
                      aria-pressed={form.inputMode === 'text'}
                      className={form.inputMode === 'text' ? 'is-selected' : ''}
                      onClick={() => patchForm({ inputMode: 'text' })}
                    >
                      <strong>纯文本</strong><small>按描述生成视听内容</small>
                    </button>
                    <button
                      type="button"
                      aria-label="首尾帧"
                      aria-pressed={form.inputMode === 'keyframes'}
                      className={form.inputMode === 'keyframes' ? 'is-selected' : ''}
                      onClick={() => patchForm({ inputMode: 'keyframes' })}
                    >
                      <strong>首尾帧</strong><small>约束起始与最终构图</small>
                    </button>
                    <button
                      type="button"
                      aria-label="多模态参考"
                      aria-pressed={form.inputMode === 'references'}
                      className={form.inputMode === 'references' ? 'is-selected' : ''}
                      disabled={!referenceModeReady}
                      title={referenceCapability?.reason}
                      onClick={() => patchForm({ inputMode: 'references' })}
                    >
                      <strong>多模态参考</strong><small>图片、视频与音频条件</small>
                    </button>
                  </div>
                  {!referenceModeReady && referenceCapability?.reason && <p className="service-unavailable">{referenceCapability.reason}</p>}
                </section>
              )}
              {isStandardH3 && form.inputMode !== 'text' && (
                <ReferenceInputs
                  mode={form.inputMode}
                  form={form}
                  api={api}
                  disabled={busy}
                  onChange={patchForm}
                  onUploadStateChange={setIsUploadingAssets}
                />
              )}
            </>
          )}
          <GenerationControls
            form={form}
            services={connection.services}
            showAdvanced={showAdvanced}
            onChange={patchForm}
            onToggleAdvanced={() => setShowAdvanced((open) => !open)}
          />
          <button className="generate-button" type="button" onClick={submit} disabled={!canGenerate}>
            <span className="generate-icon" aria-hidden="true">✦</span>
            {busy ? (isMusic3 ? '正在生成音乐' : '正在生成视频') : (isMusic3 ? '生成音乐' : '生成视频')}
            <span className="button-arrow" aria-hidden="true">→</span>
          </button>
          <p className="privacy-note"><span>⌁</span> 仅通过本机安全连接访问 GB10 {isMusic3 ? '音乐' : '视频'}引擎</p>
        </div>
        <GenerationPanel
          job={currentJob}
          api={api}
          onRetry={() => { void retry(); }}
          onStop={() => { void stop(); }}
          isStopping={isStopping}
          stopError={stopError}
          flashVsr={connection.services?.flashVsr}
          deterministicUpscale={connection.services?.deterministicUpscale}
          onStartUpscale={(method, target) => {
            if (currentJob) void startUpscale(currentJob.id, method, target);
          }}
          onStopUpscale={() => { void stopUpscale(); }}
          isUpscaling={isUpscaling}
          upscaleError={upscaleError}
        />
      </section>

      <HistoryGallery
        history={history}
        api={api}
        onReuse={reuse}
        onRemove={removeHistory}
        deterministicUpscale={connection.services?.deterministicUpscale}
        onStartUpscale={(job, method, target) => { void startHistoryUpscale(job, method, target); }}
        onStopUpscale={() => { void stopUpscale(); }}
        isUpscaling={isUpscaling}
        upscaleError={upscaleError}
      />

      <footer className="app-footer">
        <span>H3 STUDIO</span><i /> <span>PRIVATE SESSION</span><i /> <span>24 FPS NATIVE AUDIO VIDEO</span>
      </footer>
    </main>
  );
}
