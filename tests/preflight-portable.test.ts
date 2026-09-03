import { describe, expect, it } from 'vitest';
import { runPreflight } from '../scripts/preflight-portable.mjs';

const completeEnvironment = {
  H3_STUDIO_GB10_HOST: 'gb10',
  H3_STUDIO_GB10_DIR: '/opt/h3-studio',
  H3_STUDIO_COMFY_OUTPUT_DIR: '/opt/comfyui/output',
  H3_STUDIO_COMFY_VENV_DIR: '/opt/comfyui/venv',
  H3_STUDIO_FLASHVSR_MODEL_DIR: '/opt/models/FlashVSR',
  H3_STUDIO_REALESRGAN_MODEL_SOURCE: '/opt/model-staging/RealESRGAN_x2plus.pth',
  H3_STUDIO_COMFY_CONTAINER: 'comfyui',
  H3_STUDIO_COMFY_CUSTOM_NODES_DIR: '/comfy/mnt/ComfyUI/custom_nodes',
};

describe('portable deployment preflight', () => {
  it('reports a missing portable setting without printing its value', () => {
    const result = runPreflight({
      environment: { ...completeEnvironment, H3_STUDIO_GB10_DIR: '' },
      validateCompose: false,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.join('\n')).toContain('H3_STUDIO_GB10_DIR');
    expect(result.stderr.join('\n')).not.toContain('/opt/h3-studio');
  });

  it('accepts a complete environment and records a successful Compose validation', () => {
    const result = runPreflight({
      environment: completeEnvironment,
      composeValidator: () => ({ status: 0 }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.join('\n')).toContain('Docker Compose 配置验证通过');
  });
});
