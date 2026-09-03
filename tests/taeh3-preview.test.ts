import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import type { ComfyClient, ComfyEvent } from '../server/comfy-client';
import { buildH3Workflow, normalizeGenerationRequest } from '../server/workflow';

const baseRequest = {
  prompt: 'A cinematic cup of coffee with gentle steam',
  width: 832,
  height: 480,
  seconds: 5,
  steps: 20,
  seed: 42,
  taeH3Preview: true,
};

describe('TAEH3 live preview', () => {
  it('wraps the final model path for both scheduler and guider without changing final VAE decode', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest(baseRequest));

    expect(workflow['90']).toMatchObject({
      class_type: 'H3StudioTAEH3PreviewLoader',
      inputs: {},
    });
    expect(workflow['91']).toMatchObject({
      class_type: 'MiniMaxH3PreviewOverride',
      inputs: {
        model: ['2', 0],
        tiny_vae: ['90', 0],
        preview_frames: 1,
        jpeg_quality: 80,
      },
    });
    expect(workflow['3'].inputs.model).toEqual(['91', 0]);
    expect(workflow['10'].inputs.model).toEqual(['91', 0]);
    expect(workflow['12']).toMatchObject({
      class_type: 'VAEDecode',
      inputs: { samples: ['11', 0], vae: ['5', 0] },
    });
  });

  it('forwards a validated Comfy preview frame into the job snapshot', async () => {
    let listener: ((event: ComfyEvent) => void) | undefined;
    const client: ComfyClient = {
      health: async () => ({
        connected: true,
        services: {
          h3Standard: { available: true },
          h3StandardCublasInt8: { available: true },
          fastH3Vsa: { available: true },
          fastH3CublasInt8: { available: true },
          fastH3VaeTileBatch: { available: true },
          taeH3Preview: { available: true },
        },
      }),
      enqueue: async () => ({ promptId: 'preview-job' }),
      cancel: async () => ({ state: 'cancelling' }),
      getHistory: async () => null,
      openEvents: (_promptId, _clientId, nextListener) => {
        listener = nextListener;
        return () => undefined;
      },
      getMedia: async () => null,
      uploadInput: async (asset) => ({ filename: asset.filename, type: 'input', kind: asset.kind }),
    };
    const app = createApp(client);

    await request(app).post('/api/jobs').send(baseRequest).expect(202);
    listener?.({
      type: 'minimax_h3_preview_override',
      data: {
        image: 'aGVsbG8=',
        mime: 'image/jpeg',
        w: 416,
        h: 240,
        step: 2,
        total: 6,
        avg_step_ms: 1200,
      },
    });

    const response = await request(app).get('/api/jobs/preview-job').expect(200);
    expect(response.body).toMatchObject({
      state: 'sampling',
      step: 2,
      totalSteps: 6,
      taeH3Preview: true,
      preview: {
        dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
        mime: 'image/jpeg',
        width: 416,
        height: 240,
        step: 2,
        totalSteps: 6,
      },
    });
  });
});
