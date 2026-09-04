import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import type { ComfyClient, ComfyEvent } from '../server/comfy-client';
import type { FlashVsrWorkerClient, FlashVsrWorkerHealth, FlashVsrWorkerJob, FlashVsrWorkerRequest } from '../server/flashvsr-client';
import type {
  DeterministicUpscaleWorkerClient,
  DeterministicUpscaleWorkerHealth,
  DeterministicUpscaleWorkerJob,
  DeterministicUpscaleWorkerRequest,
} from '../server/deterministic-upscale-client';
import type { ComfyPrompt, ComfyServiceCapabilities, MediaReference, UpscaleTarget } from '../server/types';

const validRequest = {
  prompt: 'A cinematic cup of coffee with gentle steam',
  width: 832,
  height: 480,
  seconds: 5,
  steps: 20,
  seed: 42,
};

const allServicesAvailable: ComfyServiceCapabilities = {
  h3Standard: { available: true },
  h3StandardCublasInt8: { available: true },
  h3StandardAdaGemmInt8: { available: true },
  fastH3Vsa: { available: true },
  fastH3Gb10VsaKernel: { available: true },
  fastH3CublasInt8: { available: true },
  fastH3AdaGemmInt8: { available: true },
  fastH3VaeTileBatch: { available: true },
};

function fakeClient(options: {
  promptId?: string;
  connected?: boolean;
  media?: Response;
  services?: ComfyServiceCapabilities;
  history?: unknown;
} = {}): ComfyClient & {
  prompts: ComfyPrompt[];
  mediaQueries: URLSearchParams[];
  mediaRanges: Array<string | undefined>;
  enqueueClientIds: string[];
  eventClientIds: string[];
  cancelledPromptIds: string[];
  uploads: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
} {
  const prompts: ComfyPrompt[] = [];
  const mediaQueries: URLSearchParams[] = [];
  const mediaRanges: Array<string | undefined> = [];
  const enqueueClientIds: string[] = [];
  const eventClientIds: string[] = [];
  const cancelledPromptIds: string[] = [];
  const uploads: Array<{ filename: string; mimeType: string; bytes: Uint8Array }> = [];
  return {
    prompts,
    mediaQueries,
    mediaRanges,
    enqueueClientIds,
    eventClientIds,
    cancelledPromptIds,
    uploads,
    async health() {
      return {
        connected: options.connected ?? true,
        deviceName: 'NVIDIA GB10',
        comfyVersion: '0.33.0',
        services: options.services ?? allServicesAvailable,
      };
    },
    async enqueue(prompt: ComfyPrompt, clientId: string) {
      prompts.push(prompt);
      enqueueClientIds.push(clientId);
      return { promptId: options.promptId ?? 'p-123' };
    },
    async getHistory() {
      return options.history ?? null;
    },
    openEvents(_promptId: string, clientId: string) {
      eventClientIds.push(clientId);
      return () => undefined;
    },
    async cancel(promptId: string) {
      cancelledPromptIds.push(promptId);
      return { state: 'cancelling' };
    },
    async getMedia(query: URLSearchParams, range?: string) {
      mediaQueries.push(query);
      mediaRanges.push(range);
      return options.media ?? null;
    },
    async uploadInput(asset: { filename: string; mimeType: string; bytes: Uint8Array }) {
      uploads.push(asset);
      return { filename: asset.filename, type: 'input', kind: 'image' };
    },
  } as unknown as ComfyClient & {
    prompts: ComfyPrompt[];
    mediaQueries: URLSearchParams[];
    mediaRanges: Array<string | undefined>;
    enqueueClientIds: string[];
    eventClientIds: string[];
    cancelledPromptIds: string[];
    uploads: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
  };
}

