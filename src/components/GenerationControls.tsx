import { useState, type CSSProperties } from 'react';
import { RESOLUTION_PRESETS, type ComfyServiceCapabilities, type GenerationForm } from '../types';

interface GenerationControlsProps {
  form: GenerationForm;
  services?: ComfyServiceCapabilities;
  showAdvanced: boolean;
  onChange: (patch: Partial<GenerationForm>) => void;
  onToggleAdvanced: () => void;
}

const STANDARD_PRESET: Partial<GenerationForm> = {
  steps: 20,
  samplerName: 'res_multistep',
  turbo8Step: false,
  spargeAttention: true,
  spargeProfile: 'balanced',
  featureCacheSafe: false,
  featureCacheProfile: 'safe',
  easyCache: false,
  fusedModulation: false,
  vaeTileBatch: false,
};

const PREVIEW_90_PRESET: Partial<GenerationForm> = {
  steps: 6,
  samplerName: 'res_multistep',
  turbo8Step: false,
  spargeAttention: true,
  spargeProfile: 'fast',
  featureCacheSafe: false,
  featureCacheProfile: 'fast',
  easyCache: false,
  fusedModulation: true,
  vaeTileBatch: false,
};

const SAMPLER_OPTIONS: Array<{
  value: GenerationForm['samplerName'];
  label: string;
  badge: string;
  description: string;
}> = [
  {
    value: 'res_multistep',
    label: 'Res Multistep',
    badge: '推荐 · 稳定质量',
    description: '默认推荐。兼顾稳定性与细节表现，适合日常视频生成。',
  },
  {
    value: 'euler',
    label: 'Euler',
    badge: '基线 · 稠密采样',
    description: '用于稠密注意力的基线对比，便于评估不同推理优化的实际收益。',
  },
];

const STANDARD_STEP_OPTIONS = [6, 10, 15, 20, 25] as const;

function standardStepIndex(steps: number): number {
  const index = STANDARD_STEP_OPTIONS.indexOf(steps as typeof STANDARD_STEP_OPTIONS[number]);
  return index >= 0 ? index : STANDARD_STEP_OPTIONS.indexOf(20);
}

function actualFrameLength(seconds: number) {
  const raw = Math.max(5, Math.round(seconds * 24));
  return raw + ((5 - (raw % 17)) % 17);
}

function matchesPreset(form: GenerationForm, preset: Partial<GenerationForm>) {
  return Object.entries(preset).every(([key, value]) => form[key as keyof GenerationForm] === value);
}

function cacheProfileName(profile: GenerationForm['featureCacheProfile']) {
  if (profile === 'fast') return 'Fast';
  if (profile === 'aggressive') return 'Aggressive';
  return 'Safe';
}

function TAEH3PreviewToggle({
  form,
  services,
  onChange,
}: Pick<GenerationControlsProps, 'form' | 'services' | 'onChange'>) {
  const capability = services?.taeH3Preview;
  const available = capability?.available === true;
  return (
    <label className="feature-cache-control optimization-toggle realtime-preview-toggle">
      <input
        type="checkbox"
        aria-label="TAEH3 实时预览"
        checked={form.taeH3Preview}
        disabled={!available}
        onChange={(event) => onChange({ taeH3Preview: event.target.checked })}
      />
      <span className="feature-cache-track" aria-hidden="true"><i /></span>
      <span className="feature-cache-copy">
        <strong>TAEH3 实时预览</strong>
        <small>{capability?.reason || '每步近似解码以查看构图和运动；最终成片仍使用官方视频 VAE。'}</small>
      </span>
    </label>
  );
}

