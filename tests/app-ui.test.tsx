// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { StudioApi } from '../src/api';
import type { ComfyServiceCapabilities, GenerationForm, GenerationJob } from '../src/types';

const api: StudioApi = {
  getHealth: vi.fn().mockResolvedValue({ connected: true, deviceName: 'NVIDIA GB10' }),
  submitJob: vi.fn(),
  stopJob: vi.fn(),
  openJobEvents: vi.fn(() => () => undefined),
  startUpscale: vi.fn(),
  getUpscaleJob: vi.fn(),
  stopUpscale: vi.fn(),
  openUpscaleEvents: vi.fn(() => () => undefined),
  mediaUrl: vi.fn(),
};

async function openStandardOptimization(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
  const scoped = within(container);
  await user.click(scoped.getByRole('button', { name: /精细设置/i }));
  await user.click(within(scoped.getByRole('region', { name: '推理优化' })).getByRole('button', { name: /配置/ }));
}

afterEach(() => cleanup());

describe('H3 Studio primary screen', () => {
  it('shows two approved resolution choices and a disabled generate button without a prompt', () => {
    render(<App api={api} />);

    expect(screen.getByRole('button', { name: /480P/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /720P/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /生成视频/i })).toBeDisabled();
  });

  it('lets a creator select a duration up to fifteen seconds', () => {
    render(<App api={api} />);

    expect(screen.getByLabelText('视频时长')).toHaveAttribute('max', '15');
  });

  it('submits the H3 Standard cuBLAS option from its optimization list', async () => {
    const user = userEvent.setup();
    const submitted: unknown[] = [];
    const standardApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
        } as unknown as ComfyServiceCapabilities,
      }),
      submitJob: async (input) => {
        submitted.push(input);
        return {
          id: 'standard-cublas',
          state: 'queued',
          actualFrames: 124,
          actualSeconds: 5.17,
          totalElapsedMs: 0,
          ...input,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
        } as GenerationJob;
      },
      stopJob: async () => { throw new Error('not used'); },
      openJobEvents: () => () => undefined,
      mediaUrl: () => '/api/media?filename=standard.mp4',
    };
    const view = render(<App api={standardApi} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const cublasSwitch = scoped.getByRole('radio', { name: 'GB10 cuBLAS INT8' });
    await waitFor(() => expect(cublasSwitch).toBeEnabled());

    await user.click(cublasSwitch);
    expect(cublasSwitch).toBeChecked();
    expect(scoped.getByText('Sage + Sparge + GB10 cuBLAS INT8')).toBeVisible();

    await user.type(scoped.getByLabelText(/创作描述/), 'A cinematic cup of coffee with gentle steam');
    await user.click(scoped.getByRole('button', { name: '生成视频' }));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ service: 'h3_standard', h3StandardCublasInt8: true });
  });

  it('selects AdaGEMM INT8 for H3 Standard and clears cuBLAS INT8', async () => {
    const user = userEvent.setup();
    const standardApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          h3StandardAdaGemmInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
        } as unknown as ComfyServiceCapabilities,
      }),
    };
    const view = render(<App api={standardApi} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const cublasSwitch = scoped.getByRole('radio', { name: 'GB10 cuBLAS INT8' });
    const adaGemmSwitch = scoped.getByRole('radio', { name: 'AdaGEMM INT8（实验性）' });
    await waitFor(() => expect(adaGemmSwitch).toBeEnabled());

    await user.click(cublasSwitch);
    await user.click(adaGemmSwitch);

    expect(adaGemmSwitch).toBeChecked();
    expect(cublasSwitch).not.toBeChecked();
    expect(scoped.getByText('Sage + Sparge + AdaGEMM INT8（实验性）')).toBeVisible();
  });

  it('keeps Standard inference optimization compact until configured and uses an exclusive kernel choice', async () => {
    const user = userEvent.setup();
    const standardApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          h3StandardAdaGemmInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
        } as unknown as ComfyServiceCapabilities,
      }),
    };
    const view = render(<App api={standardApi} />);
    const scoped = within(view.container);

    await user.click(scoped.getByRole('button', { name: /精细设置/i }));

    const picker = scoped.getByRole('region', { name: '推理优化' });
    const configure = within(picker).getByRole('button', { name: /配置/ });
    expect(configure).toHaveAttribute('aria-expanded', 'false');
    expect(within(picker).getByText('Sparge · Balanced')).toBeVisible();
    expect(within(picker).queryByRole('checkbox', { name: 'SpargeAttention' })).not.toBeInTheDocument();

    await user.click(configure);

    const kernelGroup = within(picker).getByRole('radiogroup', { name: '计算内核' });
    const cublas = within(kernelGroup).getByRole('radio', { name: 'GB10 cuBLAS INT8' });
    const adaGemm = within(kernelGroup).getByRole('radio', { name: 'AdaGEMM INT8（实验性）' });
    expect(cublas).toBeEnabled();
    expect(adaGemm).toBeEnabled();

    await user.click(cublas);
    await user.click(adaGemm);

    expect(cublas).not.toBeChecked();
    expect(adaGemm).toBeChecked();
  });

  it('uses a fixed batch-four VAE switch instead of per-batch FastH3 controls', async () => {
    const user = userEvent.setup();
    const submitted: unknown[] = [];
    const fastApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3Gb10VsaKernel: { available: true },
          fastH3FusedModulation: { available: true },
          fastH3VaeTileBatch: { available: true },
        },
      }),
      submitJob: async (input) => {
        submitted.push(input);
        return {
          id: 'fasth3-optimized',
          state: 'queued',
          actualFrames: 124,
          actualSeconds: 5.17,
          totalElapsedMs: 0,
          ...input,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
        } as GenerationJob;
      },
      stopJob: async () => { throw new Error('not used'); },
      openJobEvents: () => () => undefined,
      mediaUrl: () => '/api/media?filename=fasth3.mp4',
    };
    const view = render(<App api={fastApi} />);
    const scoped = within(view.container);

    const fastService = scoped.getByRole('button', { name: 'FastH3 VSA' });
    await waitFor(() => expect(fastService).toBeEnabled());
    await user.click(fastService);
    await user.click(scoped.getByRole('button', { name: /精细设置/i }));

    expect(scoped.getByText('4 步 · Euler（固定）')).toBeVisible();
    expect(scoped.getByText('VSA 常驻 gate · 4 steps · Euler')).toBeVisible();
    expect(scoped.queryByLabelText('采样器')).not.toBeInTheDocument();
    expect(scoped.queryByRole('checkbox', { name: 'SpargeAttention' })).not.toBeInTheDocument();
    expect(scoped.queryByText('FastH3 推理档位')).not.toBeInTheDocument();

    const picker = scoped.getByRole('region', { name: '推理优化' });
    const configure = within(picker).getByRole('button', { name: /配置/ });
    expect(configure).toHaveAttribute('aria-expanded', 'false');
    await user.click(configure);

    const vsaLayoutKernel = within(picker).getByRole('checkbox', { name: 'VSA Fused Layout Engine' });
    expect(vsaLayoutKernel).toBeEnabled();
    expect(vsaLayoutKernel).toBeChecked();
    expect(within(picker).getByText('VSA Fused Layout Engine')).toBeVisible();
    expect(within(picker).queryByText('VSA Fused Layout Engine 无损')).not.toBeInTheDocument();
    expect(within(picker).getByText('无损 · 等价布局重排')).toBeVisible();

    const kernelGroup = within(picker).getByRole('radiogroup', { name: '计算内核' });
    await user.click(within(kernelGroup).getByRole('radio', { name: 'GB10 cuBLAS INT8' }));
    await user.click(within(picker).getByRole('checkbox', { name: 'FastH3 Fused Modulation' }));
    const vaeTileBatch = within(picker).getByRole('checkbox', { name: 'VAE Tile Batch' });
    expect(vaeTileBatch).toBeEnabled();
    expect(within(picker).queryByRole('radiogroup', { name: '视频 VAE 解码' })).not.toBeInTheDocument();
    expect(within(picker).queryByRole('radio', { name: 'FastH3 VAE Tile Batch · batch 1' })).not.toBeInTheDocument();
    expect(within(picker).queryByRole('radio', { name: 'FastH3 VAE Tile Batch · batch 4' })).not.toBeInTheDocument();
    await user.click(vaeTileBatch);
    await user.type(scoped.getByLabelText(/创作描述/), 'A cinematic cup of coffee with gentle steam');
    await user.click(scoped.getByRole('button', { name: '生成视频' }));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      service: 'fasth3_vsa',
      fastH3CublasInt8: true,
      fastH3Gb10VsaKernel: true,
      fastH3FusedModulation: true,
      fastH3VaeTileBatch: true,
      fastH3VaeTileBatchSize: 4,
      steps: 4,
      samplerName: 'euler',
    });
    expect(submitted[0]).not.toHaveProperty('fastH3Profile');
  });

  it('selects AdaGEMM INT8 for FastH3 and clears cuBLAS INT8', async () => {
    const user = userEvent.setup();
    const submitted: unknown[] = [];
    const fastApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3AdaGemmInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
        } as unknown as ComfyServiceCapabilities,
      }),
      submitJob: async (input) => {
        submitted.push(input);
        return {
          id: 'fasth3-adagemm',
          state: 'queued',
          actualFrames: 124,
          actualSeconds: 5.17,
          totalElapsedMs: 0,
          ...input,
          createdAt: '2026-09-03T00:00:00.000Z',
          updatedAt: '2026-09-03T00:00:00.000Z',
        } as GenerationJob;
      },
      stopJob: async () => { throw new Error('not used'); },
      openJobEvents: () => () => undefined,
      mediaUrl: () => '/api/media?filename=fasth3-adagemm.mp4',
    };
    const view = render(<App api={fastApi} />);
    const scoped = within(view.container);

    await user.click(scoped.getByRole('button', { name: 'FastH3 VSA' }));
    await user.click(scoped.getByRole('button', { name: /精细设置/i }));
    const picker = scoped.getByRole('region', { name: '推理优化' });
    await user.click(within(picker).getByRole('button', { name: /配置/ }));
    const kernelGroup = within(picker).getByRole('radiogroup', { name: '计算内核' });
    const cublasSwitch = within(kernelGroup).getByRole('radio', { name: 'GB10 cuBLAS INT8' });
    const adaGemmSwitch = within(kernelGroup).getByRole('radio', { name: 'AdaGEMM INT8（实验性）' });
    await waitFor(() => expect(adaGemmSwitch).toBeEnabled());

    await user.click(cublasSwitch);
    await user.click(adaGemmSwitch);
    expect(adaGemmSwitch).toBeChecked();
    expect(cublasSwitch).not.toBeChecked();
    expect(scoped.getByText('FastH3 VSA + AdaGEMM INT8（实验性）')).toBeVisible();

    await user.type(scoped.getByLabelText(/创作描述/), 'A cinematic cup of coffee with gentle steam');
    await user.click(scoped.getByRole('button', { name: '生成视频' }));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      service: 'fasth3_vsa',
      fastH3CublasInt8: false,
      fastH3AdaGemmInt8: true,
    });
  });

  it('keeps an unavailable FastH3 service disabled and explains why', async () => {
    const unavailableApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: false },
          fastH3Vsa: { available: false, reason: '缺少 H3VSA 节点。' },
          fastH3CublasInt8: { available: false },
          fastH3VaeTileBatch: { available: false },
        },
      }),
    };
    const view = render(<App api={unavailableApi} />);
    const scoped = within(view.container);

    const fastService = scoped.getByRole('button', { name: 'FastH3 VSA' });
    await waitFor(() => expect(fastService).toBeDisabled());
    expect(scoped.getByText('缺少 H3VSA 节点。')).toBeVisible();
  });

  it('keeps the random seed out of the collapsed advanced-settings summary', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);
    const advancedToggle = scoped.getByRole('button', { name: /精细设置/i });

    expect(advancedToggle).toHaveTextContent('20 步 · 标准质量');
    expect(advancedToggle).not.toHaveTextContent(/\d{6,}/);

    await user.click(advancedToggle);

    const sampler = scoped.getByLabelText('采样器');
    expect(sampler).toHaveValue('res_multistep');
    expect(scoped.getByText('推荐 · 稳定质量')).toBeVisible();

    await user.selectOptions(sampler, 'euler');

    expect(sampler).toHaveValue('euler');
    expect(scoped.getByText('基线 · 稠密采样')).toBeVisible();
    expect(scoped.getByLabelText('随机种子（用于复现）')).toBeVisible();
    expect(scoped.getByText('相同提示词、参数和种子可帮助复现实验结果。')).toBeVisible();
  });

  it('lets a creator opt into FirstBlockCache Safe from advanced settings', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const cacheSwitch = scoped.getByRole('checkbox', { name: 'FirstBlockCache Safe' });
    expect(cacheSwitch).not.toBeChecked();

    await user.click(cacheSwitch);

    expect(cacheSwitch).toBeChecked();
    expect(scoped.getByText('Sage + Sparge + FirstBlockCache Safe')).toBeVisible();
  });

  it('lets a creator opt into VAE Tile Batch from advanced settings', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const batchSwitch = scoped.getByRole('checkbox', { name: 'VAE Tile Batch · batch 2' });
    expect(batchSwitch).not.toBeChecked();

    await user.click(batchSwitch);

    expect(batchSwitch).toBeChecked();
    expect(scoped.getByText('Sage + Sparge + VAE Tile Batch')).toBeVisible();
  });

  it('makes EasyCache and FirstBlockCache mutually exclusive', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const firstBlockCache = scoped.getByRole('checkbox', { name: 'FirstBlockCache Safe' });
    const easyCache = scoped.getByRole('checkbox', { name: 'EasyCache' });

    await user.click(easyCache);

    expect(easyCache).toBeChecked();
    expect(firstBlockCache).not.toBeChecked();
    expect(scoped.getByText('Sage + Sparge + EasyCache')).toBeVisible();

    await user.click(firstBlockCache);

    expect(firstBlockCache).toBeChecked();
    expect(easyCache).not.toBeChecked();
    expect(scoped.getByText('Sage + Sparge + FirstBlockCache Safe')).toBeVisible();
  });

  it('lets a creator select the H3 Fast cache preset from advanced settings', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    await user.click(scoped.getByRole('checkbox', { name: 'FirstBlockCache Safe' }));
    await user.click(scoped.getByRole('button', { name: 'H3 Fast — 0.10 / max 2' }));

    expect(scoped.getByRole('button', { name: 'H3 Fast — 0.10 / max 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(scoped.getByText('Sage + Sparge + FirstBlockCache Fast')).toBeVisible();
  });

  it('lets a creator select the H3 Aggressive cache preset from advanced settings', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    await user.click(scoped.getByRole('checkbox', { name: 'FirstBlockCache Safe' }));
    await user.click(scoped.getByRole('button', { name: 'H3 Aggressive — 0.12 / max 2' }));

    expect(scoped.getByRole('button', { name: 'H3 Aggressive — 0.12 / max 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(scoped.getByRole('checkbox', { name: 'FirstBlockCache Aggressive' })).toBeChecked();
    expect(scoped.getByText('Sage + Sparge + FirstBlockCache Aggressive')).toBeVisible();
  });

  it('lets a creator disable SpargeAttention for a dense-attention baseline', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const spargeSwitch = scoped.getByRole('checkbox', { name: 'SpargeAttention' });
    expect(spargeSwitch).toBeChecked();

    await user.click(spargeSwitch);

    expect(spargeSwitch).not.toBeChecked();
    expect(scoped.getByText('Sage + Dense')).toBeVisible();
  });

  it('lets a creator enable the Turbo LoRA profile and locks it to eight steps', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const turboSwitch = scoped.getByRole('checkbox', { name: 'Turbo LoRA 8 steps' });
    expect(turboSwitch).not.toBeChecked();

    await user.click(turboSwitch);

    expect(turboSwitch).toBeChecked();
    expect(scoped.getByText('8 步（由 Turbo LoRA 锁定）')).toBeVisible();
    expect(scoped.queryByLabelText('采样步数')).not.toBeInTheDocument();
    expect(scoped.getByText('Sage + Sparge + Turbo 8-step')).toBeVisible();
  });

  it('uses a compact discrete slider for H3 Standard sampling steps', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    const steps = scoped.getByLabelText('采样步数');

    expect(steps).toHaveAttribute('type', 'range');
    expect(steps).toHaveAttribute('min', '0');
    expect(steps).toHaveAttribute('max', '4');
    expect(steps).toHaveAttribute('aria-valuetext', '20 步');

    fireEvent.change(steps, { target: { value: '0' } });
    expect(steps).toHaveAttribute('aria-valuetext', '6 步');
    expect(scoped.getByText('6')).toBeVisible();
    expect(scoped.getByText('25')).toBeVisible();
  });

  it('applies the six-step preview preset to its individual inference controls', async () => {
    const user = userEvent.setup();
    const view = render(<App api={api} />);
    const scoped = within(view.container);

    await openStandardOptimization(user, view.container);
    await user.click(scoped.getByRole('button', { name: '极速预览' }));

    expect(scoped.getByLabelText('采样步数')).toHaveAttribute('aria-valuetext', '6 步');
    expect(scoped.getByLabelText('采样器')).toHaveValue('res_multistep');
    expect(scoped.getByRole('checkbox', { name: 'SpargeAttention' })).toBeChecked();
    expect(scoped.getByRole('button', { name: 'Fast — 0.10 / 0.08' })).toHaveAttribute('aria-pressed', 'true');
    expect(scoped.getByRole('checkbox', { name: 'FirstBlockCache Fast' })).not.toBeChecked();
    expect(scoped.queryByRole('button', { name: 'H3 Fast — 0.10 / max 2' })).not.toBeInTheDocument();
    expect(scoped.getByRole('checkbox', { name: 'Fused Modulation' })).toBeChecked();
  });

  it('submits the selected preview recipe to the local generation service', async () => {
    const user = userEvent.setup();
    const submitted: GenerationForm[] = [];
    const previewApi: StudioApi = {
      ...api,
      getHealth: async () => ({ connected: true, deviceName: 'NVIDIA GB10' }),
      submitJob: async (input) => {
        submitted.push(input);
        return {
          id: 'preview-90',
          state: 'queued',
          actualFrames: 124,
          actualSeconds: 5.17,
          totalElapsedMs: 0,
          ...input,
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        } satisfies GenerationJob;
      },
      stopJob: async () => { throw new Error('not used'); },
      openJobEvents: () => () => undefined,
      mediaUrl: () => '/api/media?filename=preview.mp4',
    };
    const view = render(<App api={previewApi} />);
    const scoped = within(view.container);

    await user.click(scoped.getByRole('button', { name: /精细设置/i }));
    await user.click(scoped.getByRole('button', { name: '极速预览' }));
    await user.type(scoped.getByLabelText(/创作描述/), 'A cinematic cup of coffee with gentle steam');
    await user.click(scoped.getByRole('button', { name: '生成视频' }));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      steps: 6,
      samplerName: 'res_multistep',
      spargeAttention: true,
      spargeProfile: 'fast',
      featureCacheSafe: false,
      featureCacheProfile: 'fast',
      easyCache: false,
      fusedModulation: true,
    });
    expect(await scoped.findByText('实时生成中')).toBeVisible();
    expect(scoped.getByText('Sage + Sparge Fast + Fused Modulation')).toBeVisible();
  });

  it('switches between H3 keyframes, multimodal references, and the local Music3 composer', async () => {
    const user = userEvent.setup();
    const inputModeApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
          h3References: { available: true },
          music3: { available: true },
        } as unknown as ComfyServiceCapabilities,
      }),
    };
    const view = render(<App api={inputModeApi} />);
    const scoped = within(view.container);

    await user.click(scoped.getByRole('button', { name: '首尾帧' }));
    expect(scoped.getByRole('button', { name: '首尾帧' })).toHaveAttribute('aria-pressed', 'true');
    expect(scoped.getByText('首帧（必填）')).toBeVisible();

    await user.click(scoped.getByRole('button', { name: '多模态参考' }));
    expect(scoped.getByText('引用 <Picture 1>、<Video 1>、<Audio 1>')).toBeVisible();

    const music3 = scoped.getByRole('button', { name: 'MiniMax Music3' });
    await waitFor(() => expect(music3).toBeEnabled());
    await user.click(music3);
    expect(scoped.getByLabelText('音乐描述 Caption')).toBeVisible();
    expect(scoped.getByLabelText('歌词 Lyrics')).toBeVisible();
  });

  it('keeps TAEH3 real-time preview outside inference optimization controls', async () => {
    const user = userEvent.setup();
    const previewApi: StudioApi = {
      ...api,
      getHealth: async () => ({
        connected: true,
        deviceName: 'NVIDIA GB10',
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
          taeH3Preview: { available: true },
          music3: { available: true },
        },
      }),
    };
    const view = render(<App api={previewApi} />);
    const scoped = within(view.container);

    const previewHeading = await scoped.findByText('实时预览');
    const previewSection = previewHeading.closest('.realtime-preview-section');
    expect(previewSection).not.toBeNull();
    const previewToggle = within(previewSection as HTMLElement).getByRole('checkbox', { name: 'TAEH3 实时预览' });
    expect(previewToggle).toBeEnabled();

    await user.click(scoped.getByRole('button', { name: /精细设置/i }));
    expect(scoped.getByRole('region', { name: '推理优化' }).querySelector('[aria-label="TAEH3 实时预览"]')).toBeNull();

    await user.click(previewToggle);
    await user.click(scoped.getByRole('button', { name: 'FastH3 VSA' }));
    expect(scoped.getByRole('checkbox', { name: 'TAEH3 实时预览' })).toBeChecked();

    await user.click(scoped.getByRole('button', { name: 'MiniMax Music3' }));
    expect(scoped.queryByText('实时预览')).not.toBeInTheDocument();
  });

  it('stops the active H3 Studio task from the generation panel', async () => {
    const user = userEvent.setup();
    const generatingJob = {
      id: 'p-123',
      state: 'sampling' as const,
      prompt: 'A cinematic cup of coffee with gentle steam',
      width: 832,
      height: 480,
      seconds: 5,
      actualFrames: 124,
      actualSeconds: 5.17,
      steps: 20,
      samplerName: 'res_multistep' as const,
      seed: 42,
      turbo8Step: false,
      featureCacheSafe: false,
      featureCacheProfile: 'safe' as const,
      easyCache: false,
      spargeAttention: true,
      spargeProfile: 'balanced' as const,
      fusedModulation: false,
      step: 2,
      totalSteps: 20,
      totalElapsedMs: 5_000,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
    };
    const interactiveApi: StudioApi = {
      ...api,
      getHealth: vi.fn().mockResolvedValue({ connected: true, deviceName: 'NVIDIA GB10' }),
      submitJob: vi.fn().mockResolvedValue(generatingJob),
      stopJob: vi.fn().mockResolvedValue({ ...generatingJob, state: 'cancelling', message: '正在请求停止…' }),
      openJobEvents: vi.fn(() => () => undefined),
      mediaUrl: vi.fn(),
    };
    const view = render(<App api={interactiveApi} />);
    const scoped = within(view.container);

    await user.type(scoped.getByRole('textbox'), generatingJob.prompt);
    await user.click(scoped.getByRole('button', { name: '生成视频' }));
    await user.click(await scoped.findByRole('button', { name: '停止本次任务' }));

    expect(interactiveApi.stopJob).toHaveBeenCalledWith('p-123');
    expect(await scoped.findByRole('button', { name: '正在请求停止…' })).toBeDisabled();
  });
});
