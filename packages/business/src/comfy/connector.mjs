import {COMFY_IMAGE_VERSION, comfyImageConfigurationSchema, comfyImageCheckRequestSchema, comfyImageCheckResultSchema, comfyCheckpointSchema} from '../../../contracts/src/comfy-images.mjs';
import {validatePng} from '../images/png.mjs';
import {COMFY_NODE_CLASSES, COMFY_SAVE_NODE_ID, comfyError, comfyLimits} from './profile.mjs';
import {createComfyTransport, validateComfyDescriptor} from './network.mjs';
import {buildComfySubmission, canonicalComfyJson, comfyCorrelationMarker, validateComfyExecution} from './workflow.mjs';

// Compatibility source, inspected 2026-10-10 (no runtime installed/executed):
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/server.py
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/comfy_execution/jobs.py
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/main.py
// /api/jobs/{id} includes workflow and execution_status only for history items.
// Its normalized status alone defaults to completed when status_str is absent.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonicalComfyJson(a) === canonicalComfyJson(b);
function parseJson(response) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response.body));
    if (!object(value)) throw Error();
    return value;
  } catch { throw comfyError('COMFY_RESPONSE_INVALID', {dispatched: response.dispatched}); }
}
function configuration(config) {
  const result = comfyImageConfigurationSchema.safeParse(config);
  if (!result.success || !result.data.baseUrl || !result.data.model) throw comfyError('COMFY_INVALID_REQUEST');
  return result.data;
}
const expectedInputs = Object.freeze({
  CheckpointLoaderSimple: {ckpt_name: 'CHECKPOINT'},
  EmptyLatentImage: {width: 'INT', height: 'INT', batch_size: 'INT'},
  CLIPTextEncode: {text: 'STRING', clip: 'CLIP'},
  KSampler: {model: 'MODEL', seed: 'INT', steps: 'INT', cfg: 'FLOAT', sampler_name: 'SAMPLER', scheduler: 'SCHEDULER', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT'},
  VAEDecode: {samples: 'LATENT', vae: 'VAE'}, SaveImage: {images: 'IMAGE', filename_prefix: 'STRING'},
});
const expectedOutputs = Object.freeze({CheckpointLoaderSimple: ['MODEL', 'CLIP', 'VAE'], EmptyLatentImage: ['LATENT'], CLIPTextEncode: ['CONDITIONING'], KSampler: ['LATENT'], VAEDecode: ['IMAGE'], SaveImage: ['IMAGE']});
function inspectNode(payload, nodeClass) {
  const info = payload[nodeClass];
  if (Object.keys(payload).length !== 1 || !object(info) || info.name !== nodeClass || info.python_module !== 'nodes' || info.api_node === true || info.output_node !== (nodeClass === 'SaveImage') || !same(info.output, expectedOutputs[nodeClass]) || !object(info.input?.required)) throw comfyError('COMFY_DEPENDENCY_MISSING');
  const required = info.input.required, expected = expectedInputs[nodeClass];
  if (Object.keys(required).sort().join(',') !== Object.keys(expected).sort().join(',') || (info.input.optional && Object.keys(info.input.optional).length)) throw comfyError('COMFY_DEPENDENCY_MISSING');
  for (const [name, type] of Object.entries(expected)) {
    const entry = required[name];
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2) throw comfyError('COMFY_DEPENDENCY_MISSING');
    if (type === 'CHECKPOINT') {
      if (!Array.isArray(entry[0]) || entry[0].length > 256 || entry[0].some(value => !comfyCheckpointSchema.safeParse(value).success) || new Set(entry[0]).size !== entry[0].length) throw comfyError('COMFY_DEPENDENCY_MISSING');
    } else if (type === 'SAMPLER' || type === 'SCHEDULER') {
      if (!Array.isArray(entry[0]) || entry[0].length > 256 || entry[0].some(value => typeof value !== 'string' || value.length > 128) || !entry[0].includes(type === 'SAMPLER' ? 'euler' : 'normal')) throw comfyError('COMFY_DEPENDENCY_MISSING');
    } else if (entry[0] !== type) throw comfyError('COMFY_DEPENDENCY_MISSING');
  }
  return nodeClass === 'CheckpointLoaderSimple' ? [...required.ckpt_name[0]] : null;
}
function correlateTerminal(job, execution) {
  try {
    if (!object(job.workflow) || !same(job.workflow.prompt, execution.graph)) throw Error();
    const extra = job.workflow.extra_data;
    if (!object(extra) || extra.client_id !== execution.clientId || !same(extra.mioon, comfyCorrelationMarker(execution))) throw Error();
    // Unknown side-channel metadata is not part of the approved submission.
    if (Object.keys(extra).some(key => !['client_id', 'create_time', 'mioon'].includes(key))) throw Error();
    if (extra.create_time !== undefined && (!Number.isSafeInteger(extra.create_time) || extra.create_time < 0)) throw Error();
  } catch { throw comfyError('COMFY_CORRELATION_FAILED'); }
}
function terminalDescriptor(job, execution) {
  if (!object(job.outputs) || Object.keys(job.outputs).join(',') !== COMFY_SAVE_NODE_ID) throw comfyError('COMFY_OUTPUT_INVALID');
  const node = job.outputs[COMFY_SAVE_NODE_ID];
  if (!object(node) || Object.keys(node).join(',') !== 'images' || !Array.isArray(node.images) || node.images.length !== 1 || job.outputs_count !== 1 || job.previewable_outputs_count !== 1) throw comfyError('COMFY_OUTPUT_INVALID');
  return validateComfyDescriptor(node.images[0], execution.filenamePrefix);
}