function FastH3AdvancedSettings({
  form,
  services,
  onChange,
}: Pick<GenerationControlsProps, 'form' | 'services' | 'onChange'>) {
  const cublasCapability = services?.fastH3CublasInt8;
  const adaGemmCapability = services?.fastH3AdaGemmInt8;
  const vaeCapability = services?.fastH3VaeTileBatch;
  const cublasAvailable = cublasCapability?.available === true;
  const adaGemmAvailable = adaGemmCapability?.available === true;
  const vaeAvailable = vaeCapability?.available === true;
  const status = `FastH3 VSA${form.fastH3AdaGemmInt8 ? ' + AdaGEMM INT8（实验性）' : form.fastH3CublasInt8 ? ' + GB10 cuBLAS INT8' : ''}${
    form.fastH3VaeTileBatch ? ' + VAE Tile Batch 4' : ''
  }`;

  return (
    <div className="advanced-content fasth3-advanced-content">
      <div className="advanced-field fast-contract-field">
        <span>固定采样配置</span>
        <span className="turbo-locked-steps">4 步 · Euler（固定）</span>
        <p className="sampler-description">VSA 常驻 gate · 4 steps · Euler</p>
      </div>
      <div className="advanced-field seed-field">
        <div className="advanced-field-heading">
          <label htmlFor="seed">随机种子（用于复现）</label>
          <small>可选</small>
        </div>
        <div className="seed-control">
          <input
            id="seed"
            inputMode="numeric"
            value={form.seed}
            aria-describedby="seed-help"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isSafeInteger(next) && next >= 0) onChange({ seed: next });
            }}
          />
          <button
            type="button"
            className="seed-reroll"
            aria-label="随机生成种子"
            onClick={() => onChange({ seed: Math.floor(Math.random() * 4_294_967_296) })}
          >
            ↻
          </button>
        </div>
        <p id="seed-help" className="seed-description">相同提示词、参数和种子可帮助复现实验结果。</p>
      </div>
      <div className="advanced-field cache-field">
        <span>GB10 优化项</span>
        <div className="optimization-switches">
          <label className="feature-cache-control optimization-toggle">
            <input
              type="checkbox"
              aria-label="GB10 cuBLAS INT8"
              checked={form.fastH3CublasInt8}
              disabled={!cublasAvailable}
              onChange={(event) => onChange({ fastH3CublasInt8: event.target.checked })}
            />
            <span className="feature-cache-track" aria-hidden="true"><i /></span>
            <span className="feature-cache-copy">
              <strong>GB10 cuBLAS INT8</strong>
              <small>{cublasCapability?.reason || '仅加速 QKV、输出投影与 MLP；不启用全模型预加载。'}</small>
            </span>
          </label>
          <label className="feature-cache-control optimization-toggle">
            <input
              type="checkbox"
              aria-label="AdaGEMM INT8（实验性）"
              checked={form.fastH3AdaGemmInt8}
              disabled={!adaGemmAvailable}
              onChange={(event) => onChange({ fastH3AdaGemmInt8: event.target.checked })}
            />
            <span className="feature-cache-track" aria-hidden="true"><i /></span>
            <span className="feature-cache-copy">
              <strong>AdaGEMM INT8（实验性）</strong>
              <small>{adaGemmCapability?.reason || '融合 QKV、输出投影与 FC1 的 INT8 GEMM；SwiGLU 路径回退。已在 GB10 实测加速，不保证逐像素一致。'}</small>
            </span>
          </label>
          <label className="feature-cache-control optimization-toggle">
            <input
              type="checkbox"
              aria-label="FastH3 VAE Tile Batch · batch 4"
              checked={form.fastH3VaeTileBatch}
              disabled={!vaeAvailable}
              onChange={(event) => onChange({ fastH3VaeTileBatch: event.target.checked })}
            />
            <span className="feature-cache-track" aria-hidden="true"><i /></span>
            <span className="feature-cache-copy">
              <strong>FastH3 VAE Tile Batch · batch 4</strong>
              <small>{vaeCapability?.reason || '批量解码视频 tiles，缩短解码阶段等待。'}</small>
            </span>
          </label>
        </div>
        <p className={`optimization-status ${form.fastH3CublasInt8 || form.fastH3AdaGemmInt8 || form.fastH3VaeTileBatch ? 'is-enabled' : ''}`}>
          {status}
        </p>
      </div>
    </div>
  );
}

