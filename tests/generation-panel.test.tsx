// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from '../src/components/GenerationPanel';
import type { StudioApi } from '../src/api';
import type { GenerationJob } from '../src/types';

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

const completedJob: GenerationJob = {
  id: 'p-123',
  state: 'completed',
  prompt: 'A cinematic cup of coffee with gentle steam',
  width: 832,
  height: 480,
  seconds: 5,
  actualFrames: 124,
  actualSeconds: 5.17,
  steps: 20,
  samplerName: 'res_multistep',
  seed: 42,
  turbo8Step: false,
  featureCacheSafe: false,
  featureCacheProfile: 'safe',
  easyCache: false,
  spargeAttention: true,
  spargeProfile: 'balanced',
  fusedModulation: false,
  totalElapsedMs: 83_000,
  media: { filename: 'coffee.mp4', type: 'output' },
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:01:23.000Z',
};

describe('GenerationPanel', () => {
  it('places the available TAEH3 switch in the preview toolbar and emits its next value', async () => {
    const user = userEvent.setup();
    const onTaeH3PreviewChange = vi.fn();
    render(<GenerationPanel
      job={null}
      api={api}
      onRetry={vi.fn()}
      taeH3Preview={false}
      taeH3PreviewCapability={{ available: true }}
      onTaeH3PreviewChange={onTaeH3PreviewChange}
    />);

    const toggle = screen.getByRole('switch', { name: 'TAEH3 实时预览' });
    expect(toggle).toBeVisible();
    await user.click(toggle);
    expect(onTaeH3PreviewChange).toHaveBeenCalledWith(true);
  });

  it('does not expose a TAEH3 switch when the preview capability is unavailable', () => {
    const view = render(<GenerationPanel
      job={null}
      api={api}
      onRetry={vi.fn()}
      taeH3PreviewCapability={{ available: false, reason: '当前服务不支持实时预览。' }}
    />);

    expect(within(view.container).queryByRole('switch', { name: 'TAEH3 实时预览' })).not.toBeInTheDocument();
    expect(within(view.container).getByText('当前服务不支持实时预览。')).toBeVisible();
  });

  it('shows the completed video\'s actual end-to-end generation time', () => {
    render(<GenerationPanel job={completedJob} api={api} onRetry={vi.fn()} />);

    expect(screen.getByText('端到端耗时')).toBeVisible();
    expect(screen.getByText('1 分 23 秒')).toBeVisible();
  });

  it('updates the elapsed counter while a video is generating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:05.000Z'));
    const generatingJob: GenerationJob = {
      ...completedJob,
      state: 'sampling',
      totalElapsedMs: 5_000,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:05.000Z',
      media: undefined,
      step: 2,
      totalSteps: 20,
    };

    try {
      render(<GenerationPanel job={generatingJob} api={api} onRetry={vi.fn()} />);

      expect(screen.getByText('已用时间')).toBeVisible();
      expect(screen.getByText('5 秒')).toBeVisible();

      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      expect(screen.getByText('8 秒')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls the stop action while the current video is generating', () => {
    vi.useFakeTimers();
    const generatingJob: GenerationJob = {
      ...completedJob,
      state: 'sampling',
      media: undefined,
      step: 2,
      totalSteps: 20,
    };

    try {
      const onStop = vi.fn();
      const view = render(<GenerationPanel job={generatingJob} api={api} onRetry={vi.fn()} onStop={onStop} />);

      const stopButton = within(view.container).getByRole('button', { name: '停止本次任务' });
      expect(stopButton).toBeVisible();
      fireEvent.click(stopButton);
      expect(onStop).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('shows a disabled confirmation state after a stop has been requested', () => {
    const view = render(<GenerationPanel
      job={{ ...completedJob, state: 'cancelling', media: undefined, message: '正在请求停止…' }}
      api={api}
      onRetry={vi.fn()}
      onStop={vi.fn()}
    />);

    expect(within(view.container).getByRole('button', { name: '正在请求停止…' })).toBeDisabled();
  });

  it('offers only the permitted 2K target for a completed 480P H3 result', async () => {
    const user = userEvent.setup();
    const onStartUpscale = vi.fn();
    render(<GenerationPanel
      job={completedJob}
      api={api}
      onRetry={vi.fn()}
      flashVsr={{ available: true, supportedTargets: ['2k', '4k'] }}
      onStartUpscale={onStartUpscale}
    />);

    await user.click(screen.getByRole('button', { name: '提升清晰度' }));
    expect(screen.getByRole('button', { name: '2K · 2560 × 1478 · FlashVSR' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /4K/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '2K · 2560 × 1478 · FlashVSR' }));
    expect(onStartUpscale).toHaveBeenCalledWith('flashvsr', '2k');
  });

  it('offers the verified deterministic 2K profile and sends its explicit method', async () => {
    const user = userEvent.setup();
    const onStartUpscale = vi.fn();
    render(<GenerationPanel
      job={completedJob}
      api={api}
      onRetry={vi.fn()}
      deterministicUpscale={{
        available: true,
        supportedProfiles: [{ sourceWidth: 832, sourceHeight: 480, target: '2k', width: 2560, height: 1478 }],
      }}
      onStartUpscale={onStartUpscale}
    />);

    await user.click(screen.getByRole('button', { name: '提升清晰度' }));
    const stableTarget = screen.getByRole('button', { name: '2K · 2560 × 1478 · 稳定增强' });
    expect(stableTarget).toBeVisible();
    await user.click(stableTarget);
    expect(onStartUpscale).toHaveBeenCalledWith('deterministic', '2k');
  });

  it('keeps stable 2K enhancement visible for a completed H3-native 768P video', async () => {
    const user = userEvent.setup();
    const onStartUpscale = vi.fn();
    render(<GenerationPanel
      job={{ ...completedJob, width: 1344, height: 768, media: { filename: 'coffee-768.mp4', type: 'output' } }}
      api={api}
      onRetry={vi.fn()}
      deterministicUpscale={{
        available: true,
        supportedProfiles: [{ sourceWidth: 1344, sourceHeight: 768, target: '2k', width: 2560, height: 1464 }],
      }}
      onStartUpscale={onStartUpscale}
    />);

    await user.click(screen.getByRole('button', { name: '提升清晰度' }));
    const stableTarget = screen.getByRole('button', { name: '2K · 2560 × 1464 · 稳定增强' });
    expect(stableTarget).toBeVisible();
    await user.click(stableTarget);
    expect(onStartUpscale).toHaveBeenCalledWith('deterministic', '2k');
  });

  it('switches playback and download between original and completed enhanced media', async () => {
    const user = userEvent.setup();
    const mediaApi: StudioApi = { ...api, mediaUrl: (media) => `/api/media?filename=${media.filename}` };
    render(<GenerationPanel
      job={{
        ...completedJob,
        enhancements: [{
          id: 'up-2k', target: '2k', state: 'completed', width: 2560, height: 1478, totalElapsedMs: 90_000,
          media: { filename: 'coffee_up-2k.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
        }],
      }}
      api={mediaApi}
      onRetry={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: '原始视频' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '2K 增强' }));
    expect(screen.getByRole('button', { name: '2K 增强' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: '下载 2K 增强' })).toHaveAttribute('href', expect.stringContaining('coffee_up-2k.mp4'));
  });
});
