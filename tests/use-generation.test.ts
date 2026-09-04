// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGeneration } from '../src/hooks/useGeneration';
import type { StudioApi } from '../src/api';

const validForm = {
  service: 'h3_standard' as const,
  prompt: 'A cinematic cup of coffee with gentle steam',
  width: 832,
  height: 480,
  seconds: 5,
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
  vaeTileBatch: false,
  h3StandardCublasInt8: false,
  h3StandardAdaGemmInt8: false,
  fastH3Gb10VsaKernel: false,
  fastH3CublasInt8: false,
  fastH3AdaGemmInt8: false,
  fastH3VaeTileBatch: false,
  taeH3Preview: false,
  inputMode: 'text' as const,
  firstFrame: undefined,
  lastFrame: undefined,
  referenceImages: [],
  referenceVideos: [],
  referenceAudios: [],
  referenceImageSize: 'match' as const,
  lyrics: '',
  musicTiledDecode: true,
};

function createApi() {
  let emit: ((event: Record<string, unknown>) => void) | undefined;
  let emitUpscale: ((event: Record<string, unknown>) => void) | undefined;
  const closeEvents = vi.fn();
  const closeUpscaleEvents = vi.fn();
  const api: StudioApi = {
    getHealth: vi.fn().mockResolvedValue({ connected: true, deviceName: 'NVIDIA GB10' }),
    submitJob: vi.fn().mockResolvedValue({
      id: 'p-123',
      state: 'queued',
      actualFrames: 124,
      actualSeconds: 5.17,
      totalElapsedMs: 0,
      ...validForm,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    }),
    stopJob: vi.fn(),
    openJobEvents: vi.fn((_id, listener) => {
      emit = listener;
      return closeEvents;
    }),
    startUpscale: vi.fn(),
    getUpscaleJob: vi.fn(),
    stopUpscale: vi.fn(),
    openUpscaleEvents: vi.fn((_id, listener) => {
      emitUpscale = listener;
      return closeUpscaleEvents;
    }),
    mediaUrl: vi.fn(),
  };
  return {
    api,
    emit: (event: Record<string, unknown>) => emit?.(event),
    emitUpscale: (event: Record<string, unknown>) => emitUpscale?.(event),
    closeEvents,
    closeUpscaleEvents,
  };
}

describe('useGeneration', () => {
  it('uses a sampler event to expose a real step count and ETA', async () => {
    const transport = createApi();
    const { result } = renderHook(() => useGeneration(transport.api));

    await act(async () => {
      await result.current.generate(validForm);
    });
    act(() => {
      transport.emit({
        id: 'p-123',
        state: 'sampling',
        step: 12,
        totalSteps: 20,
        elapsedMs: 24000,
        etaSeconds: 16,
        ...validForm,
      });
    });

    await waitFor(() => {
      expect(result.current.currentJob).toMatchObject({
        id: 'p-123', state: 'sampling', step: 12, totalSteps: 20, etaSeconds: 16,
      });
    });
  });

  it('replaces the active job with the stopped snapshot returned by the service', async () => {
    const transport = createApi();
    transport.api.stopJob = vi.fn().mockResolvedValue({
      id: 'p-123',
      state: 'cancelled',
      actualFrames: 124,
      actualSeconds: 5.17,
      totalElapsedMs: 8_000,
      message: '本次生成已停止',
      ...validForm,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:08.000Z',
    });
    const { result } = renderHook(() => useGeneration(transport.api));

    await act(async () => {
      await result.current.generate(validForm);
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(transport.api.stopJob).toHaveBeenCalledWith('p-123');
    expect(result.current.currentJob).toMatchObject({ id: 'p-123', state: 'cancelled' });
  });

  it('keeps the event subscription open while a stop request is awaiting confirmation', async () => {
    const transport = createApi();
    transport.api.stopJob = vi.fn().mockResolvedValue({
      id: 'p-123',
      state: 'cancelling',
      actualFrames: 124,
      actualSeconds: 5.17,
      totalElapsedMs: 8_000,
      message: '正在请求停止…',
      ...validForm,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:08.000Z',
    });
    const { result } = renderHook(() => useGeneration(transport.api));

    await act(async () => {
      await result.current.generate(validForm);
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.currentJob).toMatchObject({ id: 'p-123', state: 'cancelling' });
    expect(transport.closeEvents).not.toHaveBeenCalled();

    act(() => {
      transport.emit({ id: 'p-123', state: 'cancelled', message: '本次生成已停止' });
    });

    await waitFor(() => expect(transport.closeEvents).toHaveBeenCalledOnce());
    expect(result.current.currentJob).toMatchObject({ id: 'p-123', state: 'cancelled' });
  });

  it('removes one selected video from the browser-only recent history', () => {
    const transport = createApi();
    const firstHistoryJob = {
      id: 'history-1',
      state: 'completed' as const,
      actualFrames: 124,
      actualSeconds: 5.17,
      totalElapsedMs: 83_000,
      ...validForm,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:01:23.000Z',
    };
    const secondHistoryJob = { ...firstHistoryJob, id: 'history-2', prompt: 'A slow orbit around a mountain cabin' };
    window.sessionStorage.setItem('h3-studio-history-v1', JSON.stringify([firstHistoryJob, secondHistoryJob]));

    try {
      const { result } = renderHook(() => useGeneration(transport.api));

      act(() => {
        result.current.removeHistory('history-1');
      });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0]?.id).toBe('history-2');
      expect(JSON.parse(window.sessionStorage.getItem('h3-studio-history-v1') || '[]')).toEqual([secondHistoryJob]);
    } finally {
      window.sessionStorage.removeItem('h3-studio-history-v1');
    }
  });

  it('keeps the original media while enhancement events add a completed 2K variant to session history', async () => {
    const transport = createApi();
    transport.api.startUpscale = vi.fn().mockResolvedValue({
      id: 'up-2k', sourceJobId: 'p-123', method: 'deterministic', target: '2k', state: 'queued',
      width: 2560, height: 1478, totalElapsedMs: 0,
      createdAt: '2026-08-28T00:00:20.000Z', updatedAt: '2026-08-28T00:00:20.000Z',
    });
    const { result } = renderHook(() => useGeneration(transport.api));

    await act(async () => {
      await result.current.generate(validForm);
    });
    act(() => {
      transport.emit({
        id: 'p-123', state: 'completed',
        media: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      });
    });
    await waitFor(() => expect(result.current.history).toHaveLength(1));

    await act(async () => {
      await result.current.startUpscale('p-123', 'deterministic', '2k');
    });
    expect(transport.api.startUpscale).toHaveBeenCalledWith('p-123', 'deterministic', '2k');
    expect(result.current.currentJob?.enhancements).toContainEqual(expect.objectContaining({
      id: 'up-2k', method: 'deterministic', state: 'queued',
    }));

    act(() => {
      transport.emitUpscale({
        id: 'up-2k', sourceJobId: 'p-123', method: 'deterministic', target: '2k', state: 'completed',
        width: 2560, height: 1478, totalElapsedMs: 91_000,
        media: { filename: 'coffee_up-2k.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
      });
    });
    await waitFor(() => expect(transport.closeUpscaleEvents).toHaveBeenCalledOnce());

    const stored = JSON.parse(window.sessionStorage.getItem('h3-studio-history-v1') || '[]');
    expect(stored[0]).toMatchObject({
      media: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      enhancements: [{
        id: 'up-2k', state: 'completed',
        media: { filename: 'coffee_up-2k.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
      }],
    });
    window.sessionStorage.removeItem('h3-studio-history-v1');
  });
});
