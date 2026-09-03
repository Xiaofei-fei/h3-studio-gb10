import type { MediaReference, UpscaleState } from './types.js';

export interface DeterministicUpscaleProfile {
  sourceWidth: number;
  sourceHeight: number;
  target: '2k';
  width: number;
  height: number;
}

export interface DeterministicUpscaleWorkerHealth {
  available: boolean;
  reason?: string;
  model: 'realesrgan-x2plus-fp16';
  supportedProfiles: DeterministicUpscaleProfile[];
}

export interface DeterministicUpscaleWorkerJob {
  id: string;
  state: UpscaleState;
  target: '2k';
  width: number;
  height: number;
  totalElapsedMs: number;
  message?: string;
  media?: MediaReference;
}

export interface DeterministicUpscaleWorkerRequest {
  source: MediaReference & { type: 'output' };
  target: '2k';
}

export interface DeterministicUpscaleWorkerClient {
  health(): Promise<DeterministicUpscaleWorkerHealth>;
  createJob(input: DeterministicUpscaleWorkerRequest): Promise<DeterministicUpscaleWorkerJob>;
  getJob(id: string): Promise<DeterministicUpscaleWorkerJob>;
  cancelJob(id: string): Promise<DeterministicUpscaleWorkerJob>;
}

const UNAVAILABLE_HEALTH: DeterministicUpscaleWorkerHealth = {
  available: false,
  reason: '本地稳定增强服务未部署。',
  model: 'realesrgan-x2plus-fp16',
  supportedProfiles: [],
};

export class DisabledDeterministicUpscaleWorkerClient implements DeterministicUpscaleWorkerClient {
  async health(): Promise<DeterministicUpscaleWorkerHealth> {
    return UNAVAILABLE_HEALTH;
  }

  async createJob(): Promise<DeterministicUpscaleWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }

  async getJob(): Promise<DeterministicUpscaleWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }

  async cancelJob(): Promise<DeterministicUpscaleWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }
}

export class HttpDeterministicUpscaleWorkerClient implements DeterministicUpscaleWorkerClient {
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:8191') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<DeterministicUpscaleWorkerHealth> {
    try {
      return await this.request<DeterministicUpscaleWorkerHealth>('/health', {}, 10_000);
    } catch {
      return { ...UNAVAILABLE_HEALTH, reason: '本地稳定增强服务未启动。' };
    }
  }

  createJob(input: DeterministicUpscaleWorkerRequest): Promise<DeterministicUpscaleWorkerJob> {
    return this.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, 15_000);
  }

  getJob(id: string): Promise<DeterministicUpscaleWorkerJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, {}, 10_000);
  }

  cancelJob(id: string): Promise<DeterministicUpscaleWorkerJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, 10_000);
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as T & { detail?: string; message?: string; reason?: string };
    if (!response.ok) {
      throw new Error(payload.detail || payload.message || payload.reason || '稳定增强服务暂不可用。');
    }
    return payload;
  }
}
