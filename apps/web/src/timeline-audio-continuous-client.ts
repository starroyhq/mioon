import {
  CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_HEADERS as H, CONTINUOUS_AUDIO_LIMITS as L,
  CONTINUOUS_AUDIO_PROFILE, continuousAudioPlanInputSchema, continuousAudioPlanSchema,
  continuousAudioPlanDigestMaterial, continuousAudioQuery, isContinuousAudioPlan,
  type ContinuousAudioPlan, type ContinuousAudioPlanInput, type ContinuousAudioBlockInput,
} from '@mioon/contracts/timeline-audio-continuous';
import {NATIVE_AUDIO_LEASE_HEADER} from '@mioon/contracts/native-audio-preview';
import {TimelineAudioPreviewError, type AudioPreviewReadOptions} from './timeline-audio-preview-client.ts';
import type {ContinuousAudioBlock} from './timeline-audio-continuous-engine.ts';

const failure = (code: string): never => { throw new TimelineAudioPreviewError(code, code); };
const protocol = (): never => failure('AUDIO_PREVIEW_PROTOCOL');
const cancelBody = async (response: Response): Promise<void> => {
  try { await response.body?.cancel(); } catch { failure('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'); }
};
const MAX_CHUNK = 1024 * 1024;
interface ContinuousPrepareOptions extends AudioPreviewReadOptions {
  context: Pick<BaseAudioContext, 'sampleRate' | 'createBuffer'>;
  reserveNative?: (plan: ContinuousAudioPlan, sessionId: string, signal: AbortSignal) => Promise<{leaseId: string; planHash: string; sessionId: string; admittedBytes: number}>;
  onResourceSettlement?: (resources: Promise<void>) => void;
}
export interface ContinuousAudioClientSession {
  readonly plan: ContinuousAudioPlan;
  takeInitialBlock(): ContinuousAudioBlock;
  loadBlock(startFrame: number, signal: AbortSignal): Promise<ContinuousAudioBlock>;
  reset(startFrame: number, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
async function errorCode(response: Response, signal: AbortSignal): Promise<never> {
  if (response.status === 401) { await cancelBody(response); failure('UNAUTHORIZED'); }
  let code = 'AUDIO_PREVIEW_DECODE_FAILED';
  if (response.body && response.headers.get('content-type')?.startsWith('application/json')) {
    const reader = response.body.getReader(); let length = 0; const bytes = new Uint8Array(4096);
    let cancellation: Promise<void> | null = null;
    const cancel = (): Promise<void> => { cancellation ??= reader.cancel().catch(() => failure('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED')); return cancellation; };
    const abort = (): void => { void cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, {once: true});
    try {
      for (;;) {
        if (signal.aborted) failure('AUDIO_PREVIEW_CANCELLED');
        const part = await reader.read(); if (part.done) break;
        if (part.value.byteLength > bytes.length - length || part.value.buffer.byteLength > MAX_CHUNK) protocol();
        bytes.set(part.value, length); length += part.value.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
      if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' &&
        'code' in value.error && typeof value.error.code === 'string' && /^(?:AUDIO_PREVIEW_[A-Z_]{1,80}|RESTORE_OPERATION_UNAVAILABLE)$/u.test(value.error.code)) code = value.error.code;
    } finally { signal.removeEventListener('abort', abort); try { await cancel(); } finally { reader.releaseLock(); } }
  } else await cancelBody(response);
  return failure(code);
}

/** One fixed-size response is copied straight into its stereo AudioBuffer.
 * Neither response.arrayBuffer() nor a list of network chunks can grow with
 * the duration of a timeline. Partial or non-finite mixes never become blocks. */
export async function readContinuousAudioBlock(response: Response, input: ContinuousAudioBlockInput, plan: ContinuousAudioPlan,
  context: ContinuousPrepareOptions['context'], signal: AbortSignal): Promise<ContinuousAudioBlock> {
  if (!response.ok) return errorCode(response, signal);
  const endFrame = Math.min(input.blockStartFrame + L.blockFrames, plan.durationFrames);
  const samples = (endFrame - input.blockStartFrame) * 1600, bytes = samples * 8;
  const header = (key: string): string | null => response.headers.get(key);
  const valid = response.status === 200 && header('Content-Type') === 'application/octet-stream' &&
    header('Content-Length') === String(bytes) && header('Cache-Control') === 'no-store' &&
    (header('Content-Encoding') === null || header('Content-Encoding') === 'identity') &&
    header(H.profile) === CONTINUOUS_AUDIO_PROFILE && header(H.planHash) === plan.planHash &&
    header(H.session) === input.sessionId && header(H.generation) === String(input.generation) &&
    header(H.sequence) === String(input.sequence) && header(H.startFrame) === String(input.blockStartFrame) &&
    header(H.endFrame) === String(endFrame) && header(H.sampleFrames) === String(samples);
  if (!valid || !response.body || context.sampleRate !== 48000 || samples < 1) {
    await cancelBody(response); return protocol();
  }
  let reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  let byob: ReadableStreamBYOBReader | null = null;
  try { byob = response.body.getReader({mode: 'byob'}); reader = byob; }
  catch (error) { if (!(error instanceof TypeError) || response.body.locked) throw error; reader = response.body.getReader(); }
  let cancelTask: Promise<void> | null = null;
  const cancel = (): Promise<void> => { cancelTask ??= reader.cancel().catch(() => failure('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED')); return cancelTask; };
  const abort = (): void => { void cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  let success = false;
  try {
    const buffer = context.createBuffer(2, samples, 48000);
    if (buffer.length !== samples || buffer.numberOfChannels !== 2 || buffer.sampleRate !== 48000) protocol();
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    let received = 0, written = 0, carryCount = 0, view = new Uint8Array(MAX_CHUNK);
    const carry = new Uint8Array(8), carryData = new DataView(carry.buffer);
    const check = (): void => { if (signal.aborted) failure('AUDIO_PREVIEW_CANCELLED'); };
    const write = (data: DataView, offset: number): void => {
      const l = data.getFloat32(offset, true), r = data.getFloat32(offset + 4, true);
      if (!Number.isFinite(l) || !Number.isFinite(r) || written >= samples) protocol();
      left[written] = l; right[written++] = r;
    };
    for (;;) {
      check();
      const part = byob ? await byob.read(view) : await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      check(); if (part.done) {
        if (part.value !== undefined && (!(part.value instanceof Uint8Array) || part.value.byteLength !== 0 || part.value.buffer.byteLength > MAX_CHUNK)) protocol();
        break;
      }
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array) || !(chunk.buffer instanceof ArrayBuffer) || !chunk.byteLength ||
        chunk.buffer.byteLength > MAX_CHUNK || chunk.byteLength > bytes - received) protocol();
      received += chunk.byteLength; let offset = 0;
      if (carryCount) {
        const count = Math.min(8 - carryCount, chunk.byteLength); carry.set(chunk.subarray(0, count), carryCount);
        carryCount += count; offset = count;
        if (carryCount === 8) { write(carryData, 0); carryCount = 0; }
      }
      const data = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (; offset + 8 <= chunk.byteLength; offset += 8) write(data, offset);
      if (offset < chunk.byteLength) { carryCount = chunk.byteLength - offset; carry.set(chunk.subarray(offset), 0); }
      if (byob) view = new Uint8Array(chunk.buffer as ArrayBuffer);
    }
    if (received !== bytes || written !== samples || carryCount) protocol();
    success = true; return {startFrame: input.blockStartFrame, endFrame, buffer};
  } finally {
    signal.removeEventListener('abort', abort);
    try { if (!success || cancelTask) await cancel(); } finally { reader.releaseLock(); }
  }
}

export function createContinuousAudioPreviewClient(options: {
  readPlan: (input: ContinuousAudioPlanInput, options: AudioPreviewReadOptions) => Promise<unknown>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}) {
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {async prepare(raw: ContinuousAudioPlanInput, invocation: ContinuousPrepareOptions): Promise<ContinuousAudioClientSession> {
    const input = continuousAudioPlanInputSchema.parse(raw), lifetime = new AbortController(), sessionId = crypto.randomUUID();
    let expired = false;
    const check = (): void => { if (expired) failure('AUDIO_PREVIEW_TIMEOUT'); if (invocation.signal.aborted || lifetime.signal.aborted) failure('AUDIO_PREVIEW_CANCELLED'); };
    let plan: ContinuousAudioPlan, leaseId: string | undefined, generation = 1, sequence = 0;
    let last: ContinuousAudioBlockInput | null = null, active: Promise<unknown> = Promise.resolve(), disposal: Promise<void> | null = null, loading = false;
    let cleanupFailure: unknown;
    const timeout = Math.min(L.prepareTimeoutMs, Math.max(1, options.timeoutMs ?? L.prepareTimeoutMs));
    let rejectInterrupted!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const abort = (): void => { lifetime.abort(); rejectInterrupted(new TimelineAudioPreviewError(expired ? 'AUDIO_PREVIEW_TIMEOUT' : 'AUDIO_PREVIEW_CANCELLED', 'Audio preparation interrupted')); };
    invocation.signal.addEventListener('abort', abort, {once: true});
    const preparationTimer = setTimeout(() => { expired = true; abort(); }, timeout);
    const loadBlock = (startFrame: number, signal: AbortSignal): Promise<ContinuousAudioBlock> => {
      if (loading) return Promise.reject(new TimelineAudioPreviewError('AUDIO_PREVIEW_BUSY', 'AUDIO_PREVIEW_BUSY'));
      loading = true;
      const work = (async () => {
        check();
        if (sequence >= L.requests || generation > L.generations) failure('AUDIO_PREVIEW_BUDGET');
        if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= plan.durationFrames) protocol();
        const request = {...input, planHash: plan.planHash, sessionId, generation, sequence: ++sequence, blockStartFrame: startFrame}; last = request;
        const timed = new AbortController(), timer = setTimeout(() => timed.abort(), timeout);
        const network = new AbortController(), reader = new AbortController();
        // Ask the body reader to cancel while it still owns a live stream.
        // Fetch aborting it first can replace the exact cancellation proof
        // with an ordinary AbortError and falsely block future playback.
        const interrupt = (): void => { reader.abort(); network.abort(); };
        const signals = [signal, lifetime.signal, invocation.signal, timed.signal];
        for (const source of signals) source.addEventListener('abort', interrupt, {once: true});
        if (signals.some(source => source.aborted)) interrupt();
        try {
          const response = await fetcher(`${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(request)}`, {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: network.signal,
            ...(leaseId ? {headers: {[NATIVE_AUDIO_LEASE_HEADER]: leaseId}} : {}),
          });
          if (network.signal.aborted) { await cancelBody(response); failure(timed.signal.aborted ? 'AUDIO_PREVIEW_TIMEOUT' : 'AUDIO_PREVIEW_CANCELLED'); }
          const block = await readContinuousAudioBlock(response, request, plan, invocation.context, reader.signal);
          check(); return block;
        } catch (error) {
          if (error instanceof TimelineAudioPreviewError && error.code === 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED') throw error;
          if (timed.signal.aborted) failure('AUDIO_PREVIEW_TIMEOUT');
          if (network.signal.aborted) {
            // The server may have consumed this block even if its reply was
            // cancelled locally. Reopen from a new cursor generation rather
            // than guessing whether the old nextFrame advanced.
            if (!lifetime.signal.aborted && !invocation.signal.aborted) generation++;
            failure('AUDIO_PREVIEW_CANCELLED');
          }
          throw error;
        } finally { clearTimeout(timer); for (const source of signals) source.removeEventListener('abort', interrupt); }
      })();
      const tracked = work.finally(() => { loading = false; });
      // Store only a resource proof, not a fulfilled PCM result. Once the
      // engine consumes a block, no client promise retains that AudioBuffer.
      active = tracked.then(() => {}, error => {
        if (error instanceof TimelineAudioPreviewError && error.code === 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED') cleanupFailure ??= error;
      });
      return tracked;
    };
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      lifetime.abort(); invocation.signal.removeEventListener('abort', abort);
      disposal = (async () => {
        await active.catch(() => {});
        // Native main owns backend retirement as part of the lease's exact
        // three-party barrier. Web callers explicitly retire the same session.
        if (!last || leaseId) { if (cleanupFailure) throw cleanupFailure; return; }
        const timed = new AbortController(), timer = setTimeout(() => timed.abort(), timeout);
        try {
          const response = await fetcher(`${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(last)}`, {
            method: 'DELETE', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: timed.signal,
          });
          if (!response.ok) { await cancelBody(response); failure('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'); }
          await cancelBody(response);
          if (cleanupFailure) throw cleanupFailure;
        } catch { failure('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'); } finally { clearTimeout(timer); }
      })();
      void disposal.catch(() => {}); return disposal;
    };
    const preparation = (async () => {
      check();
      const rawPlan = await options.readPlan(input, {signal: lifetime.signal, ...(invocation.expectedWorkspaceOrigin ? {expectedWorkspaceOrigin: invocation.expectedWorkspaceOrigin} : {})});
      check(); if (!isContinuousAudioPlan(rawPlan, input)) protocol(); plan = Object.freeze(continuousAudioPlanSchema.parse(rawPlan));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(continuousAudioPlanDigestMaterial(plan)));
      check(); if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== plan.planHash) protocol();
      if (invocation.reserveNative) {
        const lease = await invocation.reserveNative(plan, sessionId, lifetime.signal); check();
        if (lease.planHash !== plan.planHash || lease.sessionId !== sessionId || lease.admittedBytes !== L.memoryBytes) protocol();
        leaseId = lease.leaseId;
      }
      let initialBlock: ContinuousAudioBlock | null = await loadBlock(input.startFrame, invocation.signal); check();
      return {plan, takeInitialBlock(): ContinuousAudioBlock { const block = initialBlock; initialBlock = null; if (!block) return protocol(); return block; }, loadBlock, dispose, async reset(startFrame: number, signal: AbortSignal): Promise<void> {
        check(); if (signal.aborted) failure('AUDIO_PREVIEW_CANCELLED');
        if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= plan.durationFrames || generation >= L.generations) failure('AUDIO_PREVIEW_BUDGET');
        generation++;
      }};
    })();
    const resources = preparation.then(() => {}, async () => { await dispose(); }).finally(() => { clearTimeout(preparationTimer); });
    void resources.catch(() => {}); invocation.onResourceSettlement?.(resources);
    return Promise.race([preparation, interrupted]);
  }};
}
