import {createHash} from 'node:crypto';
import {COMFY_IMAGE_PROFILE_ID, COMFY_IMAGE_VERSION, comfyCheckpointSchema, comfyImageExecutionSchema, comfyImageGraphSchema} from '../../../contracts/src/comfy-images.ts';
import {COMFY_NETWORK_LIMITS, assertComfyUuid, comfyError} from './profile.ts';

export type ComfyExecution = ReturnType<typeof comfyImageExecutionSchema.parse>;
export type ComfyGraph = ComfyExecution['graph'];
export interface ComfyCorrelation {workflowId: string; workflowVersion: 1; comfyVersion: string; graphHash: string; outputNonce: string}
export interface ComfySubmission {prompt: ComfyGraph; prompt_id: string; client_id: string; extra_data: {mioon: ComfyCorrelation}}
// Fixed built-in inputs: https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/nodes.py
// The official /prompt route accepts prompt_id but does NOT deduplicate it.
// Core must journal a single dispatch before request.end and never repeat it.
// Canonical object ordering is independent of JSON key insertion order. Reject
// non-JSON/prototype-bearing values instead of hashing a lossy serialization.
export function canonicalComfyJson(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw comfyError('COMFY_INVALID_REQUEST');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (Array.isArray(item)) {
      const items: readonly unknown[] = item;
      const keys = Object.keys(items);
      if (keys.length !== items.length || keys.some((key, index) => key !== String(index))) throw comfyError('COMFY_INVALID_REQUEST');
      return items.map(child => visit(child, depth + 1));
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw comfyError('COMFY_INVALID_REQUEST');
    const source = item as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw comfyError('COMFY_INVALID_REQUEST');
      result[key] = visit(source[key], depth + 1);
    }
    return result;
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > COMFY_NETWORK_LIMITS.maxGraphBytes) throw comfyError('COMFY_INVALID_REQUEST');
  return text;
}
export function hashComfyWorkflow(graph: unknown): string { return createHash('sha256').update(canonicalComfyJson(graph)).digest('hex'); }
export function comfyFilenamePrefix(outputNonce: unknown): string { return `mioon_${assertComfyUuid(outputNonce)}`; }

/** All identities and seed are supplied by core before review. This function
 * does no randomness, optimization, network, model selection or installation. */
export function buildComfyWorkflow({prompt, checkpoint, seed, outputNonce}: {prompt?: unknown; checkpoint?: unknown; seed?: unknown; outputNonce?: unknown} = {}): ComfyGraph {
  if (typeof prompt !== 'string' || !prompt.length || prompt.length > 2000 || !comfyCheckpointSchema.safeParse(checkpoint).success || !Number.isSafeInteger(seed) || (seed as number) < 0) throw comfyError('COMFY_INVALID_REQUEST');
  const filenamePrefix = comfyFilenamePrefix(outputNonce);
  const graph = {
    '1': {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: checkpoint}},
    '2': {class_type: 'EmptyLatentImage', inputs: {width: 512, height: 512, batch_size: 1}},
    '3': {class_type: 'CLIPTextEncode', inputs: {text: prompt, clip: ['1', 1]}},
    '4': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['1', 1]}},
    '5': {class_type: 'KSampler', inputs: {seed: seed as number, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['2', 0]}},
    '6': {class_type: 'VAEDecode', inputs: {samples: ['5', 0], vae: ['1', 2]}},
    '7': {class_type: 'SaveImage', inputs: {images: ['6', 0], filename_prefix: filenamePrefix}},
  };
  if (!comfyImageGraphSchema.safeParse(graph).success) throw comfyError('COMFY_INVALID_REQUEST');
  canonicalComfyJson(graph);
  return graph as ComfyGraph;
}
export function validateComfyExecution(execution: unknown, {prompt, checkpoint}: {prompt?: unknown; checkpoint?: unknown} = {}): ComfyExecution {
  const parsed = comfyImageExecutionSchema.safeParse(execution);
  if (!parsed.success) throw comfyError('COMFY_INVALID_REQUEST');
  const exec = parsed.data;
  assertComfyUuid(exec.promptId); assertComfyUuid(exec.clientId); assertComfyUuid(exec.outputNonce);
  const graph = exec.graph;
  const expected = buildComfyWorkflow({prompt: prompt ?? graph['3'].inputs.text, checkpoint: checkpoint ?? graph['1'].inputs.ckpt_name, seed: exec.seed, outputNonce: exec.outputNonce});
  if (canonicalComfyJson(graph) !== canonicalComfyJson(expected) || hashComfyWorkflow(graph) !== exec.graphHash || exec.filenamePrefix !== comfyFilenamePrefix(exec.outputNonce) || exec.workflowId !== COMFY_IMAGE_PROFILE_ID || exec.workflowVersion !== 1 || exec.comfyVersion !== COMFY_IMAGE_VERSION) throw comfyError('COMFY_INVALID_REQUEST');
  return execution as ComfyExecution;
}
export function comfyCorrelationMarker(execution: ComfyExecution): ComfyCorrelation {
  return {workflowId: execution.workflowId, workflowVersion: execution.workflowVersion, comfyVersion: execution.comfyVersion, graphHash: execution.graphHash, outputNonce: execution.outputNonce};
}
export function buildComfySubmission(execution: unknown): ComfySubmission {
  const validated = validateComfyExecution(execution);
  return {prompt: validated.graph, prompt_id: validated.promptId, client_id: validated.clientId, extra_data: {mioon: comfyCorrelationMarker(validated)}};
}
