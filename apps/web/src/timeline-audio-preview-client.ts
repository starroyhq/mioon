import {
  AUDIO_PREVIEW_LIMITS, AUDIO_PREVIEW_PROFILE, audioPreviewPlanInputSchema,
  audioPreviewPlanSchema, audioPreviewPlanDigestMaterial, isAudioPreviewPlan,
  type AudioPreviewPlan, type AudioPreviewPlanInput, type AudioPreviewSourceDescriptor,
} from '@mioon/contracts/timeline-audio-preview';

export const AUDIO_PREVIEW_PCM_ENDPOINT = '/api/timeline-audio-preview/pcm';
/** A transferred BYOB view and its conservative copy fit the 2 MiB reserve. */
export const AUDIO_PREVIEW_MAX_CHUNK_BYTES = 1024 * 1024;
export const AUDIO_PREVIEW_PCM_HEADERS = Object.freeze({
  profile: 'X-Mioon-Audio-Profile', planHash: 'X-Mioon-Audio-Plan-Hash',
  sourceHash: 'X-Mioon-Audio-Source-Hash', clipId: 'X-Mioon-Audio-Clip-Id',
  sampleFrames: 'X-Mioon-Audio-Sample-Frames',
});
export interface AudioPreviewReadOptions { signal: AbortSignal; expectedWorkspaceOrigin?: string }
export interface AudioPreviewAllocation {
  retainedAudioBufferBytes: number;
  largestInFlightSourceBytes: number;
  transportChunkBytes: number;
  /** Application-owned conservative payload plus acquisition/transport copies, not process RSS. */
  conservativeBytes: number;
}
export interface PreparedAudioPreview {
  plan: AudioPreviewPlan;
  buffers: Map<string, AudioBuffer>;
  allocation: AudioPreviewAllocation;
}
export interface AudioPreviewPrepareOptions extends AudioPreviewReadOptions {
  context: Pick<BaseAudioContext, 'sampleRate' | 'createBuffer'>;
  onProgress?: (prepared: number, total: number) => void;
  onAllocation?: (allocation: AudioPreviewAllocation) => void;
  /** Separate from a prompt timeout/cancel result: resolves only after the
   * original work and its response cancellation have actually settled. */
  onResourceSettlement?: (settlement: Promise<void>) => void;
}
export interface AudioPreviewClientOptions {
  readPlan: (input: AudioPreviewPlanInput, options: AudioPreviewReadOptions) => Promise<unknown>;
  fetcher?: typeof fetch;
  /** Tests can shorten this deadline; callers cannot expand the 120 second budget. */
  timeoutMs?: number;
  now?: () => number;
}
export class TimelineAudioPreviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TimelineAudioPreviewError'; this.code = code; }
}
function fail(code: string, message: string): never { throw new TimelineAudioPreviewError(code, message); }
function protocol(): never { return fail('AUDIO_PREVIEW_PROTOCOL', '声音试听响应不完整或身份不匹配，请重新准备。'); }
function cleanupUnconfirmed(): never { return fail('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED', '无法确认声音资源已释放。'); }
function aborted(): never { return fail('AUDIO_PREVIEW_CANCELLED', '本次声音准备已取消。'); }
function timedOut(): never { return fail('AUDIO_PREVIEW_TIMEOUT', '声音准备超过 120 秒预算，请重新准备或选择其他区间。'); }

function freezePlan(plan: AudioPreviewPlan): AudioPreviewPlan {
  for (const source of plan.sources) {
    for (const segment of source.decodeSegments) Object.freeze(segment);
    Object.freeze(source.decodeSegments); Object.freeze(source);
  }
  for (const voice of plan.voices) Object.freeze(voice);
  Object.freeze(plan.sources); Object.freeze(plan.voices); Object.freeze(plan.range); Object.freeze(plan.memory); Object.freeze(plan.work);
  return Object.freeze(plan);
}
function verifyHeaders(response: Response, plan: AudioPreviewPlan, source: AudioPreviewSourceDescriptor): void {
  const header = (key: string) => response.headers.get(key);
  if (response.status === 401) fail('UNAUTHORIZED', '会话已过期，请重新登录后准备声音。');
  if (!response.ok) fail('AUDIO_PREVIEW_SOURCE_FAILED', '完整声音区间未能准备，未保留部分音轨。');
  if (response.status !== 200 || header('Content-Type') !== 'application/octet-stream' ||
      header('Content-Length') !== String(source.pcmBytes) || header('Cache-Control') !== 'no-store' ||
      (header('Content-Encoding') !== null && header('Content-Encoding') !== 'identity') ||
      header(AUDIO_PREVIEW_PCM_HEADERS.profile) !== AUDIO_PREVIEW_PROFILE ||
      header(AUDIO_PREVIEW_PCM_HEADERS.planHash) !== plan.planHash ||
      header(AUDIO_PREVIEW_PCM_HEADERS.sourceHash) !== source.sourceHash ||
      header(AUDIO_PREVIEW_PCM_HEADERS.clipId) !== source.clipId ||
      header(AUDIO_PREVIEW_PCM_HEADERS.sampleFrames) !== String(source.sampleFrames)) protocol();
}


