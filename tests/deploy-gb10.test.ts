import { describe, expect, it } from 'vitest';
import { createGb10DeploymentPlan, parsePortableEnvironment } from '../scripts/deploy-gb10.mjs';

describe('GB10 deployment plan', () => {
  it('syncs source and verified artifacts without secrets, then verifies the rebuilt FastH3 service', () => {
    const plan = createGb10DeploymentPlan({
      sourceDir: '/workspace/h3-studio',
      host: 'gb10',
      targetDir: '/home/lenovo/yuxf8/h3-studio',
      previewNodeVersion: '1',
    });

    expect(plan.rsyncArgs).toEqual([
      '-a',
      '--exclude', 'node_modules',
      '--exclude', '.git',
      '--exclude', '.secrets',
      '--exclude', '.env',
      '--exclude', '.env.*',
      '--exclude', '.cloudflared.env',
      '--exclude', '.playwright-cli',
      '--exclude', '.pytest_cache',
      '--exclude', '__pycache__',
      '--exclude', 'models',
      '--exclude', 'model-staging',
      '--exclude', 'outputs',
      '--exclude', 'input',
      '--exclude', 'flashvsr-venv',
      '--exclude', 'flashvsr-wheelhouse',
      '--exclude', 'flashvsr-sources',
      '--exclude', 'flashvsr-state',
      '--exclude', 'flashvsr-work',
      '--exclude', 'realesrgan-models',
      '--exclude', 'realesrgan-state',
      '--exclude', 'realesrgan-work',
      '--exclude', 'cloudflare-worker/wrangler.jsonc',
      '--exclude', 'cloudflare-worker/.wrangler',
      '/workspace/h3-studio/',
      'gb10:/home/lenovo/yuxf8/h3-studio/',
    ]);
    expect(plan.sshArgs).toEqual([
      'gb10',
      expect.stringContaining('docker compose -f docker-compose.gb10.yml up -d --build h3-studio'),
    ]);
    expect(plan.sshArgs[1]).toContain('"fastH3Vsa"');
    expect(plan.sshArgs[1]).toContain('H3StudioTAEH3PreviewLoader');
    expect(plan.sshArgs[1]).toContain('"taeH3Preview"');
    expect(plan.sshArgs[1]).toContain('docker compose -f docker-compose.gb10.yml build flashvsr-worker');
    expect(plan.sshArgs[1]).toContain('python -m flashvsr_worker.install_model');
    expect(plan.sshArgs[1]).toContain('flashvsr_venv_source=');
    expect(plan.sshArgs[1]).toContain('flashvsr_venv_dir=');
    expect(plan.sshArgs[1]).toContain('flashvsr_sources_dir=');
    expect(plan.sshArgs[1]).toContain('flashvsr_wheelhouse_dir=');
    expect(plan.sshArgs[1]).toContain('codeload.github.com/OpenImagingLab/FlashVSR/tar.gz');
    expect(plan.sshArgs[1]).toContain('codeload.github.com/NVIDIA/cutlass/tar.gz/a75b4ac483166189a45290783cb0a18af5ff0ea5');
    expect(plan.sshArgs[1]).toContain('FlashVSR 官方源码下载失败');
    expect(plan.sshArgs[1]).toContain('flashvsr_worker.install_runtime');
    expect(plan.sshArgs[1]).toContain('PIP_FIND_LINKS=/wheelhouse');
    expect(plan.sshArgs[1]).toContain('PIP_NO_INDEX=1');
    expect(plan.sshArgs[1]).toContain('BLOCK_SPARSE_ATTN_FORCE_BUILD=TRUE');
    expect(plan.sshArgs[1]).toContain('BLOCK_SPARSE_ATTN_CUDA_ARCHS=120');
    expect(plan.sshArgs[1]).toContain('h3-studio-flashvsr-setup');
    expect(plan.sshArgs[1]).toContain(':/wheelhouse:ro');
    expect(plan.sshArgs[1]).toContain('FlashVSR 私有虚拟环境准备失败');
    expect(plan.sshArgs[1]).toContain('python -m flashvsr_worker.gate');
    expect(plan.sshArgs[1]).toContain('--memory 56g --memory-swap 56g');
    expect(plan.sshArgs[1]).toContain('flashvsr_gate_status');
    expect(plan.sshArgs[1]).toContain('resources: FlashVSR compatibility gate exited 137');
    expect(plan.sshArgs[1]).toContain('flashvsr-worker');
    const flashVsrStage = plan.sshArgs[1].split('# FLASHVSR_DEPLOYMENT_STAGE\n')[1] || '';
    expect(flashVsrStage).not.toContain('docker restart yuxf8_h3');
    expect(flashVsrStage).toContain('docker rm -f h3-studio-flashvsr-setup');
    expect(plan.sshArgs[1]).toContain('"flashVsr"');
    expect(plan.sshArgs[1]).toContain('# DETERMINISTIC_UPSCALE_DEPLOYMENT_STAGE');
    expect(plan.sshArgs[1]).toContain('realesrgan_model_source=');
    expect(plan.sshArgs[1]).toContain('RealESRGAN_x2plus.pth');
    expect(plan.sshArgs[1]).toContain('49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb');
    expect(plan.sshArgs[1]).toContain('docker compose -f docker-compose.gb10.yml build realesrgan-worker');
    expect(plan.sshArgs[1]).toContain('docker compose -f docker-compose.gb10.yml up -d --no-build realesrgan-worker');
    expect(plan.sshArgs[1]).toContain('"deterministicUpscale"');
    const deterministicStage = plan.sshArgs[1].split('# DETERMINISTIC_UPSCALE_DEPLOYMENT_STAGE\n')[1] || '';
    expect(deterministicStage).not.toContain('docker restart yuxf8_h3');
    expect(plan.fallbackSshArgs).toEqual([
      'gb10',
      expect.stringContaining('docker build --file Dockerfile.release --tag h3-studio:gb10 .'),
    ]);
    expect(plan.fallbackSshArgs[1]).toContain('docker compose -f docker-compose.gb10.yml up -d --no-build h3-studio');
    expect(plan.fallbackSshArgs[1]).toContain('H3StudioTAEH3PreviewLoader');
  });

  it('rejects an unsafe remote target before it can be interpolated into SSH', () => {
    expect(() => createGb10DeploymentPlan({
      sourceDir: '/workspace/h3-studio',
      host: 'gb10; not-a-host',
      targetDir: '/home/lenovo/yuxf8/h3-studio',
    })).toThrow('H3_STUDIO_GB10_HOST');
  });

  it('parses portable environment entries without treating comments as values', () => {
    expect(parsePortableEnvironment([
      '# GB10 runtime settings',
      'H3_STUDIO_GB10_DIR=/srv/h3-studio',
      'export H3_STUDIO_COMFY_CONTAINER=comfyui',
      '',
    ].join('\n'))).toEqual({
      H3_STUDIO_GB10_DIR: '/srv/h3-studio',
      H3_STUDIO_COMFY_CONTAINER: 'comfyui',
    });
  });

  it('uses explicit portable ComfyUI paths and container names in the remote deployment plan', () => {
    const plan = createGb10DeploymentPlan({
      sourceDir: '/workspace/h3-studio',
      host: 'lab-gb10',
      targetDir: '/srv/h3-studio',
      comfyOutputDir: '/srv/comfy/output',
      comfyVenvDir: '/srv/comfy/venv',
      comfyContainer: 'comfyui',
      comfyCustomNodesDir: '/comfy/custom_nodes',
      flashVsrModelDir: '/srv/models/FlashVSR',
      realesrganModelSource: '/srv/staging/RealESRGAN_x2plus.pth',
      previewNodeVersion: '1',
    });

    expect(plan.rsyncArgs).toContain('lab-gb10:/srv/h3-studio/');
    expect(plan.sshArgs[1]).toContain('/srv/comfy/output');
    expect(plan.sshArgs[1]).toContain('/srv/comfy/venv');
    expect(plan.sshArgs[1]).toContain('comfyui');
    expect(plan.sshArgs[1]).toContain('/comfy/custom_nodes');
    expect(plan.sshArgs[1]).toContain('/srv/models/FlashVSR');
    expect(plan.sshArgs[1]).toContain('/srv/staging/RealESRGAN_x2plus.pth');
  });
});