/** No persistent state, polling, filesystem publication, arbitrary workflow,
 * installation or remote cancellation. Core owns durable request/observation
 * claims and requires an explicit successful endpoint check before review. */
export function createComfyConnector({networkDeps = {}, reservedPorts, limits: overrides} = {}) {
  const limits = comfyLimits(overrides);
  const request = createComfyTransport({...networkDeps, reservedPorts, limits});
  return Object.freeze({
    async check({config, signal} = {}) {
      // Discovery precedes model selection and does not enable/save a profile.
      const input = {baseUrl: config?.baseUrl, model: config?.model ?? ''};
      if (!comfyImageCheckRequestSchema.safeParse(input).success) throw comfyError('COMFY_INVALID_REQUEST');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.checkTimeoutMs);
      try {
        const stats = parseJson(await request({baseUrl: input.baseUrl, operation: 'system', signal: controller.signal}));
        if (stats.system?.comfyui_version !== COMFY_IMAGE_VERSION) throw comfyError('COMFY_VERSION_UNSUPPORTED');
        let checkpoints = [], total = 0;
        for (const nodeClass of COMFY_NODE_CLASSES) {
          const remaining = limits.maxNodeInfoBytes - total;
          if (remaining < 1) throw comfyError('COMFY_RESPONSE_TOO_LARGE');
          const response = await request({baseUrl: input.baseUrl, operation: 'node', nodeClass, signal: controller.signal, maxBytes: remaining});
          total += response.byteLength;
          const names = inspectNode(parseJson(response), nodeClass);
          if (names) checkpoints = names;
        }
        return comfyImageCheckResultSchema.parse({ok: true, baseUrl: input.baseUrl, comfyVersion: COMFY_IMAGE_VERSION, checkpoints,
          selectedCheckpointAvailable: input.model !== '' && checkpoints.includes(input.model), nodeClasses: [...COMFY_NODE_CLASSES]});
      } catch (error) {
        throw comfyError(timedOut ? 'COMFY_TIMEOUT' : error?.code);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    async submit({execution, config, signal, beforeSubmit} = {}) {
      config = configuration(config);
      if (!config.enabled) throw comfyError('COMFY_DISPATCH_BLOCKED');
      execution = structuredClone(validateComfyExecution(execution, {checkpoint: config.model}));
      const response = await request({baseUrl: config.baseUrl, operation: 'submit', body: JSON.stringify(buildComfySubmission(execution)), signal, beforeSubmit});
      const ack = parseJson(response);
      if (ack.prompt_id !== execution.promptId || !Number.isFinite(ack.number) || !object(ack.node_errors) || Object.keys(ack.node_errors).length || Object.keys(ack).sort().join(',') !== 'node_errors,number,prompt_id') throw comfyError('COMFY_RESPONSE_INVALID', {dispatched: true});
      return {state: 'submitted', promptId: execution.promptId, number: ack.number, contentVerified: false};
    },
    async observe({execution, config, signal} = {}) {
      config = configuration(config);
      execution = structuredClone(validateComfyExecution(execution, {checkpoint: config.model}));
      const response = await request({baseUrl: config.baseUrl, operation: 'job', promptId: execution.promptId, signal});
      const job = parseJson(response);
      if (response.status === 404) return {state: 'not_found', contentVerified: false};
      if (job.id !== execution.promptId) throw comfyError('COMFY_CORRELATION_FAILED');
      if (job.status === 'pending' || job.status === 'in_progress') return {state: job.status === 'pending' ? 'pending' : 'running', contentVerified: false};
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) throw comfyError('COMFY_RESPONSE_INVALID');
      correlateTerminal(job, execution);
      const status = job.execution_status;
      if (!object(status) || !Array.isArray(status.messages)) throw comfyError('COMFY_CORRELATION_FAILED');
      if (job.status !== 'completed') {
        if (status.status_str !== 'error' || status.completed !== false) throw comfyError('COMFY_CORRELATION_FAILED');
        return {state: 'failed', contentVerified: true, errorCode: job.status === 'cancelled' ? 'COMFY_REMOTE_INTERRUPTED' : 'COMFY_REMOTE_FAILED'};
      }
      if (status.status_str !== 'success' || status.completed !== true || job.execution_error != null || status.messages.some(entry => !Array.isArray(entry) || entry.length !== 2 || !object(entry[1]) || ['execution_error', 'execution_interrupted'].includes(entry[0]) || (entry[1].prompt_id !== undefined && entry[1].prompt_id !== execution.promptId))) throw comfyError('COMFY_CORRELATION_FAILED');
      const descriptor = terminalDescriptor(job, execution);
      const output = await request({baseUrl: config.baseUrl, operation: 'view', descriptor, filenamePrefix: execution.filenamePrefix, signal});
      let metadata;
      try { metadata = await validatePng(output.body, {width: 512, height: 512, signal}); }
      catch { throw comfyError(signal?.aborted ? 'COMFY_ABORTED' : 'COMFY_OUTPUT_INVALID'); }
      if (signal?.aborted) throw comfyError('COMFY_ABORTED');
      return {state: 'completed', contentVerified: true, candidate: {bytes: output.body, ...metadata, descriptor},
        provenance: {workflowId: execution.workflowId, workflowVersion: execution.workflowVersion, comfyVersion: execution.comfyVersion, graphHash: execution.graphHash,
          promptId: execution.promptId, clientId: execution.clientId, outputNonce: execution.outputNonce, seed: execution.seed, model: config.model}};
    },
  });
}
