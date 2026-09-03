import { readFile } from 'node:fs/promises';
import type { MediaReference, UpscaleState, UpscaleTarget } from './types.js';

export interface FlashVsrWorkerHealth {
  available: boolean;
  reason?: string;
  model: 'flashvsr-v1.1';
  supportedTargets: UpscaleTarget[];
}

export interface FlashVsrWorkerJob {
  id: string;
  state: UpscaleState;
  target: UpscaleTarget;
  width: number;
  height: number;
  totalElapsedMs: number;
  message?: string;
  media?: MediaReference;
}

export interface FlashVsrWorkerRequest {
  source: MediaReference & { type: 'output' };
  target: UpscaleTarget;
}

export interface FlashVsrWorkerClient {
  health(): Promise<FlashVsrWorkerHealth>;
  createJob(input: FlashVsrWorkerRequest): Promise<FlashVsrWorkerJob>;
  getJob(id: string): Promise<FlashVsrWorkerJob>;
  cancelJob(id: string): Promise<FlashVsrWorkerJob>;
}

const UNAVAILABLE_HEALTH: FlashVsrWorkerHealth = {
  available: false,
  reason: '本地 FlashVSR 服务未部署。',
  model: 'flashvsr-v1.1',
  supportedTargets: [],
};

export class DisabledFlashVsrWorkerClient implements FlashVsrWorkerClient {
  async health(): Promise<FlashVsrWorkerHealth> {
    return UNAVAILABLE_HEALTH;
  }

  async createJob(): Promise<FlashVsrWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }

  async getJob(): Promise<FlashVsrWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }

  async cancelJob(): Promise<FlashVsrWorkerJob> {
    throw new Error(UNAVAILABLE_HEALTH.reason);
  }
}

export class HttpFlashVsrWorkerClient implements FlashVsrWorkerClient {
  private readonly baseUrl: string;
  private readonly compatibilityStatePath?: string;

  constructor(baseUrl = 'http://127.0.0.1:8190', compatibilityStatePath?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.compatibilityStatePath = compatibilityStatePath;
  }

  async health(): Promise<FlashVsrWorkerHealth> {
    try {
      return await this.request<FlashVsrWorkerHealth>('/health', {}, 10_000);
    } catch {
      const persistedState = await this.readCompatibilityState();
      if (persistedState) return persistedState;
      return { ...UNAVAILABLE_HEALTH, reason: '本地 FlashVSR 服务未启动。' };
    }
  }

  createJob(input: FlashVsrWorkerRequest): Promise<FlashVsrWorkerJob> {
    return this.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, 15_000);
  }

  getJob(id: string): Promise<FlashVsrWorkerJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, {}, 10_000);
  }

  cancelJob(id: string): Promise<FlashVsrWorkerJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, 10_000);
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as T & { detail?: string; message?: string; reason?: string };
    if (!response.ok) {
      throw new Error(payload.detail || payload.message || payload.reason || `FlashVSR 服务暂不可用。`);
    }
    return payload;
  }

  private async readCompatibilityState(): Promise<FlashVsrWorkerHealth | undefined> {
    if (!this.compatibilityStatePath) return undefined;

    try {
      const payload = JSON.parse(await readFile(this.compatibilityStatePath, 'utf8')) as Partial<FlashVsrWorkerHealth>;
      const supportedTargets = payload.supportedTargets;
      if (
        payload.available !== false
        || payload.model !== 'flashvsr-v1.1'
        || !Array.isArray(supportedTargets)
        || !supportedTargets.every((target) => target === '2k' || target === '4k')
        || typeof payload.reason !== 'string'
        || !payload.reason.trim()
      ) {
        return undefined;
      }

      return {
        available: false,
        model: 'flashvsr-v1.1',
        supportedTargets,
        reason: payload.reason,
      };
    } catch {
      return undefined;
    }
  }
}
