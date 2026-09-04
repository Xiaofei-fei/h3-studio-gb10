import { useCallback, useEffect, useRef, useState } from 'react';
import { studioApi, type HistoricalUpscaleInput, type StudioApi } from '../api';
import type {
  ConnectionStatus,
  GenerationForm,
  GenerationJob,
  UpscaleJobSnapshot,
  UpscaleMethod,
  UpscaleTarget,
  VideoEnhancement,
} from '../types';

const HISTORY_STORAGE_KEY = 'h3-studio-history-v1';
const MAX_HISTORY_ITEMS = 6;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_UPSCALE_STATES = new Set(['completed', 'failed', 'cancelled']);

function readHistory(): GenerationJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, MAX_HISTORY_ITEMS) as GenerationJob[] : [];
  } catch {
    return [];
  }
}

function persistHistory(history: GenerationJob[]) {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
  }
}

function isTerminalUpscale(state: string | undefined): boolean {
  return Boolean(state && TERMINAL_UPSCALE_STATES.has(state));
}

function mergeEnhancement(
  job: GenerationJob,
  patch: Partial<UpscaleJobSnapshot>,
  fallbackId?: string,
): GenerationJob {
  const id = patch.id || fallbackId;
  if (!id) return job;
  const existing = job.enhancements?.find((item) => item.id === id);
  const state = patch.state || existing?.state || 'queued';
  const next: VideoEnhancement = {
    id,
    ...(patch.method !== undefined ? { method: patch.method } : existing?.method ? { method: existing.method } : {}),
    target: patch.target || existing?.target || '2k',
    state,
    width: patch.width ?? existing?.width ?? 0,
    height: patch.height ?? existing?.height ?? 0,
    totalElapsedMs: patch.totalElapsedMs ?? existing?.totalElapsedMs ?? 0,
    ...(patch.message !== undefined ? { message: patch.message } : existing?.message ? { message: existing.message } : {}),
    ...(state === 'completed'
      ? (patch.media ? { media: patch.media } : existing?.media ? { media: existing.media } : {})
      : {}),
  };
  const enhancements = existing
    ? (job.enhancements || []).map((item) => item.id === id ? next : item)
    : [...(job.enhancements || []), next];
  return { ...job, enhancements, updatedAt: new Date().toISOString() };
}

