// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryGallery } from '../src/components/HistoryGallery';
import type { StudioApi } from '../src/api';
import type { GenerationJob } from '../src/types';

const completedJob: GenerationJob = {
  id: 'history-coffee',
  state: 'completed',
  prompt: '生成一段 5 秒视频：一杯咖啡的热气缓缓升起，镜头缓慢推近，背景虚化。参数配置：832 × 480。',
  width: 832,
  height: 480,
  seconds: 5,
  actualFrames: 124,
  actualSeconds: 5.17,
  steps: 20,
  samplerName: 'res_multistep',
  seed: 42,
  turbo8Step: false,
  featureCacheSafe: true,
  featureCacheProfile: 'fast',
  easyCache: false,
  spargeAttention: true,
  spargeProfile: 'balanced',
  fusedModulation: false,
  totalElapsedMs: 165_000,
  media: { filename: 'coffee.mp4', type: 'output' },
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:02:45.000Z',
};

const api: StudioApi = {
  getHealth: vi.fn(),
  submitJob: vi.fn(),
  stopJob: vi.fn(),
  openJobEvents: vi.fn(() => () => undefined),
  startUpscale: vi.fn(),
  getUpscaleJob: vi.fn(),
  stopUpscale: vi.fn(),
  openUpscaleEvents: vi.fn(() => () => undefined),
  mediaUrl: vi.fn(() => '/api/media?filename=coffee.mp4'),
};

const fastH3Baseline: GenerationJob = {
  ...completedJob,
  id: 'fasth3-baseline',
  service: 'fasth3_vsa',
  steps: 4,
  samplerName: 'euler',
  spargeAttention: false,
  featureCacheSafe: false,
  fastH3CublasInt8: false,
  fastH3VaeTileBatch: true,
  totalElapsedMs: 63_000,
};

const fastH3Optimized: GenerationJob = {
  ...fastH3Baseline,
  id: 'fasth3-optimized',
  fastH3CublasInt8: true,
  totalElapsedMs: 55_000,
};

const fastH3AdaGemm: GenerationJob = {
  ...fastH3Baseline,
  id: 'fasth3-adagemm',
  fastH3AdaGemmInt8: true,
  totalElapsedMs: 56_000,
};

afterEach(() => cleanup());

describe('HistoryGallery', () => {
  it('turns a completed generation into a readable video card with its actual run details', () => {
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '一杯咖啡的热气缓缓升起' })).toBeVisible();
    const metadata = screen.getByLabelText('视频参数');
    expect(within(metadata).getByText('832 × 480')).toBeVisible();
    expect(within(metadata).getByText('5.2 秒')).toBeVisible();
    expect(within(metadata).getByText('20 步')).toBeVisible();
    expect(screen.getByText('Sage + Sparge + FirstBlockCache Fast')).toBeVisible();
    expect(screen.getByText('耗时 2 分 45 秒')).toBeVisible();
  });

  it('shows a measured same-configuration cuBLAS comparison only for a matched FastH3 pair', () => {
    render(<HistoryGallery history={[fastH3Optimized, fastH3Baseline]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText('同配置内核对比：较基线快 8 秒（12.7%）')).toBeVisible();
  });

  it('shows a measured same-configuration AdaGEMM comparison against the FastH3 baseline', () => {
    render(<HistoryGallery history={[fastH3AdaGemm, fastH3Baseline]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText('同配置内核对比：较基线快 7 秒（11.1%）')).toBeVisible();
  });

  it('uses a vector play icon rather than an off-center text glyph in the preview overlay', () => {
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    const previewButton = screen.getByRole('button', { name: /打开视频/i });
    const playMark = previewButton.querySelector('.history-play-mark');
    expect(playMark).not.toHaveTextContent('▶');
    expect(playMark?.querySelector('svg')).toBeInTheDocument();
  });

  it('opens a historical video in an in-page preview with a prompt control and download action', async () => {
    const user = userEvent.setup();
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /打开视频/i }));

    const dialog = await screen.findByRole('dialog', { name: /视频预览/i });
    expect(within(dialog).getByRole('button', { name: '查看原始提示词' })).toBeVisible();
    expect(within(dialog).getByRole('link', { name: '下载 MP4' })).toHaveAttribute('download');
    expect(dialog.querySelector('video')).toHaveAttribute('controls');
  });

  it('offers deterministic 2K enhancement directly from an eligible historical video card', async () => {
    const user = userEvent.setup();
    const onStartUpscale = vi.fn();
    const props = {
      history: [completedJob],
      api,
      onReuse: vi.fn(),
      onRemove: vi.fn(),
      deterministicUpscale: {
        available: true,
        supportedProfiles: [{ sourceWidth: 832, sourceHeight: 480, target: '2k', width: 2560, height: 1478 }],
      },
      onStartUpscale,
    } as ComponentProps<typeof HistoryGallery> & {
      deterministicUpscale: {
        available: boolean;
        supportedProfiles: Array<{ sourceWidth: number; sourceHeight: number; target: '2k'; width: number; height: number }>;
      };
      onStartUpscale: typeof onStartUpscale;
    };

    render(<HistoryGallery {...props} />);

    await user.click(screen.getByRole('button', { name: '2K 稳定增强' }));
    expect(onStartUpscale).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'history-coffee', media: { filename: 'coffee.mp4', type: 'output' } }),
      'deterministic',
      '2k',
    );
  });

  it('mounts the history preview outside the filtered gallery surface so it stays viewport-anchored', async () => {
    const user = userEvent.setup();
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /打开视频/i }));

    const dialog = await screen.findByRole('dialog', { name: /视频预览/i });
    expect(dialog.closest('.history-section')).toBeNull();
  });

  it('keeps the original prompt out of the way until a viewer expands it and omits deletion from the preview', async () => {
    const user = userEvent.setup();
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /打开视频/i }));

    const dialog = await screen.findByRole('dialog', { name: /视频预览/i });
    const promptToggle = within(dialog).getByRole('button', { name: '查看原始提示词' });
    expect(promptToggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).queryByText(completedJob.prompt)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '从本地历史删除' })).not.toBeInTheDocument();

    await user.click(promptToggle);

    expect(promptToggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText(completedJob.prompt)).toBeVisible();
  });

  it('requires an explicit confirmation before removing only the local history entry', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<HistoryGallery history={[completedJob]} api={api} onReuse={vi.fn()} onRemove={onRemove} />);

    await user.click(screen.getByRole('button', { name: '删除记录' }));
    expect(screen.getByText('仅从本地历史移除')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    expect(onRemove).toHaveBeenCalledWith('history-coffee');
  });

  it('lets a viewer switch between original and completed enhanced video variants', async () => {
    const user = userEvent.setup();
    const mediaApi: StudioApi = { ...api, mediaUrl: (media) => `/api/media?filename=${media.filename}` };
    const enhancedJob: GenerationJob = {
      ...completedJob,
      enhancements: [{
        id: 'up-2k', target: '2k', state: 'completed', width: 2560, height: 1478, totalElapsedMs: 94_000,
        media: { filename: 'coffee_up-2k.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
      }],
    };
    render(<HistoryGallery history={[enhancedJob]} api={mediaApi} onReuse={vi.fn()} onRemove={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /打开视频/i }));
    const dialog = await screen.findByRole('dialog', { name: /视频预览/i });
    const scoped = within(dialog);
    expect(scoped.getByRole('button', { name: '原始视频' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(scoped.getByRole('button', { name: '2K 增强' }));
    expect(scoped.getByRole('link', { name: '下载 2K 增强' })).toHaveAttribute('href', expect.stringContaining('coffee_up-2k.mp4'));
  });
});
