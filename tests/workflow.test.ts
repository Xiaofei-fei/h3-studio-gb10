import { describe, expect, it } from 'vitest';
import { buildH3Workflow, calculateFrameLength, normalizeGenerationRequest } from '../server/workflow';

describe('H3 workflow inputs', () => {
  it('snaps a five-second video to the H3 17k + 5 frame grid', () => {
    expect(calculateFrameLength(5)).toBe(124);
  });

  it('accepts an approved 720P request', () => {
    expect(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 1280,
      height: 720,
      seconds: 5,
      steps: 20,
      seed: 42,
    })).toMatchObject({
      width: 1280,
      height: 720,
      seconds: 5,
      steps: 20,
      seed: 42,
    });
  });

  it('normalizes FastH3 VSA requests to its fixed four-step Euler contract', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      samplerName: 'res_multistep',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3CublasInt8: false,
      fastH3VaeTileBatch: false,
      turbo8Step: true,
      featureCacheSafe: true,
      easyCache: false,
      spargeAttention: true,
      fusedModulation: true,
    });

    expect(request).toMatchObject({
      service: 'fasth3_vsa',
      fastH3CublasInt8: false,
      fastH3VaeTileBatch: false,
      steps: 4,
      samplerName: 'euler',
      turbo8Step: false,
      featureCacheSafe: false,
      easyCache: false,
      spargeAttention: false,
      fusedModulation: false,
    });
  });

  it('uses the direct FastH3 cuBLAS opt-in even when a legacy profile is submitted', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      samplerName: 'res_multistep',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3Profile: 'baseline',
      fastH3CublasInt8: true,
      fastH3VaeTileBatch: false,
    });

    expect(request.fastH3CublasInt8).toBe(true);
    expect(request).not.toHaveProperty('fastH3Profile');
  });

  it('accepts a fifteen-second request and keeps it on the H3 frame grid', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A slow orbit around a mountain cabin at dusk',
      width: 832,
      height: 480,
      seconds: 15,
      steps: 20,
      seed: 42,
    });

    expect(request.seconds).toBe(15);
    expect(calculateFrameLength(request.seconds)).toBe(362);
  });

  it('rejects an output outside of the approved presentation presets', () => {
    expect(() => normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 1920,
      height: 1080,
      seconds: 5,
      steps: 20,
      seed: 42,
    })).toThrow('480P 或 720P');
  });

  it('maps prompt, output controls, and acceleration flags into API workflow inputs', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
    }));

    expect(workflow['7'].inputs).toMatchObject({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      length: 124,
    });
    expect(workflow['3'].inputs.steps).toBe(20);
    expect(workflow['2'].inputs).toMatchObject({
      routing_mode: 'topk',
      routing_value: 0.15,
      block_size: '64',
      enabled: true,
    });
  });

  it('routes the Standard GB10 cuBLAS opt-in through one shared model link', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      h3StandardCublasInt8: true,
    }));

    expect(workflow['20']).toMatchObject({
      class_type: 'MiniMaxH3GB10CublasInt8',
      inputs: {
        model: ['2', 0],
        enabled: true,
        scope: 'qkv_out_mlp',
        force_full_load: false,
        allow_standard: true,
      },
    });
    expect(workflow['3'].inputs.model).toEqual(['20', 0]);
    expect(workflow['10'].inputs.model).toEqual(['20', 0]);
  });

  it('routes AdaGEMM opt-ins through the trial node for Standard and FastH3', () => {
    const standardWorkflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      h3StandardAdaGemmInt8: true,
    }));
    const fastWorkflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 4,
      samplerName: 'euler',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3AdaGemmInt8: true,
    }));

    expect(standardWorkflow['20']).toMatchObject({
      class_type: 'MiniMaxH3GB10AdaGemmInt8',
      inputs: { model: ['2', 0], enabled: true, scope: 'qkv_out_mlp' },
    });
    expect(standardWorkflow['3'].inputs.model).toEqual(['20', 0]);
    expect(fastWorkflow['21']).toMatchObject({
      class_type: 'MiniMaxH3GB10AdaGemmInt8',
      inputs: { model: ['2', 0], enabled: true, scope: 'qkv_out_mlp' },
    });
    expect(fastWorkflow['10'].inputs.model).toEqual(['21', 0]);
  });

  it('rejects AdaGEMM and cuBLAS INT8 when both are selected for one service', () => {
    expect(() => normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      h3StandardCublasInt8: true,
      h3StandardAdaGemmInt8: true,
    })).toThrow('不能同时启用');
    expect(() => normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 4,
      samplerName: 'euler',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3CublasInt8: true,
      fastH3AdaGemmInt8: true,
    })).toThrow('不能同时启用');
  });

  it('builds the fixed FastH3 VSA graph with its resident gate', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 4,
      samplerName: 'euler',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3CublasInt8: false,
      fastH3VaeTileBatch: false,
    }));

    expect(workflow['17']).toMatchObject({
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['1', 0],
        lora_name: 'fasth3_vsa_4-steps-v5.safetensors',
        strength_model: 1,
      },
    });
    expect(workflow['2']).toMatchObject({
      class_type: 'H3VSA',
      inputs: {
        model: ['17', 0],
        gate_file: 'fasth3_vsa_gate.safetensors',
        topk_ratio: 0.1,
        min_tokens: 4096,
        gate_residency: 'resident',
      },
    });
    expect(workflow['21']).toBeUndefined();
    expect(workflow['3'].inputs).toMatchObject({ model: ['2', 0], steps: 4 });
    expect(workflow['9'].inputs).toMatchObject({ sampler_name: 'euler' });
    expect(workflow['12']).toMatchObject({ class_type: 'VAEDecode' });
  });

  it('adds the GB10 cuBLAS and batch-four VAE paths when their direct switches are enabled', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 4,
      samplerName: 'euler',
      seed: 42,
      service: 'fasth3_vsa',
      fastH3CublasInt8: true,
      fastH3VaeTileBatch: true,
    }));

    expect(workflow['21']).toMatchObject({
      class_type: 'MiniMaxH3GB10CublasInt8',
      inputs: {
        model: ['2', 0],
        enabled: true,
        scope: 'qkv_out_mlp',
        force_full_load: false,
        allow_standard: false,
      },
    });
    expect(workflow['3'].inputs.model).toEqual(['21', 0]);
    expect(workflow['10'].inputs.model).toEqual(['21', 0]);
    expect(workflow['12']).toMatchObject({
      class_type: 'MiniMaxH3VAEDecodeBatched',
      inputs: { samples: ['11', 0], vae: ['5', 0], tile_batch_size: 4 },
    });
  });

  it('uses the batch-2 video decoder only when VAE Tile Batch is enabled', () => {
    const baseRequest = {
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
    };

    const defaultWorkflow = buildH3Workflow(normalizeGenerationRequest(baseRequest));
    const batchedWorkflow = buildH3Workflow(normalizeGenerationRequest({ ...baseRequest, vaeTileBatch: true }));

    expect(defaultWorkflow['12']).toMatchObject({
      class_type: 'VAEDecode',
      inputs: { samples: ['11', 0], vae: ['5', 0] },
    });
    expect(batchedWorkflow['12']).toMatchObject({
      class_type: 'MiniMaxH3VAEDecodeBatched',
      inputs: { samples: ['11', 0], vae: ['5', 0], tile_batch_size: 2 },
    });
  });

  it('locks Turbo LoRA requests to the matching eight-step model patch', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      turbo8Step: true,
    });
    const workflow = buildH3Workflow(request);

    expect(request).toMatchObject({ turbo8Step: true, steps: 8 });
    expect(workflow['17']).toMatchObject({
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['1', 0],
        lora_name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
        strength_model: 1,
      },
    });
    expect(workflow['2'].inputs.model).toEqual(['17', 0]);
    expect(workflow['3'].inputs.steps).toBe(8);
  });

  it('inserts the calibrated Feature Cache Safe node before Sparge when requested', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      featureCacheSafe: true,
    }));

    expect(workflow['16']).toMatchObject({
      class_type: 'ApplyMiniMaxH3FirstBlockCache',
      inputs: {
        model: ['1', 0],
        mode: 'H3 Safe — 0.08 / max 2',
        threshold: 0.08,
        start_percent: 0.1,
        end_percent: 0.95,
        max_consecutive_hits: 2,
        temporal_guard: false,
      },
    });
    expect(workflow['2'].inputs.model).toEqual(['16', 0]);
  });

  it('selects the installed H3 Fast cache preset when Fast is requested', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      featureCacheSafe: true,
      featureCacheProfile: 'fast',
    }));

    expect(workflow['16']).toMatchObject({
      class_type: 'ApplyMiniMaxH3FirstBlockCache',
      inputs: {
        mode: 'H3 Fast — 0.10 / max 2',
        threshold: 0.1,
        max_consecutive_hits: 2,
      },
    });
  });

  it('routes the native EasyCache model patch through fused modulation and Sparge when requested', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      easyCache: true,
      fusedModulation: true,
    });
    const workflow = buildH3Workflow(request);

    expect(request).toMatchObject({ easyCache: true, featureCacheSafe: false });
    expect(workflow['16']).toBeUndefined();
    expect(workflow['19']).toMatchObject({
      class_type: 'EasyCache',
      inputs: {
        model: ['1', 0],
        reuse_threshold: 0.2,
        start_percent: 0.15,
        end_percent: 0.95,
        verbose: false,
      },
    });
    expect(workflow['18'].inputs.model).toEqual(['19', 0]);
    expect(workflow['2'].inputs.model).toEqual(['18', 0]);
  });

  it('rejects requests that enable EasyCache and FirstBlockCache together', () => {
    expect(() => normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      featureCacheSafe: true,
      easyCache: true,
    })).toThrow('不能同时开启');
  });

  it('bypasses the Sparge model patch when sparse attention is disabled', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      spargeAttention: false,
    }));

    expect(workflow['2']).toBeUndefined();
    expect(workflow['3'].inputs.model).toEqual(['1', 0]);
    expect(workflow['10'].inputs.model).toEqual(['1', 0]);
  });

  it('keeps the direct Sage and Sparge path when Feature Cache Safe is not requested', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
    }));

    expect(workflow['16']).toBeUndefined();
    expect(workflow['2'].inputs.model).toEqual(['1', 0]);
  });

  it('maps the six-step preview recipe to Fast Sparge, cache, and fused modulation nodes', () => {
    const request = normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee with gentle steam',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      samplerName: 'res_multistep',
      spargeAttention: true,
      spargeProfile: 'fast',
      featureCacheSafe: true,
      featureCacheProfile: 'fast',
      fusedModulation: true,
    });
    const workflow = buildH3Workflow(request);

    expect(request).toMatchObject({
      steps: 6,
      samplerName: 'res_multistep',
      spargeProfile: 'fast',
      fusedModulation: true,
    });
    expect(workflow['16'].inputs).toMatchObject({ mode: 'H3 Fast — 0.10 / max 2' });
    expect(workflow['18']).toMatchObject({
      class_type: 'MiniMaxH3FusedModulation',
      inputs: { model: ['16', 0], enabled: true },
    });
    expect(workflow['2'].inputs).toMatchObject({
      model: ['18', 0],
      routing_value: 0.1,
      video_routing_value: 0.08,
    });
    expect(workflow['3'].inputs.steps).toBe(6);
    expect(workflow['9'].inputs.sampler_name).toBe('res_multistep');
  });

  it('keeps one final attention pass dense for six-step previews', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee with gentle steam',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      spargeAttention: true,
      spargeProfile: 'fast',
    }));

    expect(workflow['2'].inputs.dense_last_steps).toBe(1);
  });

  it('maps the manual H3 Aggressive cache profile into the installed cache node', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A cinematic cup of coffee with gentle steam',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 20,
      seed: 42,
      featureCacheSafe: true,
      featureCacheProfile: 'aggressive',
    }));

    expect(workflow['16']).toMatchObject({
      class_type: 'ApplyMiniMaxH3FirstBlockCache',
      inputs: {
        mode: 'H3 Aggressive — 0.12 / max 2',
        threshold: 0.12,
        max_consecutive_hits: 2,
      },
    });
  });

  it('requires a first frame when a creator chooses the keyframe video mode', () => {
    expect(() => normalizeGenerationRequest({
      prompt: 'A close-up of coffee steam drifting upward',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      inputMode: 'keyframes',
    })).toThrow('首帧');
  });

  it('loads selected keyframes into the H3 image-to-video conditioning node', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: 'A close-up of coffee steam drifting upward',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      inputMode: 'keyframes',
      firstFrame: { filename: 'coffee-first.png', type: 'input', kind: 'image' },
      lastFrame: { filename: 'coffee-last.png', type: 'input', kind: 'image' },
    }));

    expect(workflow['7']).toMatchObject({
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        first_frame: ['30', 0],
        last_frame: ['31', 0],
      },
    });
    expect(workflow['30']).toMatchObject({
      class_type: 'LoadImage',
      inputs: { image: 'coffee-first.png' },
    });
    expect(workflow['31']).toMatchObject({
      class_type: 'LoadImage',
      inputs: { image: 'coffee-last.png' },
    });
  });

  it('uses Ref2VA and ordered multimodal reference inputs for the reference mode', () => {
    const workflow = buildH3Workflow(normalizeGenerationRequest({
      prompt: '<Picture 1> 中的咖啡杯冒出蒸汽，镜头缓慢推近。',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      inputMode: 'references',
      referenceImages: [{ filename: 'coffee-reference.png', type: 'input', kind: 'image' }],
      referenceVideos: [{ filename: 'motion-reference.mp4', type: 'input', kind: 'video' }],
      referenceAudios: [{ filename: 'room-tone.mp3', type: 'input', kind: 'audio' }],
      referenceImageSize: 'match',
    }));

    expect(workflow['1'].inputs.unet_name).toBe('minimax_h3_ref2va_pruned_int8_convrot.safetensors');
    expect(workflow['7']).toMatchObject({
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        'ref_images.ref_image_0': ['40', 0],
        'ref_videos.ref_video_0': ['42', 0],
        'ref_video_audios.ref_video_audio_0': ['42', 1],
        'ref_audios.ref_audio_0': ['43', 0],
      },
    });
    expect(workflow['40']).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'coffee-reference.png' } });
    expect(workflow['41']).toMatchObject({ class_type: 'LoadVideo', inputs: { video: 'motion-reference.mp4' } });
    expect(workflow['42']).toMatchObject({ class_type: 'GetVideoComponents', inputs: { video: ['41', 0] } });
    expect(workflow['43']).toMatchObject({ class_type: 'LoadAudio', inputs: { audio: 'room-tone.mp3' } });
  });

  it('requires at least one multimodal reference before building a Ref2VA graph', () => {
    expect(() => normalizeGenerationRequest({
      prompt: 'A cup of coffee',
      width: 832,
      height: 480,
      seconds: 5,
      steps: 6,
      seed: 42,
      inputMode: 'references',
    })).toThrow('至少添加一个');
  });

  it('builds a local MiniMax Music3 MP3 workflow with caption and lyrics', () => {
    const request = normalizeGenerationRequest({
      service: 'music3',
      prompt: 'Warm cinematic ambient music with a slow build',
      lyrics: '[verse] steam rises slowly',
      width: 832,
      height: 480,
      seconds: 10,
      steps: 6,
      seed: 42,
      musicTiledDecode: true,
    });
    const workflow = buildH3Workflow(request);

    expect(request).toMatchObject({ service: 'music3', seconds: 10, steps: 30, samplerName: 'euler' });
    expect(workflow['4']).toMatchObject({
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: { caption: 'Warm cinematic ambient music with a slow build', lyrics: '[verse] steam rises slowly' },
    });
    expect(workflow['8']).toMatchObject({ class_type: 'VAEDecodeAudioTiled' });
    expect(workflow['9']).toMatchObject({ class_type: 'SaveAudioMP3' });
  });
});