function fakeFlashVsrWorker(options: {
  health?: FlashVsrWorkerHealth;
  created?: FlashVsrWorkerJob;
  polled?: FlashVsrWorkerJob[];
} = {}): FlashVsrWorkerClient & {
  createdRequests: FlashVsrWorkerRequest[];
  cancelledIds: string[];
} {
  const createdRequests: FlashVsrWorkerRequest[] = [];
  const cancelledIds: string[] = [];
  const defaultJob: FlashVsrWorkerJob = options.created ?? {
    id: 'up-123', state: 'queued', target: '2k', width: 2560, height: 1478, totalElapsedMs: 0,
  };
  const polled = [...(options.polled ?? [defaultJob])];
  return {
    createdRequests,
    cancelledIds,
    async health() {
      return options.health ?? {
        available: true,
        model: 'flashvsr-v1.1',
        supportedTargets: ['2k', '4k'],
      };
    },
    async createJob(input) {
      createdRequests.push(input);
      return defaultJob;
    },
    async getJob() {
      return polled.shift() ?? defaultJob;
    },
    async cancelJob(id) {
      cancelledIds.push(id);
      return { ...defaultJob, state: 'cancelling', message: '正在停止超分任务…' };
    },
  };
}

function fakeDeterministicUpscaleWorker(options: {
  health?: DeterministicUpscaleWorkerHealth;
  created?: DeterministicUpscaleWorkerJob;
  polled?: DeterministicUpscaleWorkerJob[];
} = {}): DeterministicUpscaleWorkerClient & {
  createdRequests: DeterministicUpscaleWorkerRequest[];
  cancelledIds: string[];
} {
  const createdRequests: DeterministicUpscaleWorkerRequest[] = [];
  const cancelledIds: string[] = [];
  const defaultJob: DeterministicUpscaleWorkerJob = options.created ?? {
    id: 'det-123', state: 'queued', target: '2k', width: 2560, height: 1478, totalElapsedMs: 0,
  };
  const polled = [...(options.polled ?? [defaultJob])];
  return {
    createdRequests,
    cancelledIds,
    async health() {
      return options.health ?? {
        available: true,
        model: 'realesrgan-x2plus-fp16',
        supportedProfiles: [{ sourceWidth: 832, sourceHeight: 480, target: '2k', width: 2560, height: 1478 }],
      };
    },
    async createJob(input) {
      createdRequests.push(input);
      return defaultJob;
    },
    async getJob() {
      return polled.shift() ?? defaultJob;
    },
    async cancelJob(id) {
      cancelledIds.push(id);
      return { ...defaultJob, state: 'cancelling', message: '正在停止稳定增强任务…' };
    },
  };
}