function StandardOptimizationPicker({
  form,
  services,
  onChange,
  status,
  cacheProfile,
}: Pick<GenerationControlsProps, 'form' | 'services' | 'onChange'> & {
  status: string;
  cacheProfile: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const cublasCapability = services?.h3StandardCublasInt8;
  const adaGemmCapability = services?.h3StandardAdaGemmInt8;
  const cublasAvailable = cublasCapability?.available === true;
  const adaGemmAvailable = adaGemmCapability?.available === true;
  const activeCount = [
    form.spargeAttention,
    form.h3StandardCublasInt8 || form.h3StandardAdaGemmInt8,
    form.featureCacheSafe || form.easyCache,
    form.fusedModulation,
    form.vaeTileBatch,
    form.turbo8Step,
  ].filter(Boolean).length;
  const compactSummary = [
    form.spargeAttention ? `Sparge · ${form.spargeProfile === 'fast' ? 'Fast' : 'Balanced'}` : 'Dense · 基线',
    form.h3StandardAdaGemmInt8 ? 'AdaGEMM INT8' : form.h3StandardCublasInt8 ? 'cuBLAS INT8' : undefined,
    form.easyCache ? 'EasyCache' : form.featureCacheSafe ? `FirstBlockCache · ${cacheProfile}` : undefined,
    form.fusedModulation ? 'Fused Modulation' : undefined,
    form.vaeTileBatch ? 'VAE Tile Batch' : undefined,
    form.turbo8Step ? 'Turbo LoRA' : undefined,
  ].filter((item): item is string => Boolean(item)).slice(0, 2).join(' · ');

  return (
    <section className={`standard-optimization-picker ${isOpen ? 'is-open' : ''}`} aria-label="推理优化">
      <button
        type="button"
        className="standard-optimization-trigger"
        aria-expanded={isOpen}
        aria-controls="standard-optimization-options"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="standard-optimization-trigger-copy">
          <strong>推理优化</strong>
          <small>{compactSummary}</small>
        </span>
        <span className={`optimization-count ${activeCount > 0 ? 'is-active' : ''}`}>{activeCount > 0 ? `${activeCount} 项已启用` : '基线'}</span>
        <span className="standard-optimization-configure">配置 <i aria-hidden="true">⌄</i></span>
      </button>

      {isOpen && (
        <div id="standard-optimization-options" className="standard-optimization-options">
          <div className="standard-optimization-groups">
            <section className="optimization-picker-group">
              <div className="optimization-picker-heading">
                <strong>注意力</strong>
                <small>稀疏路由与档位</small>
              </div>
              <label className="feature-cache-control compact-optimization-choice">
                <input
                  type="checkbox"
                  aria-label="SpargeAttention"
                  checked={form.spargeAttention}
                  onChange={(event) => onChange({ spargeAttention: event.target.checked })}
                />
                <span className="feature-cache-track" aria-hidden="true"><i /></span>
                <span className="feature-cache-copy">
                  <strong>SpargeAttention</strong>
                  <small>关闭后回到 Sage 稠密注意力。</small>
                </span>
              </label>
              {form.spargeAttention && (
                <div className="compact-profile-picker">
                  <span>路由档位</span>
                  <div className="cache-profile-buttons" role="group" aria-label="SpargeAttention 档位">
                    <button
                      type="button"
                      className={form.spargeProfile === 'balanced' ? 'is-selected' : ''}
                      aria-pressed={form.spargeProfile === 'balanced'}
                      onClick={() => onChange({ spargeProfile: 'balanced' })}
                    >
                      Balanced — 0.15 / 0.12
                    </button>
                    <button
                      type="button"
                      className={form.spargeProfile === 'fast' ? 'is-selected' : ''}
                      aria-pressed={form.spargeProfile === 'fast'}
                      onClick={() => onChange({ spargeProfile: 'fast' })}
                    >
                      Fast — 0.10 / 0.08
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="optimization-picker-group">
              <div className="optimization-picker-heading">
                <strong>计算内核</strong>
                <small>三选一；INT8 可做 A/B</small>
              </div>
              <div className="kernel-choice-list" role="radiogroup" aria-label="计算内核">
                <label className="kernel-choice">
                  <input
                    type="radio"
                    name="standard-kernel"
                    aria-label="默认计算（FP16/BF16）"
                    checked={!form.h3StandardCublasInt8 && !form.h3StandardAdaGemmInt8}
                    onChange={() => onChange({ h3StandardCublasInt8: false, h3StandardAdaGemmInt8: false })}
                  />
                  <span className="kernel-choice-mark" aria-hidden="true" />
                  <span><strong>默认计算</strong><small>稳定的通用路径</small></span>
                </label>
                <label className="kernel-choice">
                  <input
                    type="radio"
                    name="standard-kernel"
                    aria-label="GB10 cuBLAS INT8"
                    checked={form.h3StandardCublasInt8}
                    disabled={!cublasAvailable}
                    onChange={() => onChange({ h3StandardCublasInt8: true })}
                  />
                  <span className="kernel-choice-mark" aria-hidden="true" />
                  <span><strong>GB10 cuBLAS INT8</strong><small>{cublasCapability?.reason || 'QKV、输出投影与 MLP 加速'}</small></span>
                </label>
                <label className="kernel-choice">
                  <input
                    type="radio"
                    name="standard-kernel"
                    aria-label="AdaGEMM INT8（实验性）"
                    checked={form.h3StandardAdaGemmInt8}
                    disabled={!adaGemmAvailable}
                    onChange={() => onChange({ h3StandardAdaGemmInt8: true })}
                  />
                  <span className="kernel-choice-mark" aria-hidden="true" />
                  <span><strong>AdaGEMM INT8 <em>实验性</em></strong><small>{adaGemmCapability?.reason || '融合 QKV、输出投影与 FC1；不保证逐像素一致'}</small></span>
                </label>
              </div>
            </section>

            <section className="optimization-picker-group">
              <div className="optimization-picker-heading">
                <strong>缓存复用</strong>
                <small>FirstBlock 与 EasyCache 互斥</small>
              </div>
              <div className="compact-choice-list">
                <label className="feature-cache-control compact-optimization-choice">
                  <input
                    type="checkbox"
                    aria-label={`FirstBlockCache ${cacheProfile}`}
                    checked={form.featureCacheSafe}
                    onChange={(event) => onChange({ featureCacheSafe: event.target.checked })}
                  />
                  <span className="feature-cache-track" aria-hidden="true"><i /></span>
                  <span className="feature-cache-copy"><strong>FirstBlockCache</strong><small>首块特征复用</small></span>
                </label>
                <label className="feature-cache-control compact-optimization-choice">
                  <input
                    type="checkbox"
                    aria-label="EasyCache"
                    checked={form.easyCache}
                    onChange={(event) => onChange({ easyCache: event.target.checked })}
                  />
                  <span className="feature-cache-track" aria-hidden="true"><i /></span>
                  <span className="feature-cache-copy"><strong>EasyCache · 0.20</strong><small>整步去噪复用，适合极速预览</small></span>
                </label>
              </div>
              {form.featureCacheSafe && (
                <div className="compact-profile-picker">
                  <span>FirstBlockCache 档位</span>
                  <div className="cache-profile-buttons cache-profile-options" role="group" aria-label="FirstBlockCache 档位">
                    <button type="button" className={form.featureCacheProfile === 'safe' ? 'is-selected' : ''} aria-pressed={form.featureCacheProfile === 'safe'} onClick={() => onChange({ featureCacheProfile: 'safe' })}>H3 Safe — 0.08 / max 2</button>
                    <button type="button" className={form.featureCacheProfile === 'fast' ? 'is-selected' : ''} aria-pressed={form.featureCacheProfile === 'fast'} onClick={() => onChange({ featureCacheProfile: 'fast' })}>H3 Fast — 0.10 / max 2</button>
                    <button type="button" className={form.featureCacheProfile === 'aggressive' ? 'is-selected' : ''} aria-pressed={form.featureCacheProfile === 'aggressive'} onClick={() => onChange({ featureCacheProfile: 'aggressive' })}>H3 Aggressive — 0.12 / max 2</button>
                  </div>
                  {form.steps <= 6 && <p className="cache-impact-note">6 步任务通常没有可复用的中段步骤，缓存可能不会命中。</p>}
                </div>
              )}
            </section>

            <section className="optimization-picker-group">
              <div className="optimization-picker-heading">
                <strong>模型与解码</strong>
                <small>可独立叠加测试</small>
              </div>
              <div className="compact-choice-list">
                <label className="feature-cache-control compact-optimization-choice">
                  <input type="checkbox" aria-label="Fused Modulation" checked={form.fusedModulation} onChange={(event) => onChange({ fusedModulation: event.target.checked })} />
                  <span className="feature-cache-track" aria-hidden="true"><i /></span>
                  <span className="feature-cache-copy"><strong>Fused Modulation</strong><small>融合 H3 调制路径</small></span>
                </label>
                <label className="feature-cache-control compact-optimization-choice">
                  <input type="checkbox" aria-label="VAE Tile Batch · batch 2" checked={form.vaeTileBatch} onChange={(event) => onChange({ vaeTileBatch: event.target.checked })} />
                  <span className="feature-cache-track" aria-hidden="true"><i /></span>
                  <span className="feature-cache-copy"><strong>VAE Tile Batch · batch 2</strong><small>批量解码视频 tiles</small></span>
                </label>
                <label className="feature-cache-control compact-optimization-choice">
                  <input type="checkbox" aria-label="Turbo LoRA 8 steps" checked={form.turbo8Step} onChange={(event) => onChange({ turbo8Step: event.target.checked })} />
                  <span className="feature-cache-track" aria-hidden="true"><i /></span>
                  <span className="feature-cache-copy"><strong>Turbo LoRA · 8 steps</strong><small>快速预览，自动锁定 8 步</small></span>
                </label>
              </div>
            </section>
          </div>
          <p className={`optimization-status standard-optimization-status ${activeCount > 1 || form.h3StandardCublasInt8 || form.h3StandardAdaGemmInt8 ? 'is-enabled' : ''}`}>{status}</p>
        </div>
      )}
    </section>
  );
}

function Music3Controls({ form, onChange }: Pick<GenerationControlsProps, 'form' | 'onChange'>) {
  const durationProgress = ((form.seconds - 5) / (300 - 5)) * 100;
  return (
    <>
      <div className="control-section duration-section music-duration-section">
        <div className="field-heading">
          <label htmlFor="music-duration">音乐时长</label>
          <output className="duration-output" htmlFor="music-duration">{form.seconds}<small> 秒</small></output>
        </div>
        <div className="duration-control">
          <span>5s</span>
          <input
            id="music-duration"
            type="range"
            min="5"
            max="300"
            step="5"
            value={form.seconds}
            style={{ '--duration-progress': `${Math.max(0, Math.min(100, durationProgress))}%` } as CSSProperties}
            onChange={(event) => onChange({ seconds: Number(event.target.value) })}
          />
          <span>300s</span>
        </div>
        <p className="output-detail">固定 30 步 · Euler · 可选分块音频解码</p>
      </div>
      <div className="music-runtime-settings">
        <div className="advanced-field seed-field">
          <div className="advanced-field-heading">
            <label htmlFor="music-seed">随机种子（用于复现）</label>
            <small>可选</small>
          </div>
          <div className="seed-control">
            <input
              id="music-seed"
              inputMode="numeric"
              value={form.seed}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isSafeInteger(next) && next >= 0) onChange({ seed: next });
              }}
            />
            <button type="button" className="seed-reroll" aria-label="随机生成音乐种子" onClick={() => onChange({ seed: Math.floor(Math.random() * 4_294_967_296) })}>↻</button>
          </div>
        </div>
        <label className="feature-cache-control optimization-toggle music-tile-toggle">
          <input
            type="checkbox"
            aria-label="Music3 分块音频解码"
            checked={form.musicTiledDecode}
            onChange={(event) => onChange({ musicTiledDecode: event.target.checked })}
          />
          <span className="feature-cache-track" aria-hidden="true"><i /></span>
          <span className="feature-cache-copy">
            <strong>分块音频解码</strong>
            <small>长音频分段还原，降低解码阶段的显存峰值。</small>
          </span>
        </label>
      </div>
    </>
  );
}

