import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpDeterministicUpscaleWorkerClient } from '../server/deterministic-upscale-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpDeterministicUpscaleWorkerClient', () => {
  it('reads the verified profile without allowing a hung local sidecar to block the Studio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      available: true,
      model: 'realesrgan-x2plus-fp16',
      supportedProfiles: [{
        sourceWidth: 832,
        sourceHeight: 480,
        target: '2k',
        width: 2560,
        height: 1478,
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const health = await new HttpDeterministicUpscaleWorkerClient('http://127.0.0.1:8191').health();

    expect(health).toMatchObject({
      available: true,
      model: 'realesrgan-x2plus-fp16',
      supportedProfiles: [{ sourceWidth: 832, sourceHeight: 480, target: '2k', width: 2560, height: 1478 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8191/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('submits the exact safe Comfy output reference to the deterministic worker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'det-123', state: 'queued', target: '2k', width: 2560, height: 1478, totalElapsedMs: 0,
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpDeterministicUpscaleWorkerClient('http://127.0.0.1:8191').createJob({
      source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      target: '2k',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8191/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
          target: '2k',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
