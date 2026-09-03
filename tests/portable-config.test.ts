import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const requiredEnvironment = [
  'H3_STUDIO_GB10_HOST',
  'H3_STUDIO_GB10_DIR',
  'H3_STUDIO_COMFY_OUTPUT_DIR',
  'H3_STUDIO_COMFY_VENV_DIR',
  'H3_STUDIO_FLASHVSR_MODEL_DIR',
  'H3_STUDIO_REALESRGAN_MODEL_SOURCE',
  'H3_STUDIO_COMFY_CONTAINER',
  'H3_STUDIO_COMFY_CUSTOM_NODES_DIR',
];

describe('portable GB10 configuration contract', () => {
  it('ships a safe example environment and uses its mount variables in Compose', () => {
    expect(existsSync(resolve(process.cwd(), '.env.example'))).toBe(true);
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.gb10.yml'), 'utf8');

    for (const variable of requiredEnvironment) {
      expect(example).toContain(`${variable}=`);
    }
    for (const variable of [
      'H3_STUDIO_GB10_DIR',
      'H3_STUDIO_COMFY_OUTPUT_DIR',
      'H3_STUDIO_FLASHVSR_MODEL_DIR',
    ]) {
      expect(compose).toContain(variable);
    }
    expect(example).not.toMatch(/\/home\/[A-Za-z0-9_-]+\//);
    expect(example).not.toMatch(/(?:ghp_|github_pat_|CF_API_TOKEN)/i);
  });

  it('documents only external model metadata, never model files', () => {
    const manifestPath = resolve(process.cwd(), 'config/model-manifest.yaml');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = readFileSync(manifestPath, 'utf8');

    expect(manifest).toContain('redistributable: false');
    expect(manifest).toContain('minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    expect(manifest).toContain('RealESRGAN_x2plus.pth');
  });
});