async function readSourceFailure(response: Response, signal: AbortSignal, checkCurrent: () => void): Promise<never> {
  if (response.status === 401) fail('UNAUTHORIZED', '会话已过期，请重新登录后准备声音。');
  let code = 'AUDIO_PREVIEW_SOURCE_FAILED';
  if (response.body && response.headers.get('Content-Type') === 'application/json; charset=utf-8') {
    const reader = response.body.getReader(), bytes = new Uint8Array(4096); let count = 0;
    let cancellation: Promise<void> | null = null;
    const cancel = (): Promise<void> => {
      cancellation ??= reader.cancel().catch(() => cleanupUnconfirmed());
      void cancellation.catch(() => {}); return cancellation;
    };
    const onAbort = (): void => { void cancel(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        checkCurrent(); const part = await reader.read(); checkCurrent();
        if (part.done) break;
        if (part.value.byteLength > bytes.length - count) protocol();
        bytes.set(part.value, count); count += part.value.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
      if (value !== null && typeof value === 'object' && 'ok' in value && value.ok === false && 'error' in value &&
          value.error !== null && typeof value.error === 'object' && 'code' in value.error && typeof value.error.code === 'string' &&
          /^(?:AUDIO_PREVIEW_[A-Z_]{1,80}|RESTORE_OPERATION_UNAVAILABLE)$/u.test(value.error.code)) code = value.error.code;
    } catch { checkCurrent(); }
    finally { signal.removeEventListener('abort', onAbort); try { await cancel(); } finally { reader.releaseLock(); } }
  }
  fail(code, '完整声音区间未能准备，未保留部分音轨。');
}

/** The only retained payload is the stereo AudioBuffer itself. A fixed 8-byte
 * scratch cell assembles at most seven trailing bytes between network chunks.
 * No full-body arrayBuffer(), concatenation, native-endian casts or decodeAudioData. */
export async function readTimelineAudioPreviewPcm(
  response: Response, plan: AudioPreviewPlan, source: AudioPreviewSourceDescriptor,
  context: AudioPreviewPrepareOptions['context'], signal: AbortSignal,
  checkCurrent: () => void, onChunk: (bytes: number) => void = () => {},
): Promise<AudioBuffer> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader | null = null;
  let succeeded = false;
  let cancellation: Promise<void> | null = null;
  const cancel = (): Promise<void> => {
    if (!cancellation) {
      try { cancellation = Promise.resolve(reader ? reader.cancel() : response.body?.cancel()).catch(() => cleanupUnconfirmed()); }
      catch { cancellation = Promise.reject(new TimelineAudioPreviewError('AUDIO_PREVIEW_CLEANUP_UNCONFIRMED', '无法确认声音资源已释放。')); }
      void cancellation.catch(() => {});
    }
    return cancellation;
  };
  const onAbort = (): void => { void cancel(); };
  try {
    checkCurrent();
    if (!response.ok) await readSourceFailure(response, signal, checkCurrent);
    verifyHeaders(response, plan, source);
    if (!response.body || context.sampleRate !== AUDIO_PREVIEW_LIMITS.sampleRate) protocol();
    const buffer = context.createBuffer(2, source.sampleFrames, AUDIO_PREVIEW_LIMITS.sampleRate);
    if (buffer.length !== source.sampleFrames || buffer.numberOfChannels !== 2 || buffer.sampleRate !== 48000) protocol();
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    if (left.length !== source.sampleFrames || right.length !== source.sampleFrames) protocol();
    let byobReader: ReadableStreamBYOBReader | null = null;
    let defaultReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try { byobReader = response.body.getReader({ mode: 'byob' }); reader = byobReader; }
    catch (error) {
      // Non-byte streams do not implement BYOB. Their delivered allocations
      // still obey the same cap; a locked or otherwise failed stream is not retried.
      if (!(error instanceof TypeError) || response.body.locked) throw error;
      defaultReader = response.body.getReader(); reader = defaultReader;
    }
    let transportView = byobReader ? new Uint8Array(AUDIO_PREVIEW_MAX_CHUNK_BYTES) : null;
    signal.addEventListener('abort', onAbort, { once: true });
    const carry = new Uint8Array(8), carryView = new DataView(carry.buffer);
    let carryCount = 0, received = 0, written = 0;
    const write = (view: DataView, offset: number): void => {
      const l = view.getFloat32(offset, true), r = view.getFloat32(offset + 4, true);
      if (!Number.isFinite(l) || !Number.isFinite(r) || written >= source.sampleFrames) protocol();
      left[written] = l; right[written] = r; written++;
    };
    for (;;) {
      checkCurrent();
      let part: ReadableStreamReadResult<Uint8Array>;
      if (byobReader && transportView) part = await byobReader.read(transportView);
      else if (defaultReader) part = await defaultReader.read();
      else protocol();
      checkCurrent();
      if (part.done) {
        if (part.value !== undefined && (!(part.value instanceof Uint8Array) || !(part.value.buffer instanceof ArrayBuffer) ||
            part.value.byteLength !== 0 || part.value.buffer.byteLength > AUDIO_PREVIEW_MAX_CHUNK_BYTES)) protocol();
        break;
      }
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array) || !(chunk.buffer instanceof ArrayBuffer) || chunk.byteLength === 0 || chunk.byteLength > AUDIO_PREVIEW_MAX_CHUNK_BYTES ||
          chunk.buffer.byteLength > AUDIO_PREVIEW_MAX_CHUNK_BYTES || chunk.byteLength > source.pcmBytes - received) protocol();
      onChunk(chunk.byteLength); received += chunk.byteLength;
      let offset = 0;
      if (carryCount) {
        const needed = Math.min(8 - carryCount, chunk.byteLength);
        carry.set(chunk.subarray(0, needed), carryCount); carryCount += needed; offset += needed;
        if (carryCount === 8) { write(carryView, 0); carryCount = 0; }
      }
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (; offset + 8 <= chunk.byteLength; offset += 8) write(view, offset);
      if (offset < chunk.byteLength) { carryCount = chunk.byteLength - offset; carry.set(chunk.subarray(offset), 0); }
      // read() detaches the submitted view. Reuse only the returned backing
      // allocation after its samples are consumed, never the detached input.
      if (byobReader) transportView = new Uint8Array(chunk.buffer);
    }
    if (received !== source.pcmBytes || written !== source.sampleFrames || carryCount !== 0) protocol();
    checkCurrent(); succeeded = true; return buffer;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { if (!succeeded) await cancel(); } finally { reader?.releaseLock(); }
  }
}

