import {createHash} from 'node:crypto';
import {COMFY_IMAGE_PROFILE_ID, COMFY_IMAGE_VERSION, comfyCheckpointSchema, comfyImageExecutionSchema, comfyImageGraphSchema} from '../../../contracts/src/comfy-images.ts';
import {COMFY_NETWORK_LIMITS, assertComfyUuid, comfyError} from './profile.ts';

// Fixed built-in inputs: https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/nodes.py
// The official /prompt route accepts prompt_id but does NOT deduplicate it.
// Core must journal a single dispatch before request.end and never repeat it.
// Canonical object ordering is independent of JSON key insertion order. Reject
// non-JSON/prototype-bearing values instead of hashing a lossy serialization.
export function canonicalComfyJson(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 16) throw comfyError('COMFY_INVALID_REQUEST');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw comfyError('COMFY_INVALID_REQUEST');
      return item.map(child => visit(child, depth + 1));
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw comfyError('COMFY_INVALID_REQUEST');
    const result = Object.create(null);
    for (const key of Object.keys(item).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw comfyError('COMFY_INVALID_REQUEST');
      result[key] = visit(item[key], depth + 1);
    }
    return result;
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > COMFY_NETWORK_LIMITS.maxGraphBytes) throw comfyError('COMFY_INVALID_REQUEST');
  return text;
}
export function hashComfyWorkflow(graph) { return createHash('sha256').update(canonicalComfyJson(graph)).digest('hex'); }
export function comfyFilenamePrefix(outputNonce) { return `mioon_${assertComfyUuid(outputNonce)}`; }

/** All identities and seed are supplied by core before review. This function
 * does no randomness, optimization, network, model selection or installation. */
export function buildComfyWorkflow({prompt, checkpoint, seed, outputNonce} = {}) {
  if (typeof prompt !== 'string' || !prompt.length || prompt.length > 2000 || !comfyCheckpointSchema.safeParse(checkpoint).success || !Number.isSafeInteger(seed) || seed < 0) throw comfyError('COMFY_INVALID_REQUEST');
  const filenamePrefix = comfyFilenamePrefix(outputNonce);
  const graph = {
    '1': {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: checkpoint}},
    '2': {class_type: 'EmptyLatentImage', inputs: {width: 512, height: 512, batch_size: 1}},
    '3': {class_type: 'CLIPTextEncode', inputs: {text: prompt, clip: ['1', 1]}},
    '4': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['1', 1]}},
    '5': {class_type: 'KSampler', inputs: {seed, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['2', 0]}},
    '6': {class_type: 'VAEDecode', inputs: {samples: ['5', 0], vae: ['1', 2]}},
    '7': {class_type: 'SaveImage', inputs: {images: ['6', 0], filename_prefix: filenamePrefix}},
  };
  if (!comfyImageGraphSchema.safeParse(graph).success) throw comfyError('COMFY_INVALID_REQUEST');
  canonicalComfyJson(graph);
  return graph;
}
export function validateComfyExecution(execution, {prompt, checkpoint} = {}) {
  if (!comfyImageExecutionSchema.safeParse(execution).success) throw comfyError('COMFY_INVALID_REQUEST');
  assertComfyUuid(execution.promptId); assertComfyUuid(execution.clientId); assertComfyUuid(execution.outputNonce);
  const graph = execution.graph;
  const expected = buildComfyWorkflow({prompt: prompt ?? graph?.['3']?.inputs?.text, checkpoint: checkpoint ?? graph?.['1']?.inputs?.ckpt_name, seed: execution.seed, outputNonce: execution.outputNonce});
  if (canonicalComfyJson(graph) !== canonicalComfyJson(expected) || hashComfyWorkflow(graph) !== execution.graphHash || execution.filenamePrefix !== comfyFilenamePrefix(execution.outputNonce) || execution.workflowId !== COMFY_IMAGE_PROFILE_ID || execution.workflowVersion !== 1 || execution.comfyVersion !== COMFY_IMAGE_VERSION) throw comfyError('COMFY_INVALID_REQUEST');
  return execution;
}
export function comfyCorrelationMarker(execution) {
  return {workflowId: execution.workflowId, workflowVersion: execution.workflowVersion, comfyVersion: execution.comfyVersion, graphHash: execution.graphHash, outputNonce: execution.outputNonce};
}
export function buildComfySubmission(execution) {
  validateComfyExecution(execution);
  return {prompt: execution.graph, prompt_id: execution.promptId, client_id: execution.clientId, extra_data: {mioon: comfyCorrelationMarker(execution)}};
}
