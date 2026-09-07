import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type WorkflowInput = { name: string; link?: number | null };
type WorkflowOutput = { name: string; links?: number[] | null };
type WorkflowNode = {
  id: number;
  type: string;
  inputs?: WorkflowInput[];
  outputs?: WorkflowOutput[];
  widgets_values?: unknown[];
};
type WorkflowLink = [number, number, number, number, number, string];
type Workflow = {
  version: number;
  nodes: WorkflowNode[];
  links: WorkflowLink[];
  extra?: Record<string, unknown>;
};

function workflow(name: string): Workflow {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'workflows', name), 'utf8')) as Workflow;
}

function nodeByType(workflowData: Workflow, type: string): WorkflowNode {
  const matches = workflowData.nodes.filter((node) => node.type === type);
  expect(matches, `expected one ${type} node`).toHaveLength(1);
  return matches[0]!;
}

function hasNode(workflowData: Workflow, type: string): boolean {
  return workflowData.nodes.some((node) => node.type === type);
}

function linkedTo(workflowData: Workflow, source: WorkflowNode, target: WorkflowNode, inputName: string): boolean {
  const input = target.inputs?.find((candidate) => candidate.name === inputName);
  if (input?.link == null) return false;
  return workflowData.links.some(([id, fromNode, , toNode]) => id === input.link && fromNode === source.id && toNode === target.id);
}

function expectInternallyLinkedGraph(workflowData: Workflow): void {
  const nodeById = new Map(workflowData.nodes.map((node) => [node.id, node]));
  const linkById = new Map(workflowData.links.map((link) => [link[0], link]));
  expect(linkById.size).toBe(workflowData.links.length);

  for (const node of workflowData.nodes) {
    for (const [inputIndex, input] of (node.inputs ?? []).entries()) {
      if (input.link == null) continue;
      const link = linkById.get(input.link);
      expect(link, `${node.type}.${input.name} must reference an existing link`).toBeDefined();
      expect(link?.[3]).toBe(node.id);
      expect(link?.[4]).toBe(inputIndex);
      const source = nodeById.get(link?.[1] ?? -1);
      expect(source?.outputs?.[link?.[2] ?? -1]).toBeDefined();
    }
  }
}

describe('loadable ComfyUI optimization workflows', () => {
  it('ships the Standard Turbo configuration with EasyCache and AdaGEMM as the selected mutually-exclusive paths', () => {
    const standard = workflow('h3-standard-turbo-easycache-adagemm.json');

    expect(standard.version).toBe(0.4);
    expect(standard.extra?.h3_studio_profile).toBe('standard_turbo_easycache_adagemm');
    expect(hasNode(standard, 'ApplyMiniMaxH3FirstBlockCache')).toBe(false);
    expect(hasNode(standard, 'MiniMaxH3GB10CublasInt8')).toBe(false);

    const turbo = nodeByType(standard, 'LoraLoaderModelOnly');
    const easyCache = nodeByType(standard, 'EasyCache');
    const fused = nodeByType(standard, 'MiniMaxH3FusedModulation');
    const sparge = nodeByType(standard, 'H3SpargeAttention');
    const adaGemm = nodeByType(standard, 'MiniMaxH3GB10AdaGemmInt8');
    const scheduler = nodeByType(standard, 'BasicScheduler');
    const sampler = nodeByType(standard, 'KSamplerSelect');
    const videoDecode = nodeByType(standard, 'MiniMaxH3VAEDecodeBatched');

    expect(turbo.widgets_values).toEqual(['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 1]);
    expect(easyCache.widgets_values).toEqual([0.2, 0.15, 0.95, false]);
    expect(sparge.widgets_values).toEqual(['topk', 0.15, 0.1, '64', 8192, 1, true, true, 'branch_map', 'topk_fast', 'legacy_uniform', 0.12, 0.1, 'inherit']);
    expect(adaGemm.widgets_values).toEqual([true, 'qkv_out_mlp', 'off', 'off']);
    expect(scheduler.widgets_values).toEqual(['simple', 8, 1]);
    expect(sampler.widgets_values).toEqual(['res_multistep']);
    expect(videoDecode.widgets_values).toEqual([2]);

    expect(linkedTo(standard, turbo, easyCache, 'model')).toBe(true);
    expect(linkedTo(standard, easyCache, fused, 'model')).toBe(true);
    expect(linkedTo(standard, fused, sparge, 'model')).toBe(true);
    expect(linkedTo(standard, sparge, adaGemm, 'model')).toBe(true);
    expectInternallyLinkedGraph(standard);
  });

  it('ships FastH3 with AdaGEMM, the VSA fused layout engine, and no conflicting profiler or cuBLAS node', () => {
    const fast = workflow('fasth3-vsa-adagemm-full.json');

    expect(fast.version).toBe(0.4);
    expect(fast.extra?.h3_studio_profile).toBe('fasth3_vsa_adagemm_full');
    expect(hasNode(fast, 'MiniMaxH3GB10CublasInt8')).toBe(false);
    expect(hasNode(fast, 'H3StudioFastH3Profile')).toBe(false);
    expect(hasNode(fast, 'H3SpargeAttention')).toBe(false);
    expect(hasNode(fast, 'EasyCache')).toBe(false);

    const fastLora = nodeByType(fast, 'LoraLoaderModelOnly');
    const vsa = nodeByType(fast, 'H3VSA');
    const fused = nodeByType(fast, 'MiniMaxH3FusedModulation');
    const adaGemm = nodeByType(fast, 'MiniMaxH3GB10AdaGemmInt8');
    const vsaLayout = nodeByType(fast, 'H3StudioFastH3GB10VSA');
    const scheduler = nodeByType(fast, 'BasicScheduler');
    const sampler = nodeByType(fast, 'KSamplerSelect');
    const videoDecode = nodeByType(fast, 'MiniMaxH3VAEDecodeBatched');

    expect(fastLora.widgets_values).toEqual(['fasth3_vsa_4-steps-v5.safetensors', 1]);
    expect(vsa.widgets_values).toEqual(['fasth3_vsa_gate.safetensors', 0.1, 4096, 'resident']);
    expect(adaGemm.widgets_values).toEqual([true, 'qkv_out_mlp', 'off', 'off']);
    expect(scheduler.widgets_values).toEqual(['simple', 4, 1]);
    expect(sampler.widgets_values).toEqual(['euler']);
    expect(videoDecode.widgets_values).toEqual([4]);

    expect(linkedTo(fast, fastLora, vsa, 'model')).toBe(true);
    expect(linkedTo(fast, vsa, fused, 'model')).toBe(true);
    expect(linkedTo(fast, fused, adaGemm, 'model')).toBe(true);
    expect(linkedTo(fast, adaGemm, vsaLayout, 'model')).toBe(true);
    expectInternallyLinkedGraph(fast);
  });
});