const completedCoffeeHistory = {
  outputs: {
    '15': {
      gifs: [{ filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' }],
    },
  },
};

async function completeVideoJob(app: ReturnType<typeof createApp>, client: ComfyClient): Promise<void> {
  let emit: ((event: ComfyEvent) => void) | undefined;
  client.openEvents = (_promptId, _clientId, listener) => {
    emit = listener;
    return () => undefined;
  };
  await request(app).post('/api/jobs').send(validRequest).expect(202);
  emit?.({ type: 'execution_success', data: { prompt_id: 'p-123' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('H3 Studio BFF', () => {
  it('submits a valid job and returns its Comfy prompt id', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send(validRequest);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      id: 'p-123',
      state: 'queued',
      actualFrames: 124,
      totalElapsedMs: 0,
    });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]['7'].inputs).toMatchObject({
      prompt: validRequest.prompt,
      width: 832,
      height: 480,
    });
    expect(client.eventClientIds[0]).toBe(client.enqueueClientIds[0]);
  });

  it('keeps an execution error terminal when ComfyUI later emits a completion event', async () => {
    const client = fakeClient();
    let emit: ((event: ComfyEvent) => void) | undefined;
    client.openEvents = (_promptId, _clientId, listener) => {
      emit = listener;
      return () => undefined;
    };
    const app = createApp(client);

    await request(app).post('/api/jobs').send(validRequest).expect(202);
    expect(emit).toBeTypeOf('function');
    emit?.({ type: 'execution_error', data: { prompt_id: 'p-123' } });
    emit?.({ type: 'execution_success', data: { prompt_id: 'p-123' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshot = await request(app).get('/api/jobs/p-123').expect(200);
    expect(snapshot.body.state).toBe('failed');
  });

  it('persists the Standard cuBLAS opt-in and routes it into the Comfy graph', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, h3StandardCublasInt8: true });

    expect(response.status).toBe(202);
    expect(response.body.h3StandardCublasInt8).toBe(true);
    expect(client.prompts[0]['20']).toMatchObject({
      class_type: 'MiniMaxH3GB10CublasInt8',
      inputs: { model: ['2', 0], allow_standard: true },
    });
    expect(client.prompts[0]['3'].inputs.model).toEqual(['20', 0]);
    expect(client.prompts[0]['10'].inputs.model).toEqual(['20', 0]);
  });

  it('persists the Standard AdaGEMM opt-in and routes it into the Comfy graph', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, h3StandardAdaGemmInt8: true });

    expect(response.status).toBe(202);
    expect(response.body.h3StandardAdaGemmInt8).toBe(true);
    expect(client.prompts[0]['20']).toMatchObject({
      class_type: 'MiniMaxH3GB10AdaGemmInt8',
      inputs: { model: ['2', 0], enabled: true, scope: 'qkv_out_mlp' },
    });
  });

  it('rejects the Standard AdaGEMM opt-in when its node is unavailable', async () => {
    const client = fakeClient({
      services: {
        ...allServicesAvailable,
        h3StandardAdaGemmInt8: { available: false, reason: '未检测到 AdaGEMM 节点。' },
      },
    });

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, h3StandardAdaGemmInt8: true });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('未检测到 AdaGEMM 节点');
    expect(client.prompts).toHaveLength(0);
  });

  it('rejects the Standard cuBLAS opt-in when its compatible node is unavailable', async () => {
    const client = fakeClient({
      services: {
        ...allServicesAvailable,
        h3StandardCublasInt8: { available: false, reason: '节点不支持 H3 Standard。' },
      },
    });

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, h3StandardCublasInt8: true });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('节点不支持 H3 Standard');
    expect(client.prompts).toHaveLength(0);
  });

  it('rejects an unavailable FastH3 service before it reaches ComfyUI', async () => {
    const client = fakeClient({
      services: {
        ...allServicesAvailable,
        fastH3Vsa: { available: false, reason: '缺少 H3VSA 节点。' },
      },
    });

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        service: 'fasth3_vsa',
        fastH3Profile: 'baseline',
        fastH3CublasInt8: false,
        fastH3VaeTileBatch: false,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('缺少 H3VSA 节点');
    expect(client.prompts).toHaveLength(0);
  });

  it('persists direct FastH3 accelerators without a profile mode in the job snapshot', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        service: 'fasth3_vsa',
        steps: 4,
        samplerName: 'euler',
        fastH3Profile: 'baseline',
        fastH3CublasInt8: true,
        fastH3VaeTileBatch: true,
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      service: 'fasth3_vsa',
      fastH3CublasInt8: true,
      fastH3VaeTileBatch: true,
      steps: 4,
      samplerName: 'euler',
    });
    expect(response.body).not.toHaveProperty('fastH3Profile');
  });

  it('persists the lossless FastH3 GB10 VSA layout kernel opt-in', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        service: 'fasth3_vsa',
        steps: 4,
        samplerName: 'euler',
        fastH3Gb10VsaKernel: true,
      });

    expect(response.status).toBe(202);
    expect(response.body.fastH3Gb10VsaKernel).toBe(true);
    expect(client.prompts[0]['23']).toMatchObject({
      class_type: 'H3StudioFastH3GB10VSA',
      inputs: { model: ['2', 0], enabled: true },
    });
  });

  it('preserves the VAE Tile Batch opt-in from the API job to the Comfy workflow', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, vaeTileBatch: true });

    expect(response.status).toBe(202);
    expect(response.body.vaeTileBatch).toBe(true);
    expect(client.prompts[0]['12']).toMatchObject({
      class_type: 'MiniMaxH3VAEDecodeBatched',
      inputs: { samples: ['11', 0], vae: ['5', 0], tile_batch_size: 2 },
    });
  });

  it('keeps a requested stop live until ComfyUI confirms the matching interruption', async () => {
    const client = fakeClient();
    let emit: ((event: ComfyEvent) => void) | undefined;
    client.openEvents = (_promptId, _clientId, listener) => {
      emit = listener;
      return () => undefined;
    };
    const app = createApp(client);

    await request(app).post('/api/jobs').send(validRequest).expect(202);
    emit?.({ type: 'progress', data: { prompt_id: 'p-123', value: 2, max: 20 } });
    const response = await request(app).post('/api/jobs/p-123/stop');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'p-123', state: 'cancelling' });
    expect(client.cancelledPromptIds).toEqual(['p-123']);

    emit?.({ type: 'execution_interrupted', data: { prompt_id: 'p-123' } });
    const snapshot = await request(app).get('/api/jobs/p-123').expect(200);
    expect(snapshot.body).toMatchObject({ id: 'p-123', state: 'cancelled' });
  });

  it('lets a completion event win when it races a requested stop', async () => {
    const client = fakeClient();
    let emit: ((event: ComfyEvent) => void) | undefined;
    client.openEvents = (_promptId, _clientId, listener) => {
      emit = listener;
      return () => undefined;
    };
    const app = createApp(client);

    await request(app).post('/api/jobs').send(validRequest).expect(202);
    await request(app).post('/api/jobs/p-123/stop').expect(200);
    emit?.({ type: 'execution_success', data: { prompt_id: 'p-123' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshot = await request(app).get('/api/jobs/p-123').expect(200);
    expect(snapshot.body.state).toBe('completed');
  });

  it('submits Feature Cache Safe as an upstream model patch when the client opts in', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, featureCacheSafe: true });

    expect(response.status).toBe(202);
    expect(response.body.featureCacheSafe).toBe(true);
    expect(client.prompts[0]['16']).toMatchObject({
      class_type: 'ApplyMiniMaxH3FirstBlockCache',
      inputs: { model: ['1', 0], mode: 'H3 Safe — 0.08 / max 2' },
    });
    expect(client.prompts[0]['2'].inputs.model).toEqual(['16', 0]);
  });

  it('submits the Fast cache preset and can opt out of the Sparge model patch', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        featureCacheSafe: true,
        featureCacheProfile: 'fast',
        spargeAttention: false,
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      featureCacheSafe: true,
      featureCacheProfile: 'fast',
      spargeAttention: false,
    });
    expect(client.prompts[0]['16'].inputs).toMatchObject({ mode: 'H3 Fast — 0.10 / max 2' });
    expect(client.prompts[0]['2']).toBeUndefined();
    expect(client.prompts[0]['3'].inputs.model).toEqual(['16', 0]);
  });

  it('returns every selected preview optimization in the job snapshot', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        steps: 6,
        samplerName: 'res_multistep',
        spargeAttention: true,
        spargeProfile: 'fast',
        featureCacheSafe: true,
        featureCacheProfile: 'fast',
        fusedModulation: true,
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      steps: 6,
      samplerName: 'res_multistep',
      spargeAttention: true,
      spargeProfile: 'fast',
      featureCacheSafe: true,
      featureCacheProfile: 'fast',
      fusedModulation: true,
    });
    expect(client.prompts[0]['18']).toMatchObject({ class_type: 'MiniMaxH3FusedModulation' });
  });

  it('does not submit an invalid resolution', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({ ...validRequest, width: 1920, height: 1080 });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('480P 或 720P');
    expect(client.prompts).toHaveLength(0);
  });

  it('reports disconnected when the ComfyUI health probe fails', async () => {
    const response = await request(createApp(fakeClient({ connected: false }))).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ connected: false });
  });

  it('merges a FlashVSR compatibility-gate failure without hiding normal ComfyUI health', async () => {
    const worker = fakeFlashVsrWorker({
      health: {
        available: false,
        model: 'flashvsr-v1.1',
        supportedTargets: [],
        reason: 'gb10_720p: unsupported kernel',
      },
    });

    const response = await request(createApp(fakeClient(), worker)).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.services.flashVsr).toEqual({
      available: false,
      supportedTargets: [],
      model: 'flashvsr-v1.1',
      reason: 'gb10_720p: unsupported kernel',
    });
  });

  it('exposes deterministic enhancement separately and dispatches its explicit method', async () => {
    const client = fakeClient({ history: completedCoffeeHistory });
    const flashVsr = fakeFlashVsrWorker();
    const deterministic = fakeDeterministicUpscaleWorker();
    const app = createApp(client, flashVsr, { deterministicUpscale: deterministic, upscalePollIntervalMs: 1 });
    await completeVideoJob(app, client);

    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.services.deterministicUpscale).toEqual({
      available: true,
      model: 'realesrgan-x2plus-fp16',
      supportedProfiles: [{ sourceWidth: 832, sourceHeight: 480, target: '2k', width: 2560, height: 1478 }],
    });

    const started = await request(app)
      .post('/api/jobs/p-123/upscale')
      .send({ method: 'deterministic', target: '2k' })
      .expect(202);

    expect(deterministic.createdRequests).toEqual([{
      source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      target: '2k',
    }]);
    expect(flashVsr.createdRequests).toEqual([]);

    await request(app).post(`/api/upscale-jobs/${started.body.id}/stop`).expect(200);
    expect(deterministic.cancelledIds).toEqual(['det-123']);
  });

  it('starts deterministic 2K enhancement for a safe historical output that is no longer an in-memory generation job', async () => {
    const deterministic = fakeDeterministicUpscaleWorker();
    const app = createApp(fakeClient(), fakeFlashVsrWorker(), {
      deterministicUpscale: deterministic,
      upscalePollIntervalMs: 1,
    });

    const started = await request(app)
      .post('/api/history/upscale')
      .send({
        sourceJobId: 'history-coffee',
        source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
        width: 832,
        height: 480,
        method: 'deterministic',
        target: '2k',
      })
      .expect(202);

    expect(started.body).toMatchObject({
      id: 'det-123',
      sourceJobId: 'history-coffee',
      method: 'deterministic',
      target: '2k',
    });
    expect(deterministic.createdRequests).toEqual([{
      source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      target: '2k',
    }]);
  });

  it('starts deterministic 2K enhancement for a verified 720P historical output', async () => {
    const deterministic = fakeDeterministicUpscaleWorker({
      health: {
        available: true,
        model: 'realesrgan-x2plus-fp16',
        supportedProfiles: [{ sourceWidth: 1280, sourceHeight: 720, target: '2k', width: 2560, height: 1440 }],
      },
      created: { id: 'det-720', state: 'queued', target: '2k', width: 2560, height: 1440, totalElapsedMs: 0 },
    });
    const app = createApp(fakeClient(), fakeFlashVsrWorker(), {
      deterministicUpscale: deterministic,
      upscalePollIntervalMs: 1,
    });

    const started = await request(app)
      .post('/api/history/upscale')
      .send({
        sourceJobId: 'history-720',
        source: { filename: 'coffee-720.mp4', subfolder: 'H3Studio', type: 'output' },
        width: 1280,
        height: 720,
        method: 'deterministic',
        target: '2k',
      })
      .expect(202);

    expect(started.body).toMatchObject({
      id: 'det-720',
      sourceJobId: 'history-720',
      method: 'deterministic',
      target: '2k',
      width: 2560,
      height: 1440,
    });
  });

  it('authorizes a completed H3 output, rejects 480P 4K, then polls a verified enhancement result', async () => {
    const client = fakeClient({ history: completedCoffeeHistory });
    const worker = fakeFlashVsrWorker({
      polled: [{
        id: 'up-123', state: 'completed', target: '2k', width: 2560, height: 1478, totalElapsedMs: 920,
        media: { filename: 'coffee_up-123.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
      }],
    });
    const app = createApp(client, worker, { upscalePollIntervalMs: 1 });
    await completeVideoJob(app, client);

    await request(app).post('/api/jobs/p-123/upscale').send({ target: '4k' }).expect(400);
    const started = await request(app).post('/api/jobs/p-123/upscale').send({ target: '2k' }).expect(202);

    expect(worker.createdRequests).toEqual([{
      source: { filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' },
      target: '2k',
    }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const source = await request(app).get('/api/jobs/p-123').expect(200);
    expect(source.body.media).toEqual({ filename: 'coffee.mp4', subfolder: 'H3Studio', type: 'output' });
    expect(source.body.enhancements).toContainEqual(expect.objectContaining({
      id: started.body.id,
      state: 'completed',
      media: { filename: 'coffee_up-123.mp4', subfolder: 'H3Studio/upscaled', type: 'output' },
    }));
  });

  it('does not send an unsafe or unfinished H3 output to the worker', async () => {
    const unsafeClient = fakeClient({
      history: { outputs: { '15': { gifs: [{ filename: '../outside.mp4', type: 'output' }] } } },
    });
    const worker = fakeFlashVsrWorker();
    const unsafeApp = createApp(unsafeClient, worker);
    await completeVideoJob(unsafeApp, unsafeClient);
    await request(unsafeApp).post('/api/jobs/p-123/upscale').send({ target: '2k' }).expect(400);
    expect(worker.createdRequests).toEqual([]);

    const unfinishedApp = createApp(fakeClient(), worker);
    await request(unfinishedApp).post('/api/jobs').send(validRequest).expect(202);
    await request(unfinishedApp).post('/api/jobs/p-123/upscale').send({ target: '2k' }).expect(409);
  });

  it('proxies a completed video reference without exposing the ComfyUI host', async () => {
    const client = fakeClient({
      media: new Response('video-bytes', { headers: { 'content-type': 'video/mp4' } }),
    });

    const response = await request(createApp(client))
      .get('/api/media?filename=coffee.mp4&subfolder=H3Studio&type=output');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('video/mp4');
    expect(response.body.toString()).toBe('video-bytes');
    expect(client.mediaQueries[0].toString()).toContain('filename=coffee.mp4');
  });

  it('preserves a browser byte-range request when proxying a video', async () => {
    const client = fakeClient({
      media: new Response('video-bytes', {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '11',
          'content-range': 'bytes 0-10/100',
          'content-type': 'video/mp4',
        },
      }),
    });

    const response = await request(createApp(client))
      .get('/api/media?filename=coffee.mp4&type=output')
      .set('Range', 'bytes=0-10');

    expect(response.status).toBe(206);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toBe('bytes 0-10/100');
    expect(response.headers['content-length']).toBe('11');
    expect(client.mediaRanges).toEqual(['bytes=0-10']);
  });

  it('accepts a validated browser image upload and returns an input-only asset reference', async () => {
    const client = fakeClient();

    const response = await request(createApp(client))
      .post('/api/assets?kind=image')
      .set('Content-Type', 'image/png')
      .set('X-File-Name', encodeURIComponent('coffee-reference.png'))
      .send(Buffer.from('png-bytes'));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ filename: 'coffee-reference.png', type: 'input', kind: 'image' });
    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0]).toMatchObject({ filename: 'coffee-reference.png', mimeType: 'image/png' });
  });

  it('submits a Ref2VA job only after the reference capability is available', async () => {
    const client = fakeClient({
      services: {
        ...allServicesAvailable,
        h3References: { available: true },
      } as unknown as ComfyServiceCapabilities,
    });

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        inputMode: 'references',
        referenceImages: [{ filename: 'coffee-reference.png', type: 'input', kind: 'image' }],
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ inputMode: 'references', service: 'h3_standard' });
    expect(client.prompts[0]['7']).toMatchObject({ class_type: 'MiniMaxH3ReferenceToVideo' });
  });

  it('submits MiniMax Music3 through the same local job lifecycle', async () => {
    const client = fakeClient({
      services: {
        ...allServicesAvailable,
        music3: { available: true },
      } as unknown as ComfyServiceCapabilities,
    });

    const response = await request(createApp(client))
      .post('/api/jobs')
      .send({
        ...validRequest,
        service: 'music3',
        seconds: 10,
        lyrics: '[verse] warm room tone',
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ service: 'music3', steps: 30, actualFrames: 0 });
    expect(client.prompts[0]['4']).toMatchObject({ class_type: 'MiniMaxMusic3TextEncode' });
  });
});