/** Serial, all-or-nothing, explicitly invoked preparation. The fixed endpoint
 * receives only identities; there is no file path, URL, codec or filter input. */
export function createTimelineAudioPreviewClient({ readPlan, fetcher = (...args) => fetch(...args), timeoutMs = AUDIO_PREVIEW_LIMITS.prepareTimeoutMs, now = Date.now }: AudioPreviewClientOptions) {
  return {
    async prepare(rawInput: AudioPreviewPlanInput, options: AudioPreviewPrepareOptions): Promise<PreparedAudioPreview> {
      const parsed = audioPreviewPlanInputSchema.safeParse(rawInput);
      if (!parsed.success) protocol();
      const input = parsed.data;
      if (options.context.sampleRate !== 48000) fail('AUDIO_PREVIEW_SAMPLE_RATE', '当前音频设备无法建立 48 kHz 试听时钟。');
      const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(AUDIO_PREVIEW_LIMITS.prepareTimeoutMs, timeoutMs)) : AUDIO_PREVIEW_LIMITS.prepareTimeoutMs;
      const expiresAt = now() + deadlineMs, abort = new AbortController(), readerAbort = new AbortController();
      const buffers = new Map<string, AudioBuffer>();
      let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
      let rejectInterrupted: ((error: Error) => void) | undefined;
      const interrupt = (): void => {
        // Ask the owned reader to cancel before aborting Fetch, so its exact
        // cancellation acknowledgment is not replaced by a generic AbortError.
        readerAbort.abort(); abort.abort();
        rejectInterrupted?.(new TimelineAudioPreviewError(expired ? 'AUDIO_PREVIEW_TIMEOUT' : 'AUDIO_PREVIEW_CANCELLED', expired ? '声音准备超过 120 秒预算，请重新准备。' : '本次声音准备已取消。'));
      };
      const check = (): void => {
        if (expired || now() >= expiresAt) timedOut();
        if (options.signal.aborted || abort.signal.aborted) aborted();
      };
      options.signal.addEventListener('abort', interrupt, { once: true });
      const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
      timer = setTimeout(() => { expired = true; interrupt(); }, deadlineMs);
      const work = async (): Promise<PreparedAudioPreview> => {
        check();
        const raw = await readPlan(input, { signal: abort.signal, ...(options.expectedWorkspaceOrigin ? { expectedWorkspaceOrigin: options.expectedWorkspaceOrigin } : {}) });
        check();
        if (!isAudioPreviewPlan(raw, input)) protocol();
        const checked = audioPreviewPlanSchema.safeParse(raw);
        if (!checked.success) protocol();
        const plan = checked.data;
        if (plan.projectId !== input.projectId || plan.timelineId !== input.timelineId || plan.timelineRevision !== input.expectedRevision || plan.range.startFrame !== input.startFrame) protocol();
        if (!globalThis.crypto?.subtle) fail('AUDIO_PREVIEW_DIGEST_UNAVAILABLE', '此环境无法验证声音区间身份。');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(audioPreviewPlanDigestMaterial(plan)));
        check();
        if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== plan.planHash) protocol();
        freezePlan(plan);
        let retainedAudioBufferBytes = 0, transportChunkBytes = 0;
        const allocation = (): AudioPreviewAllocation => ({ retainedAudioBufferBytes, largestInFlightSourceBytes: plan.memory.largestSourcePcmBytes,
          transportChunkBytes, conservativeBytes: 2 * retainedAudioBufferBytes + 2 * plan.memory.largestSourcePcmBytes + AUDIO_PREVIEW_LIMITS.transportReserveBytes });
        options.onProgress?.(0, plan.sources.length);
        for (const source of plan.sources) {
          check();
          const query = new URLSearchParams({ projectId: input.projectId, timelineId: input.timelineId, expectedRevision: String(input.expectedRevision),
            startFrame: String(input.startFrame), clipId: source.clipId, sourceHash: source.sourceHash, planHash: plan.planHash });
          const response = await fetcher(`${AUDIO_PREVIEW_PCM_ENDPOINT}?${query}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
          try { check(); } catch (error) { try { await response.body?.cancel(); } catch { cleanupUnconfirmed(); } throw error; }
          const buffer = await readTimelineAudioPreviewPcm(response, plan, source, options.context, readerAbort.signal, check,
            bytes => { transportChunkBytes = Math.max(transportChunkBytes, bytes); options.onAllocation?.({ ...allocation(), retainedAudioBufferBytes: retainedAudioBufferBytes + source.pcmBytes,
              conservativeBytes: 2 * (retainedAudioBufferBytes + source.pcmBytes) + 2 * plan.memory.largestSourcePcmBytes + AUDIO_PREVIEW_LIMITS.transportReserveBytes }); });
          check(); buffers.set(source.sourceKey, buffer); retainedAudioBufferBytes += source.pcmBytes;
          options.onAllocation?.(allocation()); options.onProgress?.(buffers.size, plan.sources.length);
        }
        check();
        if (retainedAudioBufferBytes !== plan.memory.retainedPcmBytes || allocation().conservativeBytes > AUDIO_PREVIEW_LIMITS.memoryBytes) protocol();
        return { plan, buffers, allocation: allocation() };
      };
      const workPromise = work();
      const resources = workPromise.then(() => {}, (error: unknown) => {
        if (error instanceof TimelineAudioPreviewError && error.code === 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED') throw error;
      });
      void resources.catch(() => {});
      options.onResourceSettlement?.(resources);
      try { return await Promise.race([workPromise, interrupted]); }
      catch (error) { readerAbort.abort(); abort.abort(); buffers.clear(); throw error; }
      finally { if (timer !== undefined) clearTimeout(timer); options.signal.removeEventListener('abort', interrupt); }
    },
  };
}
export type TimelineAudioPreviewClient = ReturnType<typeof createTimelineAudioPreviewClient>;
