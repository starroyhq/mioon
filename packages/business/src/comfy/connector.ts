import {COMFY_IMAGE_VERSION, comfyImageConfigurationSchema, comfyImageCheckRequestSchema, comfyImageCheckResultSchema, comfyCheckpointSchema} from '../../../contracts/src/comfy-images.ts';
import {validatePng} from '../images/png.ts';
import {COMFY_NODE_CLASSES, COMFY_SAVE_NODE_ID, comfyError, comfyLimits} from './profile.ts';
import type {ComfyNodeClass} from './profile.ts';
import {createComfyTransport, validateComfyDescriptor} from './network.ts';
import type {ComfyDescriptor, ComfyResponse, ComfyTransportOptions} from './network.ts';
import {buildComfySubmission, canonicalComfyJson, comfyCorrelationMarker, validateComfyExecution} from './workflow.ts';
import type {ComfyExecution} from './workflow.ts';

// Compatibility source, inspected 2026-10-10 (no runtime installed/executed):
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/server.py
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/comfy_execution/jobs.py
// https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/main.py
// /api/jobs/{id} includes workflow and execution_status only for history items.
// Its normalized status alone defaults to completed when status_str is absent.
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
const same = (a: unknown, b: unknown): boolean => canonicalComfyJson(a) === canonicalComfyJson(b);
function parseJson(response: ComfyResponse): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response.body));
    if (!object(value)) throw Error();
    return value;
  } catch { throw comfyError('COMFY_RESPONSE_INVALID', {dispatched: response.dispatched}); }
}
function configuration(config: unknown) {
  const result = comfyImageConfigurationSchema.safeParse(config);
  if (!result.success || !result.data.baseUrl || !result.data.model) throw comfyError('COMFY_INVALID_REQUEST');
  return result.data;
}
const expectedInputs: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  CheckpointLoaderSimple: {ckpt_name: 'CHECKPOINT'},
  EmptyLatentImage: {width: 'INT', height: 'INT', batch_size: 'INT'},
  CLIPTextEncode: {text: 'STRING', clip: 'CLIP'},
  KSampler: {model: 'MODEL', seed: 'INT', steps: 'INT', cfg: 'FLOAT', sampler_name: 'SAMPLER', scheduler: 'SCHEDULER', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT'},
  VAEDecode: {samples: 'LATENT', vae: 'VAE'}, SaveImage: {images: 'IMAGE', filename_prefix: 'STRING'},
});
const expectedOutputs: Readonly<Record<string, readonly string[]>> = Object.freeze({CheckpointLoaderSimple: ['MODEL', 'CLIP', 'VAE'], EmptyLatentImage: ['LATENT'], CLIPTextEncode: ['CONDITIONING'], KSampler: ['LATENT'], VAEDecode: ['IMAGE'], SaveImage: ['IMAGE']});
function inspectNode(payload: Record<string, unknown>, nodeClass: string): string[] | null {
  const info = payload[nodeClass];
  if (Object.keys(payload).length !== 1 || !object(info) || info.name !== nodeClass || info.python_module !== 'nodes' || info.api_node === true || info.output_node !== (nodeClass === 'SaveImage') || !same(info.output, expectedOutputs[nodeClass]) || !object(info.input) || !object(info.input.required)) throw comfyError('COMFY_DEPENDENCY_MISSING');
  const input = info.input as Record<string, unknown>, required = input.required as Record<string, unknown>, expected = expectedInputs[nodeClass];
  if (Object.keys(required).sort().join(',') !== Object.keys(expected).sort().join(',') || (input.optional && Object.keys(input.optional).length)) throw comfyError('COMFY_DEPENDENCY_MISSING');
  for (const [name, type] of Object.entries(expected)) {
    const entry = required[name];
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2) throw comfyError('COMFY_DEPENDENCY_MISSING');
    const values: readonly unknown[] = entry;
    if (type === 'CHECKPOINT') {
      const names: readonly unknown[] = Array.isArray(values[0]) ? values[0] : [];
      if (!Array.isArray(values[0]) || names.length > 256 || names.some(value => !comfyCheckpointSchema.safeParse(value).success) || new Set(names).size !== names.length) throw comfyError('COMFY_DEPENDENCY_MISSING');
    } else if (type === 'SAMPLER' || type === 'SCHEDULER') {
      const choices: readonly unknown[] = Array.isArray(values[0]) ? values[0] : [];
      if (!Array.isArray(values[0]) || choices.length > 256 || choices.some(value => typeof value !== 'string' || value.length > 128) || !choices.includes(type === 'SAMPLER' ? 'euler' : 'normal')) throw comfyError('COMFY_DEPENDENCY_MISSING');
    } else if (values[0] !== type) throw comfyError('COMFY_DEPENDENCY_MISSING');
  }
  if (nodeClass !== 'CheckpointLoaderSimple') return null;
  const checkpoints = (required.ckpt_name as readonly unknown[])[0] as string[];
  return [...checkpoints];
}
function correlateTerminal(job: Record<string, unknown>, execution: ComfyExecution): void {
  try {
    const workflow = job.workflow;
    if (!object(workflow) || !same(workflow.prompt, execution.graph)) throw Error();
    const extra = workflow.extra_data;
    if (!object(extra) || extra.client_id !== execution.clientId || !same(extra.mioon, comfyCorrelationMarker(execution))) throw Error();
    // Unknown side-channel metadata is not part of the approved submission.
    if (Object.keys(extra).some(key => !['client_id', 'create_time', 'mioon'].includes(key))) throw Error();
    if (extra.create_time !== undefined && (typeof extra.create_time !== 'number' || !Number.isSafeInteger(extra.create_time) || extra.create_time < 0)) throw Error();
  } catch { throw comfyError('COMFY_CORRELATION_FAILED'); }
}
function terminalDescriptor(job: Record<string, unknown>, execution: ComfyExecution): ComfyDescriptor {
  if (!object(job.outputs) || Object.keys(job.outputs).join(',') !== COMFY_SAVE_NODE_ID) throw comfyError('COMFY_OUTPUT_INVALID');
  const outputs = job.outputs;
  const node = outputs[COMFY_SAVE_NODE_ID];
  if (!object(node) || Object.keys(node).join(',') !== 'images' || !Array.isArray(node.images) || node.images.length !== 1 || job.outputs_count !== 1 || job.previewable_outputs_count !== 1) throw comfyError('COMFY_OUTPUT_INVALID');
  return validateComfyDescriptor((node.images as readonly unknown[])[0], execution.filenamePrefix);
}
export interface ComfyConfigurationInput {baseUrl?: unknown; model?: unknown; enabled?: unknown}
export interface ComfyConnectorOptions {networkDeps?: ComfyTransportOptions; reservedPorts?: unknown; limits?: Readonly<Record<string, unknown>>}
export interface ComfyCheckInput {config?: ComfyConfigurationInput; signal?: AbortSignal}
export interface ComfySubmitInput {execution?: unknown; config?: ComfyConfigurationInput; signal?: AbortSignal; beforeSubmit?: () => unknown}
export interface ComfyObserveInput {execution?: unknown; config?: ComfyConfigurationInput; signal?: AbortSignal}

