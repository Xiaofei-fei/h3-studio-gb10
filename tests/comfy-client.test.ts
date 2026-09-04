import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpComfyClient } from '../server/comfy-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpComfyClient cancellation', () => {
  it('uses ComfyUI\'s prompt-specific cancellation endpoint instead of a global interrupt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpComfyClient('http://comfy.local').cancel('p-123');

    expect(result).toEqual({ state: 'cancelling' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://comfy.local/api/jobs/p-123/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('http://comfy.local/interrupt');
  });

  it('only removes the current prompt from the legacy pending queue when scoped cancellation is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue_pending: [[1, 'p-123']] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue_pending: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpComfyClient('http://comfy.local').cancel('p-123');

    expect(result).toEqual({ state: 'cancelled', message: '已从等待队列移除。' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://comfy.local/queue',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ delete: ['p-123'] }) }),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('http://comfy.local/interrupt');
  });

  it('uses the global interrupt only after the running queue proves this exact Studio prompt is active', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue_pending: [], queue_running: [[1, 'p-123']] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpComfyClient('http://comfy.local').cancel('p-123');

    expect(result).toEqual({ state: 'cancelling', message: '已请求停止正在执行的任务。' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://comfy.local/interrupt',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('never interrupts an unknown or different running task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue_pending: [], queue_running: [[1, 'someone-else']] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpComfyClient('http://comfy.local').cancel('p-123');

    expect(result).toEqual({
      state: 'rejected',
      message: '当前任务不在本服务可安全停止的队列中。',
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('http://comfy.local/interrupt');
  });
});

function objectInfo(name: string, required: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    [name]: {
      input: { required },
    },
  }), { status: 200 });
}

function mockHealthEndpoints(options: {
  h3Vsa?: Response;
  lora?: Response;
  cublas?: Response;
  adagemm?: Response;
  vaeBatch?: Response;
  extra?: Record<string, Response>;
}) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/system_stats')) {
      return new Response(JSON.stringify({
        system: { comfyui_version: '0.33.0' },
        devices: [{ name: 'NVIDIA GB10' }],
      }), { status: 200 });
    }
    if (url.endsWith('/object_info/H3VSA')) return options.h3Vsa ?? new Response('', { status: 404 });
    if (url.endsWith('/object_info/LoraLoaderModelOnly')) return options.lora ?? new Response('', { status: 404 });
    if (url.endsWith('/object_info/MiniMaxH3GB10CublasInt8')) return options.cublas ?? new Response('', { status: 404 });
    if (url.endsWith('/object_info/MiniMaxH3GB10AdaGemmInt8')) return options.adagemm ?? new Response('', { status: 404 });
    if (url.endsWith('/object_info/MiniMaxH3VAEDecodeBatched')) return options.vaeBatch ?? new Response('', { status: 404 });
    const nodeClass = url.split('/object_info/')[1];
    if (nodeClass && options.extra?.[nodeClass]) return options.extra[nodeClass];
    throw new Error(`Unexpected endpoint ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('HttpComfyClient FastH3 capabilities', () => {
  it('reports FastH3 unavailable with a useful reason when the VSA node is missing', async () => {
    mockHealthEndpoints({});

    const health = await new HttpComfyClient('http://comfy.local').health();

    expect(health).toMatchObject({
      connected: true,
      services: {
        fastH3Vsa: {
          available: false,
          reason: expect.stringContaining('H3VSA'),
        },
      },
    });
  });

  it('discovers FastH3 and its optional GB10 accelerators independently', async () => {
    mockHealthEndpoints({
      h3Vsa: objectInfo('H3VSA', {
        gate_file: [['fasth3_vsa_gate.safetensors'], {}],
      }),
      lora: objectInfo('LoraLoaderModelOnly', {
        lora_name: [['fasth3_vsa_4-steps-v5.safetensors'], {}],
      }),
      cublas: new Response('', { status: 404 }),
      vaeBatch: objectInfo('MiniMaxH3VAEDecodeBatched'),
      extra: {
        H3StudioFastH3GB10VSA: objectInfo('H3StudioFastH3GB10VSA'),
      },
    });

    const health = await new HttpComfyClient('http://comfy.local').health();

    expect(health).toMatchObject({
      connected: true,
      services: {
        h3Standard: { available: true },
        h3StandardCublasInt8: { available: false },
        fastH3Vsa: { available: true },
        fastH3CublasInt8: { available: false },
        fastH3Gb10VsaKernel: { available: true },
        fastH3VaeTileBatch: { available: true },
      },
    });
  });

  it('exposes the Standard cuBLAS switch only when the node explicitly supports Standard', async () => {
    mockHealthEndpoints({
      h3Vsa: objectInfo('H3VSA', {
        gate_file: [['fasth3_vsa_gate.safetensors'], {}],
      }),
      lora: objectInfo('LoraLoaderModelOnly', {
        lora_name: [['fasth3_vsa_4-steps-v5.safetensors'], {}],
      }),
      cublas: new Response(JSON.stringify({
        MiniMaxH3GB10CublasInt8: {
          input: { optional: { allow_standard: ['BOOLEAN', { default: false }] } },
        },
      }), { status: 200 }),
      vaeBatch: objectInfo('MiniMaxH3VAEDecodeBatched'),
    });

    const health = await new HttpComfyClient('http://comfy.local').health();

    expect(health.services).toMatchObject({
      h3StandardCublasInt8: { available: true },
      fastH3CublasInt8: { available: true },
    });
  });

  it('exposes the AdaGEMM switches only when the trial node is discoverable', async () => {
    mockHealthEndpoints({
      adagemm: objectInfo('MiniMaxH3GB10AdaGemmInt8'),
    });

    const health = await new HttpComfyClient('http://comfy.local').health();

    expect(health.services).toMatchObject({
      h3StandardAdaGemmInt8: { available: true },
      fastH3AdaGemmInt8: { available: true },
    });
  });

  it('reports local Ref2VA and Music3 capabilities only when their nodes and model weights are discoverable', async () => {
    mockHealthEndpoints({
      extra: {
        MiniMaxH3ReferenceToVideo: objectInfo('MiniMaxH3ReferenceToVideo'),
        LoadImage: objectInfo('LoadImage'),
        LoadVideo: objectInfo('LoadVideo'),
        GetVideoComponents: objectInfo('GetVideoComponents'),
        LoadAudio: objectInfo('LoadAudio'),
        UNETLoader: objectInfo('UNETLoader', {
          unet_name: [[
            'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
            'minimax_music3_dit_fp16.safetensors',
          ], {}],
        }),
        CLIPLoader: objectInfo('CLIPLoader', {
          clip_name: [['minimax_music3_text_encoder_pruned_int8_convrot.safetensors'], {}],
        }),
        VAELoader: objectInfo('VAELoader', {
          vae_name: [['minimax_music3_dav.safetensors'], {}],
        }),
        MiniMaxMusic3TextEncode: objectInfo('MiniMaxMusic3TextEncode'),
        EmptyMiniMaxMusic3LatentAudio: objectInfo('EmptyMiniMaxMusic3LatentAudio'),
        ConditioningZeroOut: objectInfo('ConditioningZeroOut'),
        KSampler: objectInfo('KSampler'),
        VAEDecodeAudio: objectInfo('VAEDecodeAudio'),
        VAEDecodeAudioTiled: objectInfo('VAEDecodeAudioTiled'),
        SaveAudioMP3: objectInfo('SaveAudioMP3'),
      },
    });

    const health = await new HttpComfyClient('http://comfy.local').health();

    expect(health.services).toMatchObject({
      h3References: { available: true },
      music3: { available: true },
    });
  });
});
