import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('pins fresh-host defaults to the audited immutable application and runtime images', () => {
    const environment = source('.env.fresh.example');
    expect(environment).toContain('H3_STUDIO_APP_IMAGE=ghcr.io/xiaofei-fei/h3-studio-gb10/app@sha256:d58c07b412a30f154c4c9a740697ae789c3d2be2af13fe29c0120a18ab801ea5');
    expect(environment).toContain('H3_STUDIO_COMFY_IMAGE=ghcr.io/xiaofei-fei/h3-studio-gb10/comfy-runtime@sha256:7d004a5c96c250d279ab4c227ca92f3af8a4699444d4d6dfa1e01f5b2c323609');
    expect(environment).not.toContain('/app:main');
  });

  it('accepts OCI digest image references during bootstrap validation', () => {
    const bootstrap = source('scripts/bootstrap-fresh-gb10.sh');
    expect(bootstrap).toContain('^[A-Za-z0-9./:@_-]+$');
  });

  it('provides a host bootstrap that verifies Docker GPU access, extracts the compatible venv, and downloads core assets from ModelScope', () => {
    const path = 'scripts/bootstrap-fresh-gb10.sh';
    expect(existsSync(projectFile(path))).toBe(true);

    const script = source(path);
    expect(script).toContain('docker run --rm --gpus all');
    expect(script).toContain('nvidia-smi');
    expect(script).toContain('docker create');
    expect(script).toContain('docker cp');
    expect(script).toContain('--install-nvidia-container-toolkit');
    expect(script).toContain('nvidia-ctk runtime configure --runtime=docker');
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
    expect(script).toContain('--warning=no-file-changed');

    const runtimeDockerfile = source('Dockerfile.comfy-runtime');
    expect(runtimeDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/h3-comfy-runtime-entrypoint"]');
    expect(runtimeDockerfile).toContain('COPY --chmod=0755 docker/comfy-runtime-entrypoint.sh');
    expect(runtimeDockerfile).toContain("'fastapi==0.115.12'");
    expect(runtimeDockerfile).toContain("'uvicorn[standard]==0.34.2'");
    expect(script).toContain('--build-network');
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

  it('verifies a preloaded deployment through the existing bridge network without another image pull', () => {
    const script = source('scripts/verify-fresh-gb10.sh');
    expect(script).toContain('compose exec -T h3-studio node -e');
    expect(script).toContain('http://comfyui:8188');
    expect(script).not.toContain('curlimages/curl');
  });

  it('explains how a non-root administrator prepares the default writable deployment directory', () => {
    const deploymentGuide = source('docs/fresh-gb10-deployment.md');
    expect(deploymentGuide).toContain('sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/h3-studio');
  });

  it('keeps fresh-host entrypoint scripts executable after a Git clone', () => {
    for (const path of [
      'scripts/bootstrap-fresh-gb10.sh',
      'scripts/verify-fresh-gb10.sh',
      'scripts/publish-comfy-runtime-gb10.sh',
    ]) {
      const stage = execFileSync('git', ['ls-files', '--stage', '--', path], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(stage.startsWith('100755 ')).toBe(true);
    }
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
