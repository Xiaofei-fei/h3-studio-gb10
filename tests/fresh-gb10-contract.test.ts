import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectFile = (path: string) => resolve(process.cwd(), path);
const source = (path: string) => readFileSync(projectFile(path), 'utf8');

describe('fresh GB10 deployment contract', () => {
  it('defines an isolated core stack that starts ComfyUI and H3 Studio from published ARM64 images', () => {
    const path = 'docker-compose.fresh-gb10.yml';
    expect(existsSync(projectFile(path))).toBe(true);

    const compose = source(path);
    expect(compose).toContain('comfyui:');
    expect(compose).toContain('h3-studio:');
    expect(compose).toContain('image: ${H3_STUDIO_COMFY_IMAGE:?set H3_STUDIO_COMFY_IMAGE}');
    expect(compose).toContain('image: ${H3_STUDIO_APP_IMAGE:?set H3_STUDIO_APP_IMAGE}');
    expect(compose).toContain('gpus: all');
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain('${H3_STUDIO_MODELS_DIR:?set H3_STUDIO_MODELS_DIR}:/models/minimax-h3:ro');
    expect(compose).toContain('127.0.0.1:${H3_STUDIO_COMFY_PORT:-8188}:8188');
    expect(compose).toContain('COMFYUI_URL: http://comfyui:8188');
    expect(compose).not.toContain('network_mode: host');
  });

  it('provides a host bootstrap that verifies Docker GPU access, extracts the compatible venv, and downloads core assets from ModelScope', () => {
    const path = 'scripts/bootstrap-fresh-gb10.sh';
    expect(existsSync(projectFile(path))).toBe(true);

    const script = source(path);
    expect(script).toContain('docker run --rm --gpus all');
    expect(script).toContain('nvidia-smi');
    expect(script).toContain('docker create');
    expect(script).toContain('docker cp');
    expect(script).toContain('Comfy-Org/MiniMax-H3');
    expect(script).toContain('Comfy-Org/MiniMax-Music-3');
    expect(script).toContain('minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    expect(script).toContain('minimax_music3_dit_fp16.safetensors');
    expect(script).toContain('RealESRGAN_x2plus.pth');
    expect(script).toContain('49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb');
  });

  it('can publish a sanitized current GB10 runtime without copying model weights or secret files into GHCR', () => {
    const path = 'scripts/publish-comfy-runtime-gb10.sh';
    expect(existsSync(projectFile(path))).toBe(true);

    const script = source(path);
    expect(script).toContain('ComfyUI/models');
    expect(script).toContain('*.safetensors');
    expect(script).toContain('*.ckpt');
    expect(script).toContain('*.pth');
    expect(script).toContain('.env');
    expect(script).toContain('docker push');
    expect(script).toContain('comfy-runtime');

    const runtimeDockerfile = source('Dockerfile.comfy-runtime');
    expect(runtimeDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/h3-comfy-runtime-entrypoint"]');
    expect(runtimeDockerfile).toContain('COPY --chmod=0755 docker/comfy-runtime-entrypoint.sh');
  });

  it('publishes the application image as linux/arm64 to GHCR', () => {
    const path = '.github/workflows/publish-app-image.yml';
    expect(existsSync(projectFile(path))).toBe(true);

    const workflow = source(path);
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('docker/login-action@v3');
    expect(workflow).toContain('docker/build-push-action@v6');
    expect(workflow).toContain('platforms: linux/arm64');
    expect(workflow).toContain('ghcr.io/xiaofei-fei/h3-studio-gb10/app');
  });

  it('keeps model weights and local credentials out of every Docker build context', () => {
    const path = '.dockerignore';
    expect(existsSync(projectFile(path))).toBe(true);

    const dockerignore = source(path);
    expect(dockerignore).toContain('.env.*');
    expect(dockerignore).toContain('.secrets');
    expect(dockerignore).toContain('*.safetensors');
    expect(dockerignore).toContain('*.ckpt');
    expect(dockerignore).toContain('*.pth');
  });
});
