// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  mediaUrl: vi.fn(),
};

afterEach(() => cleanup());

describe('TAEH3 preview panel', () => {
  it('shows the latest live preview during sampling and labels it as non-final', () => {
    const job: GenerationJob = {
      id: 'preview-job',
      state: 'sampling',
      prompt: 'Coffee',
      width: 832,
      height: 480,
      seconds: 5,
      actualFrames: 124,
      actualSeconds: 5.17,
      steps: 6,
      samplerName: 'res_multistep',
      seed: 42,
      turbo8Step: false,
      featureCacheSafe: false,
      featureCacheProfile: 'safe',
      easyCache: false,
      spargeAttention: true,
      spargeProfile: 'balanced',
      fusedModulation: false,
      vaeTileBatch: false,
      h3StandardCublasInt8: false,
      fastH3CublasInt8: false,
      fastH3VaeTileBatch: false,
      taeH3Preview: true,
      preview: {
        dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
        mime: 'image/jpeg',
        width: 416,
        height: 240,
        step: 2,
        totalSteps: 6,
      },
      totalElapsedMs: 2_000,
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:02.000Z',
    };
    const preview = job.preview;
    if (!preview) throw new Error('TAEH3 preview fixture is required for this test.');

    render(<GenerationPanel job={job} api={api} onRetry={vi.fn()} />);

    expect(screen.getByRole('img', { name: 'TAEH3 实时预览，第 2 / 6 步' })).toHaveAttribute('src', preview.dataUrl);
    expect(screen.getByText('TAEH3 实时预览 · 非最终画质')).toBeVisible();
    expect(screen.getByText('最终成片仍使用官方视频 VAE 解码。')).toBeVisible();
  });
});
