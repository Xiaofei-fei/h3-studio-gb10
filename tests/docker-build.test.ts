import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GB10 Docker build resilience', () => {
  it('keeps the npm download cache and retries transient registry failures', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('--mount=type=cache,id=h3-studio-npm-cache,target=/root/.npm');
    expect(dockerfile).toContain('npm ci --prefer-offline --fetch-retries=5');
  });

  it('can repack verified local build artifacts onto the existing GB10 runtime image', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile.release'), 'utf8');

    expect(dockerfile).toContain('FROM h3-studio:gb10');
    expect(dockerfile).toContain('COPY --chown=node:node dist /app/dist');
    expect(dockerfile).toContain('COPY --chown=node:node server-dist /app/server-dist');
  });

  it('builds FlashVSR on the cached GB10 CUDA image and keeps its worker private to GB10', () => {
    const workerDockerfile = readFileSync(resolve(process.cwd(), 'flashvsr_worker/Dockerfile'), 'utf8');
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.gb10.yml'), 'utf8');

    expect(workerDockerfile).toContain('ARG COMFYUI_RUNTIME_IMAGE=comfyui-gb10:v2');
    expect(workerDockerfile).toContain('FROM ${COMFYUI_RUNTIME_IMAGE}');
    expect(workerDockerfile).toContain('CMD ["/flashvsr-venv/bin/python", "-m", "uvicorn", "flashvsr_worker.app:app", "--host", "0.0.0.0"');
    expect(workerDockerfile).toContain('USER root\n\nCOPY flashvsr-sources');
    expect(workerDockerfile).toContain('cf910c61a60733e610e9c6e8b607f80c3a6c202b');
    expect(workerDockerfile).toContain('49d6c39e4dc0303442cda3bb758b3925d4399c49');
    expect(workerDockerfile).toContain('a75b4ac483166189a45290783cb0a18af5ff0ea5');
    expect(workerDockerfile).not.toContain('pip install');
    expect(workerDockerfile).toContain('COPY flashvsr-sources/FlashVSR.tar.gz');
    expect(workerDockerfile).toContain('COPY flashvsr-sources/Block-Sparse-Attention.tar.gz');
    expect(workerDockerfile).toContain('COPY flashvsr-sources/CUTLASS.tar.gz');
    expect(workerDockerfile).toContain('tar -xzf');
    expect(workerDockerfile).not.toContain('git clone');
    expect(compose).toContain('flashvsr-worker:');
    expect(compose).toContain('/comfy-output');
    expect(compose).toContain('/models/FlashVSR:ro');
    expect(compose).toContain('${H3_STUDIO_GB10_DIR:?set H3_STUDIO_GB10_DIR}/flashvsr-venv:/flashvsr-venv:ro');
    expect(compose).not.toContain('/home/lenovo/yuxf8/');
    expect(compose).toContain('network_mode: host');
    expect(compose).not.toContain('ports:');
  });

  it('runs deterministic RealESRGAN as a separate low-memory loopback sidecar', () => {
    const workerDockerfile = readFileSync(resolve(process.cwd(), 'realesrgan_worker/Dockerfile'), 'utf8');
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.gb10.yml'), 'utf8');

    expect(workerDockerfile).toContain('ARG COMFYUI_RUNTIME_IMAGE=comfyui-gb10:v2');
    expect(workerDockerfile).toContain('FROM ${COMFYUI_RUNTIME_IMAGE}');
    expect(workerDockerfile).toContain('CMD ["/worker-venv/bin/python", "-m", "uvicorn", "realesrgan_worker.app:app", "--host", "0.0.0.0"');
    expect(workerDockerfile).not.toContain('pip install');
    expect(compose).toContain('realesrgan-worker:');
    expect(compose).toContain('DETERMINISTIC_UPSCALE_WORKER_URL: http://127.0.0.1:8191');
    expect(compose).toContain('/models/RealESRGAN:ro');
    expect(compose).toContain('${H3_STUDIO_GB10_DIR:?set H3_STUDIO_GB10_DIR}/flashvsr-venv:/worker-venv:ro');
    expect(compose).toContain('mem_limit: 6g');
    expect(compose).toContain('network_mode: host');
    expect(compose).not.toContain('ports:');
  });
});