export function useGeneration(api: StudioApi = studioApi) {
  const closeEvents = useRef<(() => void) | undefined>(undefined);
  const closeUpscaleEvents = useRef<(() => void) | undefined>(undefined);
  const activeUpscaleId = useRef<string | undefined>(undefined);
  const activeUpscaleSourceJobId = useRef<string | undefined>(undefined);
  const [connection, setConnection] = useState<ConnectionStatus>({ connected: false });
  const [currentJob, setCurrentJob] = useState<GenerationJob | null>(null);
  const [history, setHistory] = useState<GenerationJob[]>(readHistory);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | undefined>(undefined);
  const [isUpscaling, setIsUpscaling] = useState(false);
  const [upscaleError, setUpscaleError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void api.getHealth()
      .then((health) => active && setConnection(health))
      .catch(() => active && setConnection({ connected: false }));
    return () => {
      active = false;
      closeEvents.current?.();
      closeUpscaleEvents.current?.();
    };
  }, [api]);

  const storeCompleted = useCallback((job: GenerationJob) => {
    if (job.state !== 'completed') return;
    const historyJob = { ...job, preview: undefined };
    setHistory((existing) => {
      const next = [historyJob, ...existing.filter((item) => item.id !== job.id)].slice(0, MAX_HISTORY_ITEMS);
      persistHistory(next);
      return next;
    });
  }, []);

  const receiveUpdate = useCallback((event: Partial<GenerationJob>) => {
    setCurrentJob((current) => {
      if (!current) return current;
      const next = { ...current, ...event, updatedAt: event.updatedAt || new Date().toISOString() };
      storeCompleted(next);
      if (TERMINAL_STATES.has(next.state)) closeEvents.current?.();
      return next;
    });
  }, [storeCompleted]);

  const applyUpscaleUpdate = useCallback((sourceJobId: string, event: Partial<UpscaleJobSnapshot>, fallbackId?: string) => {
    const enhancementId = event.id || fallbackId;
    const updateCurrent = (current: GenerationJob | null) => (
      current?.id === sourceJobId ? mergeEnhancement(current, event, enhancementId) : current
    );
    setCurrentJob(updateCurrent);
    setHistory((existing) => {
      const next = existing.map((job) => job.id === sourceJobId ? mergeEnhancement(job, event, enhancementId) : job);
      persistHistory(next);
      return next;
    });
    if (isTerminalUpscale(event.state)) {
      closeUpscaleEvents.current?.();
      closeUpscaleEvents.current = undefined;
      activeUpscaleId.current = undefined;
      activeUpscaleSourceJobId.current = undefined;
      setIsUpscaling(false);
    }
  }, []);

  const generate = useCallback(async (input: GenerationForm) => {
    closeEvents.current?.();
    closeUpscaleEvents.current?.();
    activeUpscaleId.current = undefined;
    activeUpscaleSourceJobId.current = undefined;
    setIsUpscaling(false);
    setUpscaleError(undefined);
    setStopError(undefined);
    try {
      const job = await api.submitJob(input);
      setCurrentJob(job);
      closeEvents.current = api.openJobEvents(job.id, receiveUpdate);
      return job;
    } catch (error) {
      const timestamp = new Date().toISOString();
      const failed: GenerationJob = {
        ...input,
        id: `local-${Date.now()}`,
        state: 'failed',
        actualFrames: 0,
        actualSeconds: 0,
        totalElapsedMs: 0,
        message: error instanceof Error ? error.message : '提交生成任务时出现问题。',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setCurrentJob(failed);
      throw error;
    }
  }, [api, receiveUpdate]);

  const retry = useCallback(async () => {
    if (!currentJob) return undefined;
    return generate({
      service: currentJob.service || 'h3_standard',
      prompt: currentJob.prompt,
      width: currentJob.width,
      height: currentJob.height,
      seconds: currentJob.seconds,
      steps: currentJob.steps,
      samplerName: currentJob.samplerName || 'res_multistep',
      seed: currentJob.seed,
      turbo8Step: currentJob.turbo8Step === true,
      featureCacheSafe: currentJob.featureCacheSafe,
      featureCacheProfile: currentJob.featureCacheProfile || 'safe',
      easyCache: currentJob.easyCache === true,
      spargeAttention: currentJob.spargeAttention !== false,
      spargeProfile: currentJob.spargeProfile || 'balanced',
      fusedModulation: currentJob.fusedModulation === true,
      vaeTileBatch: currentJob.vaeTileBatch === true,
      h3StandardCublasInt8: currentJob.h3StandardCublasInt8 === true,
      h3StandardAdaGemmInt8: currentJob.h3StandardAdaGemmInt8 === true,
      fastH3Gb10VsaKernel: currentJob.fastH3Gb10VsaKernel === true,
      fastH3CublasInt8: currentJob.fastH3CublasInt8 === true,
      fastH3AdaGemmInt8: currentJob.fastH3AdaGemmInt8 === true,
      fastH3FusedModulation: currentJob.fastH3FusedModulation === true,
      fastH3VaeTileBatch: currentJob.fastH3VaeTileBatch === true,
      fastH3VaeTileBatchSize: currentJob.fastH3VaeTileBatchSize,
      taeH3Preview: currentJob.taeH3Preview === true,
      inputMode: currentJob.inputMode || 'text',
      firstFrame: currentJob.firstFrame,
      lastFrame: currentJob.lastFrame,
      referenceImages: currentJob.referenceImages || [],
      referenceVideos: currentJob.referenceVideos || [],
      referenceAudios: currentJob.referenceAudios || [],
      referenceImageSize: currentJob.referenceImageSize || 'match',
      lyrics: currentJob.lyrics || '',
      musicTiledDecode: currentJob.musicTiledDecode !== false,
    });
  }, [currentJob, generate]);

  const stop = useCallback(async () => {
    if (!currentJob || TERMINAL_STATES.has(currentJob.state) || currentJob.state === 'cancelling' || isStopping) return undefined;
    setIsStopping(true);
    setStopError(undefined);
    try {
      const stopped = await api.stopJob(currentJob.id);
      if (TERMINAL_STATES.has(stopped.state)) closeEvents.current?.();
      setCurrentJob(stopped);
      return stopped;
    } catch (error) {
      setStopError(error instanceof Error ? error.message : '停止任务时出现问题，请稍后重试。');
      return undefined;
    } finally {
      setIsStopping(false);
    }
  }, [api, currentJob, isStopping]);

  const startUpscale = useCallback(async (
    sourceJobId: string,
    method: UpscaleMethod,
    target: UpscaleTarget,
  ) => {
    setUpscaleError(undefined);
    try {
      closeUpscaleEvents.current?.();
      const snapshot = await api.startUpscale(sourceJobId, method, target);
      activeUpscaleId.current = snapshot.id;
      activeUpscaleSourceJobId.current = sourceJobId;
      applyUpscaleUpdate(sourceJobId, snapshot, snapshot.id);
      setIsUpscaling(!isTerminalUpscale(snapshot.state));
      if (!isTerminalUpscale(snapshot.state)) {
        closeUpscaleEvents.current = api.openUpscaleEvents(snapshot.id, (event) => {
          applyUpscaleUpdate(sourceJobId, event, snapshot.id);
        });
      }
      return snapshot;
    } catch (error) {
      setUpscaleError(error instanceof Error ? error.message : '启动视频增强时出现问题，请稍后重试。');
      return undefined;
    }
  }, [api, applyUpscaleUpdate]);

  const startHistoryUpscale = useCallback(async (
    job: GenerationJob,
    method: UpscaleMethod,
    target: UpscaleTarget,
  ) => {
    if (!job.media) {
      setUpscaleError('历史记录中没有可增强的原始视频。');
      return undefined;
    }
    const source: HistoricalUpscaleInput = {
      sourceJobId: job.id,
      source: { ...job.media, type: 'output' },
      width: job.width,
      height: job.height,
    };
    setUpscaleError(undefined);
    try {
      closeUpscaleEvents.current?.();
      const snapshot = await api.startUpscale(source, method, target);
      activeUpscaleId.current = snapshot.id;
      activeUpscaleSourceJobId.current = job.id;
      applyUpscaleUpdate(job.id, snapshot, snapshot.id);
      setIsUpscaling(!isTerminalUpscale(snapshot.state));
      if (!isTerminalUpscale(snapshot.state)) {
        closeUpscaleEvents.current = api.openUpscaleEvents(snapshot.id, (event) => {
          applyUpscaleUpdate(job.id, event, snapshot.id);
        });
      }
      return snapshot;
    } catch (error) {
      setUpscaleError(error instanceof Error ? error.message : '启动历史视频增强时出现问题，请稍后重试。');
      return undefined;
    }
  }, [api, applyUpscaleUpdate]);

  const stopUpscale = useCallback(async () => {
    const id = activeUpscaleId.current;
    const sourceJobId = activeUpscaleSourceJobId.current;
    const sourceJob = currentJob?.id === sourceJobId
      ? currentJob
      : history.find((job) => job.id === sourceJobId);
    if (!id || !sourceJobId || !sourceJob || isTerminalUpscale(sourceJob.enhancements?.find((item) => item.id === id)?.state)) return undefined;
    setUpscaleError(undefined);
    try {
      const snapshot = await api.stopUpscale(id);
      applyUpscaleUpdate(snapshot.sourceJobId || sourceJobId, snapshot, id);
      if (!isTerminalUpscale(snapshot.state)) setIsUpscaling(true);
      return snapshot;
    } catch (error) {
      setUpscaleError(error instanceof Error ? error.message : '停止超分任务时出现问题，请稍后重试。');
      return undefined;
    }
  }, [api, applyUpscaleUpdate, currentJob, history]);

  const removeHistory = useCallback((id: string) => {
    setHistory((existing) => {
      const next = existing.filter((item) => item.id !== id);
      persistHistory(next);
      return next;
    });
  }, []);

  return {
    connection,
    currentJob,
    history,
    generate,
    retry,
    stop,
    isStopping,
    stopError,
    startUpscale,
    startHistoryUpscale,
    stopUpscale,
    isUpscaling,
    upscaleError,
    removeHistory,
  };
}