/** No persistent state, polling, filesystem publication, arbitrary workflow,
 * installation or remote cancellation. Core owns durable request/observation
 * claims and requires an explicit successful endpoint check before review. */
export function createComfyConnector({networkDeps = {}, reservedPorts, limits: overrides}: ComfyConnectorOptions = {}) {
  const limits = comfyLimits(overrides);
  const request = createComfyTransport({...networkDeps, reservedPorts, limits});
  return Object.freeze({
    async check({config, signal}: ComfyCheckInput = {}) {
      // Discovery precedes model selection and does not enable/save a profile.
      const input = {baseUrl: config?.baseUrl, model: config?.model ?? ''};
      if (!comfyImageCheckRequestSchema.safeParse(input).success) throw comfyError('COMFY_INVALID_REQUEST');
      const baseUrl = input.baseUrl as string, model = input.model as string;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.checkTimeoutMs);
      try {
        const stats = parseJson(await request({baseUrl: input.baseUrl, operation: 'system', signal: controller.signal}));
        const system = object(stats.system) ? stats.system : null;
        if (system?.comfyui_version !== COMFY_IMAGE_VERSION) throw comfyError('COMFY_VERSION_UNSUPPORTED');
        let checkpoints: string[] = [], total = 0;
        for (const nodeClass of COMFY_NODE_CLASSES) {
          const remaining = limits.maxNodeInfoBytes - total;
          if (remaining < 1) throw comfyError('COMFY_RESPONSE_TOO_LARGE');
          const response = await request({baseUrl, operation: 'node', nodeClass, signal: controller.signal, maxBytes: remaining});
          total += response.byteLength;
          const names = inspectNode(parseJson(response), nodeClass);
          if (names) checkpoints = names;
        }
        return comfyImageCheckResultSchema.parse({ok: true, baseUrl, comfyVersion: COMFY_IMAGE_VERSION, checkpoints,
          selectedCheckpointAvailable: model !== '' && checkpoints.includes(model), nodeClasses: [...COMFY_NODE_CLASSES]});
      } catch (error) {
        throw comfyError(timedOut ? 'COMFY_TIMEOUT' : codeOf(error));
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    async submit({execution, config, signal, beforeSubmit}: ComfySubmitInput = {}) {
      const selected = configuration(config);
      if (!selected.enabled) throw comfyError('COMFY_DISPATCH_BLOCKED');
      const validated = structuredClone(validateComfyExecution(execution, {checkpoint: selected.model}));
      const response = await request({baseUrl: selected.baseUrl, operation: 'submit', body: JSON.stringify(buildComfySubmission(validated)), signal, beforeSubmit});
      const ack = parseJson(response);
      if (ack.prompt_id !== validated.promptId || !Number.isFinite(ack.number) || !object(ack.node_errors) || Object.keys(ack.node_errors).length || Object.keys(ack).sort().join(',') !== 'node_errors,number,prompt_id') throw comfyError('COMFY_RESPONSE_INVALID', {dispatched: true});
      return {state: 'submitted' as const, promptId: validated.promptId, number: ack.number as number, contentVerified: false as const};
    },
    async observe({execution, config, signal}: ComfyObserveInput = {}) {
      const selected = configuration(config);
      const validated = structuredClone(validateComfyExecution(execution, {checkpoint: selected.model}));
      const response = await request({baseUrl: selected.baseUrl, operation: 'job', promptId: validated.promptId, signal});
      const job = parseJson(response);
      if (response.status === 404) return {state: 'not_found' as const, contentVerified: false as const};
      if (job.id !== validated.promptId) throw comfyError('COMFY_CORRELATION_FAILED');
      if (job.status === 'pending' || job.status === 'in_progress') return {state: job.status === 'pending' ? 'pending' as const : 'running' as const, contentVerified: false as const};
      if (!['completed', 'failed', 'cancelled'].includes(job.status as string)) throw comfyError('COMFY_RESPONSE_INVALID');
      correlateTerminal(job, validated);
      const status = job.execution_status;
      if (!object(status) || !Array.isArray(status.messages)) throw comfyError('COMFY_CORRELATION_FAILED');
      const messages: readonly unknown[] = status.messages;
      if (job.status !== 'completed') {
        if (status.status_str !== 'error' || status.completed !== false) throw comfyError('COMFY_CORRELATION_FAILED');
        return {state: 'failed' as const, contentVerified: true as const, errorCode: job.status === 'cancelled' ? 'COMFY_REMOTE_INTERRUPTED' : 'COMFY_REMOTE_FAILED'};
      }
      if (status.status_str !== 'success' || status.completed !== true || job.execution_error != null || messages.some(entry => !Array.isArray(entry) || entry.length !== 2 || !object(entry[1]) || ['execution_error', 'execution_interrupted'].includes(entry[0] as string) || (entry[1].prompt_id !== undefined && entry[1].prompt_id !== validated.promptId))) throw comfyError('COMFY_CORRELATION_FAILED');
      const descriptor = terminalDescriptor(job, validated);
      const output = await request({baseUrl: selected.baseUrl, operation: 'view', descriptor, filenamePrefix: validated.filenamePrefix, signal});
      let metadata;
      try { metadata = await validatePng(output.body, {width: 512, height: 512, signal}); }
      catch { throw comfyError(signal?.aborted ? 'COMFY_ABORTED' : 'COMFY_OUTPUT_INVALID'); }
      if (signal?.aborted) throw comfyError('COMFY_ABORTED');
      return {state: 'completed' as const, contentVerified: true as const, candidate: {bytes: output.body, ...metadata, descriptor},
        provenance: {workflowId: validated.workflowId, workflowVersion: validated.workflowVersion, comfyVersion: validated.comfyVersion, graphHash: validated.graphHash,
          promptId: validated.promptId, clientId: validated.clientId, outputNonce: validated.outputNonce, seed: validated.seed, model: selected.model}};
    },
  });
}
