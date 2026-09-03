import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpFlashVsrWorkerClient } from '../server/flashvsr-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpFlashVsrWorkerClient', () => {
  it('reads the local worker health without letting a hung worker block the Studio indefinitely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      available: true,
      model: 'flashvsr-v1.1',
      supportedTargets: ['2k', '4k'],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const health = await new HttpFlashVsrWorkerClient('http://127.0.0.1:8190').health();

    expect(health).toEqual({
      available: true,
      model: 'flashvsr-v1.1',
      supportedTargets: ['2k', '4k'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8190/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('surfaces the mounted compatibility-stage failure when the worker cannot start', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'h3-flashvsr-state-'));
    const statePath = join(stateDir, 'compatibility.json');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await writeFile(statePath, JSON.stringify({
      available: false,
      model: 'flashvsr-v1.1',
      supportedTargets: [],
      reason: 'imports: FlashVSR worker image build failed.',
    }));

    try {
      const health = await new HttpFlashVsrWorkerClient('http://127.0.0.1:8190', statePath).health();

      expect(health).toEqual({
        available: false,
        model: 'flashvsr-v1.1',
        supportedTargets: [],
        reason: 'imports: FlashVSR worker image build failed.',
      });
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it('creates a local enhancement job and preserves the exact Comfy output reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'upscale-1',
      state: 'queued',
      target: '2k',
      width: 2560,
      height: 1478,
      totalElapsedMs: 0,
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const job = await new HttpFlashVsrWorkerClient('http://127.0.0.1:8190').createJob({
      source: { filename: 'coffee.mp4', subfolder: 'h3', type: 'output' },
      target: '2k',
    });

    expect(job).toMatchObject({ id: 'upscale-1', state: 'queued', target: '2k' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8190/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          source: { filename: 'coffee.mp4', subfolder: 'h3', type: 'output' },
          target: '2k',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('surfaces a worker rejection with the service message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '4K 仅支持 720P 源视频。' }), {
      status: 422,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpFlashVsrWorkerClient('http://127.0.0.1:8190').createJob({
      source: { filename: 'coffee.mp4', type: 'output' },
      target: '4k',
    })).rejects.toThrow('4K 仅支持 720P 源视频。');
  });
});