export function GenerationControls({ form, services, showAdvanced, onChange, onToggleAdvanced }: GenerationControlsProps) {
  const isFastH3 = form.service === 'fasth3_vsa';
  const isMusic3 = form.service === 'music3';
  const fastH3Capability = services?.fastH3Vsa;
  const fastH3Available = fastH3Capability?.available === true;
  const music3Capability = services?.music3;
  const music3Available = music3Capability?.available === true;
  const frames = actualFrameLength(form.seconds);
  const actualSeconds = (frames / 24).toFixed(2);
  const durationProgress = ((form.seconds - 3) / (15 - 3)) * 100;
  const stepIndex = standardStepIndex(form.steps);
  const samplingStepProgress = (stepIndex / (STANDARD_STEP_OPTIONS.length - 1)) * 100;
  const cacheProfile = cacheProfileName(form.featureCacheProfile);
  const spargeName = form.spargeAttention ? (form.spargeProfile === 'fast' ? 'Sparge Fast' : 'Sparge') : 'Dense';
  const optimizationStatus = `Sage + ${spargeName}${form.turbo8Step ? ' + Turbo 8-step' : ''}${
    form.easyCache ? ' + EasyCache' : form.featureCacheSafe ? ` + FirstBlockCache ${cacheProfile}` : ''
  }${form.h3StandardAdaGemmInt8 ? ' + AdaGEMM INT8（实验性）' : form.h3StandardCublasInt8 ? ' + GB10 cuBLAS INT8' : ''}${form.fusedModulation ? ' + Fused Modulation' : ''}${form.vaeTileBatch ? ' + VAE Tile Batch' : ''}${
    form.samplerName !== 'res_multistep' ? ` + ${form.samplerName}` : ''
  }`;
  const isStandardPreset = !isMusic3 && matchesPreset(form, STANDARD_PRESET);
  const isPreviewPreset = !isMusic3 && matchesPreset(form, PREVIEW_90_PRESET);
  const sampler = SAMPLER_OPTIONS.find((option) => option.value === form.samplerName) ?? SAMPLER_OPTIONS[0];
  const presetSummary = isPreviewPreset ? '极速预览' : isStandardPreset ? '标准质量' : '自定义组合';
  const advancedSummary = isFastH3
    ? '4 步 · Euler（固定）'
    : isMusic3 ? '30 步 · Euler（固定）' : form.turbo8Step ? '8 步 · Turbo LoRA' : `${form.steps} 步 · ${presetSummary}`;

  return (
    <section className="generation-controls" aria-label="生成参数">
      <div className="control-section service-section">
        <div className="field-heading"><span>推理服务</span><span className="subtle-label">可做同配置 A/B</span></div>
        <div className="segmented-control service-selector" role="group" aria-label="推理服务">
          <button
            type="button"
            aria-label="H3 Standard"
            aria-pressed={form.service === 'h3_standard'}
            className={form.service === 'h3_standard' ? 'is-selected' : ''}
            onClick={() => onChange({ service: 'h3_standard' })}
          >
            <strong>H3 Standard</strong>
            <small>原有步数、采样器与优化组合</small>
          </button>
          <button
            type="button"
            aria-label="FastH3 VSA"
            aria-pressed={isFastH3}
            className={isFastH3 ? 'is-selected' : ''}
            disabled={!fastH3Available}
            title={fastH3Capability?.reason}
            onClick={() => onChange({ service: 'fasth3_vsa' })}
          >
            <strong>FastH3 VSA</strong>
            <small>固定 4-step Euler · VSA 稀疏图</small>
          </button>
          <button
            type="button"
            aria-label="MiniMax Music3"
            aria-pressed={isMusic3}
            className={isMusic3 ? 'is-selected' : ''}
            disabled={!music3Available}
            title={music3Capability?.reason}
            onClick={() => onChange({ service: 'music3' })}
          >
            <strong>MiniMax Music3</strong>
            <small>本机音乐生成 · MP3</small>
          </button>
        </div>
        {!fastH3Available && fastH3Capability?.reason && <p className="service-unavailable">{fastH3Capability.reason}</p>}
        {!music3Available && music3Capability?.reason && <p className="service-unavailable">{music3Capability.reason}</p>}
      </div>
      {isMusic3 ? <Music3Controls form={form} onChange={onChange} /> : <>
      <div className="control-section">
        <div className="field-heading"><span>输出清晰度</span><span className="subtle-label">稳定预设</span></div>
        <div className="segmented-control resolutions" role="group" aria-label="输出清晰度">
          {RESOLUTION_PRESETS.map((preset) => {
            const selected = form.width === preset.width && form.height === preset.height;
            return (
              <button
                type="button"
                key={preset.label}
                aria-pressed={selected}
                className={selected ? 'is-selected' : ''}
                onClick={() => onChange({ width: preset.width, height: preset.height })}
              >
                <strong>{preset.label}</strong>
                <small>{preset.detail}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="control-section duration-section">
        <div className="field-heading">
          <label htmlFor="duration">视频时长</label>
          <output className="duration-output" htmlFor="duration">{form.seconds}<small> 秒</small></output>
        </div>
        <div className="duration-control">
          <span>3s</span>
          <input
            id="duration"
            type="range"
            min="3"
            max="15"
            step="1"
            value={form.seconds}
            style={{ '--duration-progress': `${durationProgress}%` } as CSSProperties}
            onChange={(event) => onChange({ seconds: Number(event.target.value) })}
          />
          <span>15s</span>
        </div>
        <p className="output-detail">实际输出：{form.width} × {form.height} · {frames} 帧 · 约 {actualSeconds} 秒 · 24 FPS</p>
      </div>

      <div className="control-section realtime-preview-section">
        <div className="field-heading"><span>实时预览</span><span className="subtle-label">独立开关</span></div>
        <TAEH3PreviewToggle form={form} services={services} onChange={onChange} />
      </div>

      <div className={`advanced-settings ${showAdvanced ? 'is-open' : ''}`}>
        <button className="advanced-toggle" type="button" onClick={onToggleAdvanced} aria-expanded={showAdvanced}>
          <span className="advanced-toggle-copy">
            <strong>精细设置</strong>
            <small className="advanced-summary">{showAdvanced ? '采样器、种子与推理优化' : advancedSummary}</small>
          </span>
          <span className="advanced-state">{showAdvanced ? '收起' : '展开'}</span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </button>
        {showAdvanced && isFastH3 && <FastH3AdvancedSettings form={form} services={services} onChange={onChange} />}
        {showAdvanced && !isFastH3 && (
          <div className="advanced-content">
            <div className="advanced-field preset-field">
              <div className="cache-profile-heading">
                <span>推理预设</span>
                <small>{isPreviewPreset ? '已应用极速预览组合' : isStandardPreset ? '当前为标准质量组合' : '当前为自定义组合'}</small>
              </div>
              <div className="optimization-presets" role="group" aria-label="推理预设">
                <button
                  type="button"
                  className={isStandardPreset ? 'is-selected' : ''}
                  aria-pressed={isStandardPreset}
                  onClick={() => onChange(STANDARD_PRESET)}
                >
                  标准质量
                </button>
                <button
                  type="button"
                  className={isPreviewPreset ? 'is-selected' : ''}
                  aria-pressed={isPreviewPreset}
                  onClick={() => onChange(PREVIEW_90_PRESET)}
                >
                  极速预览
                </button>
              </div>
            </div>
            <div className="advanced-field">
              {form.turbo8Step ? (
                <>
                  <span>采样步数</span>
                  <span className="turbo-locked-steps">8 步（由 Turbo LoRA 锁定）</span>
                </>
              ) : (
                <div className="sampling-step-slider">
                  <div className="advanced-field-heading">
                    <label htmlFor="sampling-steps">采样步数</label>
                    <small>{STANDARD_STEP_OPTIONS[stepIndex]} 步</small>
                  </div>
                  <input
                    id="sampling-steps"
                    type="range"
                    min="0"
                    max={STANDARD_STEP_OPTIONS.length - 1}
                    step="1"
                    value={stepIndex}
                    aria-valuetext={`${STANDARD_STEP_OPTIONS[stepIndex]} 步`}
                    style={{ '--sampling-step-progress': `${samplingStepProgress}%` } as CSSProperties}
                    onChange={(event) => {
                      const nextIndex = Number(event.target.value);
                      const steps = STANDARD_STEP_OPTIONS[nextIndex];
                      if (steps !== undefined) onChange({ steps });
                    }}
                  />
                  <div className="sampling-step-ticks" aria-hidden="true">
                    {STANDARD_STEP_OPTIONS.map((steps) => <span key={steps}>{steps}</span>)}
                  </div>
                </div>
              )}
            </div>
            <div className="advanced-field sampler-field">
              <div className="advanced-field-heading">
                <label htmlFor="sampler">采样器</label>
                <small>影响去噪路径</small>
              </div>
              <div className="sampler-select-card">
                <select
                  id="sampler"
                  value={form.samplerName}
                  aria-describedby="sampler-description"
                  onChange={(event) => onChange({ samplerName: event.target.value as GenerationForm['samplerName'] })}
                >
                  {SAMPLER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <span className="sampler-select-display" aria-hidden="true">
                  <span>
                    <strong>{sampler.label}</strong>
                    <small>{sampler.badge}</small>
                  </span>
                  <span className="sampler-select-chevron">⌄</span>
                </span>
              </div>
              <p id="sampler-description" className="sampler-description">{sampler.description}</p>
            </div>
            <div className="advanced-field seed-field">
              <div className="advanced-field-heading">
                <label htmlFor="seed">随机种子（用于复现）</label>
                <small>可选</small>
              </div>
              <div className="seed-control">
                <input
                  id="seed"
                  inputMode="numeric"
                  value={form.seed}
                  aria-describedby="seed-help"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isSafeInteger(next) && next >= 0) onChange({ seed: next });
                  }}
                />
                <button
                  type="button"
                  className="seed-reroll"
                  aria-label="随机生成种子"
                  onClick={() => onChange({ seed: Math.floor(Math.random() * 4_294_967_296) })}
                >
                  ↻
                </button>
              </div>
              <p id="seed-help" className="seed-description">相同提示词、参数和种子可帮助复现实验结果。</p>
            </div>
            <StandardOptimizationPicker
              form={form}
              services={services}
              onChange={onChange}
              status={optimizationStatus}
              cacheProfile={cacheProfile}
            />
          </div>
        )}
      </div>
      </>}
    </section>
  );
}
