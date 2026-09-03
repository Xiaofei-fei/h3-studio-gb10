import type {
  ConnectionStatus,
  GenerationForm,
  GenerationJob,
  InputAsset,
  InputAssetKind,
  MediaReference,
  UpscaleJobSnapshot,
  UpscaleMethod,
  UpscaleTarget,
} from './types';

export interface StudioApi {
  getHealth(): Promise<ConnectionStatus>;
  submitJob(input: GenerationForm): Promise<GenerationJob>;
  stopJob(id: string): Promise<GenerationJob>;
  openJobEvents(id: string, listener: (job: Partial<GenerationJob>) => void): () => void;
  startUpscale(source: string | HistoricalUpscaleInput, method: UpscaleMethod, target: UpscaleTarget): Promise<UpscaleJobSnapshot>;
  getUpscaleJob(id: string): Promise<UpscaleJobSnapshot>;
  stopUpscale(id: string): Promise<UpscaleJobSnapshot>;
  openUpscaleEvents(id: string, listener: (job: Partial<UpscaleJobSnapshot>) => void): () => void;
  mediaUrl(media: MediaReference): string;
  uploadAsset?(file: File, kind: InputAssetKind): Promise<InputAsset>;
}

export interface HistoricalUpscaleInput {
  sourceJobId: string;
  source: MediaReference & { type: 'output' };
  width: number;
  height: number;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || '暂时无法连接到视频生成服务。');
  return body;
}

export function createStudioApi(baseUrl = '/api'): StudioApi {
  return {
    async getHealth() {
      const response = await fetch(`${baseUrl}/health`);
      if (!response.ok) return { connected: false };
      return readJson<ConnectionStatus>(response);
    },
    async submitJob(input) {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return readJson<GenerationJob>(response);
    },
    async stopJob(id) {
      const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      return readJson<GenerationJob>(response);
    },
    openJobEvents(id, listener) {
      const source = new EventSource(`${baseUrl}/jobs/${encodeURIComponent(id)}/events`);
      const onUpdate = (event: Event) => {
        try {
          listener(JSON.parse((event as MessageEvent<string>).data) as Partial<GenerationJob>);
        } catch {
          // Ignore malformed local event payloads and keep the stream available for the next update.
        }
      };
      source.addEventListener('update', onUpdate);
      return () => {
        source.removeEventListener('update', onUpdate);
        source.close();
      };
    },
    async startUpscale(source, method, target) {
      const isHistorical = typeof source !== 'string';
      const response = await fetch(isHistorical ? `${baseUrl}/history/upscale` : `${baseUrl}/jobs/${encodeURIComponent(source)}/upscale`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isHistorical ? { ...source, method, target } : { method, target }),
      });
      return readJson<UpscaleJobSnapshot>(response);
    },
    async getUpscaleJob(id) {
      const response = await fetch(`${baseUrl}/upscale-jobs/${encodeURIComponent(id)}`);
      return readJson<UpscaleJobSnapshot>(response);
    },
    async stopUpscale(id) {
      const response = await fetch(`${baseUrl}/upscale-jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      return readJson<UpscaleJobSnapshot>(response);
    },
    openUpscaleEvents(id, listener) {
      const source = new EventSource(`${baseUrl}/upscale-jobs/${encodeURIComponent(id)}/events`);
      const onUpdate = (event: Event) => {
        try {
          listener(JSON.parse((event as MessageEvent<string>).data) as Partial<UpscaleJobSnapshot>);
        } catch {
          // Ignore malformed local event payloads and keep the stream available for the next update.
        }
      };
      source.addEventListener('update', onUpdate);
      return () => {
        source.removeEventListener('update', onUpdate);
        source.close();
      };
    },
    mediaUrl(media) {
      const query = new URLSearchParams({ filename: media.filename, type: media.type || 'output' });
      if (media.subfolder) query.set('subfolder', media.subfolder);
      return `${baseUrl}/media?${query.toString()}`;
    },
    async uploadAsset(file, kind) {
      const response = await fetch(`${baseUrl}/assets?kind=${encodeURIComponent(kind)}`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      return readJson<InputAsset>(response);
    },
  };
}

export const studioApi = createStudioApi();
