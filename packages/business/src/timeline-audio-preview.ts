import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AUDIO_PREVIEW_LIMITS, audioPreviewPlanInputSchema, audioPreviewSourceInputSchema,
  buildAudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import type {AudioPreviewPlan, AudioPreviewPlanInput, AudioPreviewSourceDescriptor} from '@mioon/contracts/timeline-audio-preview';
import type {TimelineAudioPreviewDecoder, TimelineAudioPreviewDecodedPcm} from './timeline-audio-preview-decoder.ts';

const LIMITS = AUDIO_PREVIEW_LIMITS;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (value: unknown): string | undefined => object(value) && typeof value.code === 'string' ? value.code : undefined;
const unconfirmed = (value: unknown): boolean => object(value) && value.terminationUnconfirmed === true;
const fault = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error('Saved timeline sound audition is unavailable. Prepare the saved interval again.'), {code, status});
function unavailable(): never {throw fault('AUDIO_PREVIEW_UNAVAILABLE', 404);}
const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
/** Bound the trusted JS adapter's result before projecting or serializing it.
 * Database readers are independently bounded; this also rejects accessors and
 * non-data graphs from an incorrectly wired adapter without invoking them. */
function plainData(value: unknown, maxBytes: number): boolean {
  let remaining = maxBytes, nodes = 60000;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 32 || --remaining < 0) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') {remaining -= Buffer.byteLength(item); return remaining >= 0;}
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype || item.length > 1000 : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 1001 : 256) || array && keys.length !== item.length + 1) return false;
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) return false;
      remaining -= Buffer.byteLength(key);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item); return remaining >= 0;
  };
  try {return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes;} catch {return false;}
}

export interface TimelineAudioPreviewStore {readonly db: DatabaseSync; readonly root: string}
export interface TimelineAudioPreviewFileIdentity {
  readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
}
export interface TimelineAudioPreviewManagedAsset {readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number}
export interface TimelineAudioPreviewHashOptions {
  readonly signal: AbortSignal; readonly expected: TimelineAudioPreviewFileIdentity; readonly maxBytes: number;
  readonly onBytes: (bytes: number) => void; readonly beforeEffect: () => void;
}
/** Backend-only adapters, never caller input. readSavedTimeline performs one
 * coherent bounded read with readTimelinePreflightSnapshot/readTimelineSourceGraph
 * and validates the complete saved timeline before returning {timeline, assets}.
 * It must not ensure a timeline, repair metadata, or write any durable state. */
export interface TimelineAudioPreviewRuntime {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  readSavedTimeline(projectId: string): unknown;
  validateSource(root: string, asset: TimelineAudioPreviewManagedAsset, options: {maxBytes: number}): {file: string; info: TimelineAudioPreviewFileIdentity};
  hash(root: string, asset: TimelineAudioPreviewManagedAsset, options: TimelineAudioPreviewHashOptions): Promise<unknown>;
  decode: TimelineAudioPreviewDecoder;
  terminate(signal: AbortSignal): Promise<readonly {status: string}[]>;
  waitForClose(signal: AbortSignal): Promise<readonly {status: string}[]>;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
}
export interface TimelineAudioPreviewConsumeContext {
  readonly source: AudioPreviewSourceDescriptor;
  readonly plan: AudioPreviewPlan;
  readonly signal: AbortSignal;
  /** The fixed transport must call this immediately before headers/writes and
   * after each awaited transport boundary. A partial body is never playable. */
  readonly beforeEffect: () => void;
}
interface Current {readonly plan: AudioPreviewPlan; readonly identity: string; readonly assets: ReadonlyMap<string, TimelineAudioPreviewManagedAsset>}
interface Entry {readonly controller: AbortController; readonly signal: AbortSignal; task: Promise<unknown>}
interface Admission {active: Entry | null; stopped: boolean; shutdownFailure: unknown}
// Native database identity, not an easily cloned store wrapper. No queue/cache.
const admissions = new WeakMap<DatabaseSync, Admission>();
const sameFile = (a: TimelineAudioPreviewFileIdentity, b: TimelineAudioPreviewFileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function fileIdentity(value: unknown): value is TimelineAudioPreviewFileIdentity {
  return object(value) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function observe<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {if (settled) return; settled = true; signal.removeEventListener('abort', abort); fn();};
    const abort = (): void => finish(() => reject(fault('OPERATION_CANCELLED', 503)));
    signal.addEventListener('abort', abort, {once: true});
    task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

/** Explicit saved-revision plan plus one fixed binary source lane. The entire
 * source interval is admitted by the shared pure planner before payload I/O.
 * Ownership, metadata and exact managed bytes are rechecked before publication.
 * The permit spans hashing, exact child termination and transport consumption. */
export function createTimelineAudioPreviewServices(store: TimelineAudioPreviewStore,
  options: {runtime: TimelineAudioPreviewRuntime; signal?: AbortSignal}) {
  const {runtime, signal: ownerSignal} = options;
  let admission = admissions.get(store.db);
  if (!admission) {admission = {active: null, stopped: false, shutdownFailure: undefined}; admissions.set(store.db, admission);}
  const state = admission;
  const assertOwner = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fault('AUDIO_PREVIEW_OWNER_REQUIRED', 403);
  };
  const available = (signal?: AbortSignal): void => {
    assertOwner();
    if (state.shutdownFailure) throw state.shutdownFailure;
    if (state.stopped || ownerSignal?.aborted || signal?.aborted) throw fault('OPERATION_CANCELLED', 503);
  };
  function current(input: AudioPreviewPlanInput): Current {
    assertOwner();
    let raw: unknown;
    try {raw = runtime.readSavedTimeline(input.projectId);} catch {return unavailable();}
    assertOwner();
    if (!plainData(raw, 4 * 1024 * 1024) || !object(raw) || !object(raw.timeline) || !Array.isArray(raw.assets) || raw.assets.length > 100) unavailable();
    const timeline = raw.timeline;
    if (!Array.isArray(timeline.tracks) || timeline.tracks.length > 12 || !Array.isArray(timeline.clips) || timeline.clips.length > 100) unavailable();
    const tracks = timeline.tracks.map((track: unknown) => {
      if (!object(track)) return unavailable();
      return {id: track.id, kind: track.kind, orderIndex: track.orderIndex, hidden: track.hidden, muted: track.muted};
    });
    const clips = timeline.clips.map((clip: unknown) => {
      if (!object(clip)) return unavailable();
      // Do not silently audition a corrupt saved speed/effect the renderer rejects.
      if (['transition', 'transitions', 'effects', 'speed', 'rate', 'opacity', 'blendMode'].some(key => Object.hasOwn(clip, key))) unavailable();
      return {id: clip.id, trackId: clip.trackId, assetId: clip.assetId, startFrame: clip.startFrame,
        durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame, gain: clip.gain,
        ...(Object.hasOwn(clip, 'fadeInFrames') ? {fadeInFrames: clip.fadeInFrames} : {}),
        ...(Object.hasOwn(clip, 'fadeOutFrames') ? {fadeOutFrames: clip.fadeOutFrames} : {})};
    });
    const managed = new Map<string, TimelineAudioPreviewManagedAsset>();
    const assets = raw.assets.map((asset: unknown) => {
      if (!object(asset) || typeof asset.id !== 'string' || typeof asset.relativePath !== 'string' || asset.relativePath.length > 4096 ||
          typeof asset.sha256 !== 'string' || typeof asset.sizeBytes !== 'number' || managed.has(asset.id)) return unavailable();
      managed.set(asset.id, Object.freeze({relativePath: asset.relativePath, sha256: asset.sha256, sizeBytes: asset.sizeBytes}));
      return {id: asset.id, projectId: asset.projectId, sha256: asset.sha256, sizeBytes: asset.sizeBytes, mimeType: asset.mimeType,
        duration: asset.duration ?? null, ...(Object.hasOwn(asset, 'hasAudio') ? {hasAudio: asset.hasAudio} : {})};
    });
    const projected = {timeline: {id: timeline.id, projectId: timeline.projectId, revision: timeline.revision, fps: timeline.fps,
      durationFrames: timeline.durationFrames, tracks, clips}, assets};
    const plan = freeze(buildAudioPreviewPlan(input, projected, hashText));
    return {plan, assets: managed, identity: hashText(JSON.stringify(raw))};
  }
  const stop = (): void => {state.stopped = true; state.active?.controller.abort();};
  ownerSignal?.addEventListener('abort', stop, {once: true});
  if (ownerSignal?.aborted) stop();

  async function plan(rawInput: unknown, context: {signal?: AbortSignal} = {}): Promise<AudioPreviewPlan> {
    // This must precede even a getter or schema parse on a restored payload.
    runtime.assertOrdinaryWorkspace();
    if (!plainData(rawInput, 2048)) throw fault('VALIDATION_ERROR', 400);
    const parsed = audioPreviewPlanInputSchema.safeParse(rawInput);
    if (!parsed.success) throw fault('VALIDATION_ERROR', 400);
    available(context.signal);
    const result = current(parsed.data).plan;
    available(context.signal);
    return result;
  }

  async function consumeSource<T>(rawInput: unknown, context: {signal?: AbortSignal;
    consume: (decoded: TimelineAudioPreviewDecodedPcm, context: TimelineAudioPreviewConsumeContext) => Promise<T>}): Promise<T> {
    runtime.assertOrdinaryWorkspace();
    if (!plainData(rawInput, 4096)) throw fault('VALIDATION_ERROR', 400);
    const parsed = audioPreviewSourceInputSchema.safeParse(rawInput);
    if (!parsed.success || !context || typeof context.consume !== 'function') throw fault('VALIDATION_ERROR', 400);
    available(context.signal);
    const input = parsed.data, request = {projectId: input.projectId, timelineId: input.timelineId,
      expectedRevision: input.expectedRevision, startFrame: input.startFrame};
    const started = performance.now(), initial = current(request);
    if (initial.plan.planHash !== input.planHash) throw fault('AUDIO_PREVIEW_STALE');
    const source = initial.plan.sources.find(item => item.clipId === input.clipId && item.sourceHash === input.sourceHash) ?? unavailable();
    const asset = initial.assets.get(source.assetId) ?? unavailable();
    if (asset.sha256 !== source.sourceHash || asset.sizeBytes !== source.sourceBytes) unavailable();
    if (state.active) throw fault('AUDIO_PREVIEW_BUSY', 429);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ownerSignal, context.signal].filter((value): value is AbortSignal => value !== undefined));
    let timedOut = false, fencedFailure: unknown, expected: TimelineAudioPreviewFileIdentity | undefined, bytesHashed = 0;
    const remainingMs = (): number => Math.max(0, LIMITS.prepareTimeoutMs - (performance.now() - started));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, remainingMs());
    const entry: Entry = {controller, signal, task: Promise.resolve()};
    state.active = entry;
    const fence = (): void => {
      try {
        assertOwner();
        const latest = current(request);
        if (latest.identity !== initial.identity || latest.plan.planHash !== initial.plan.planHash) throw fault('AUDIO_PREVIEW_STALE');
        if (state.stopped || signal.aborted) throw fault(timedOut ? 'AUDIO_PREVIEW_TIMEOUT' : 'OPERATION_CANCELLED', 503);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); throw fault('AUDIO_PREVIEW_TIMEOUT', 503);}
        if (expected) {
          const actual = runtime.validateSource(store.root, asset, {maxBytes: LIMITS.sourceBytes});
          if (!fileIdentity(actual.info) || actual.info.size !== asset.sizeBytes || !sameFile(actual.info, expected)) throw fault('AUDIO_PREVIEW_STALE');
        }
      } catch (error) {fencedFailure ??= error; throw fencedFailure;}
    };
    const onBytes = (bytes: number): void => {
      fence();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytesHashed + bytes > asset.sizeBytes * 2 || bytesHashed + bytes > LIMITS.hashReadBytes)
        throw fault('AUDIO_PREVIEW_HASH_LIMIT');
      bytesHashed += bytes;
    };
    async function hash(): Promise<{file: string; info: TimelineAudioPreviewFileIdentity; sha256: string}> {
      fence();
      if (!expected) throw fault('AUDIO_PREVIEW_STALE');
      const previousBytes = bytesHashed;
      const result = await runtime.hash(store.root, asset, {signal, expected, maxBytes: LIMITS.sourceBytes, onBytes, beforeEffect: fence});
      fence();
      if (bytesHashed - previousBytes !== asset.sizeBytes || !object(result) || result.sha256 !== asset.sha256 || result.sizeBytes !== asset.sizeBytes || typeof result.file !== 'string' ||
          !fileIdentity(result.info) || !sameFile(result.info, expected)) throw fault('AUDIO_PREVIEW_STALE');
      if (runtime.validateSource(store.root, asset, {maxBytes: LIMITS.sourceBytes}).file !== result.file) throw fault('AUDIO_PREVIEW_STALE');
      return {file: result.file, info: result.info, sha256: asset.sha256};
    }
    async function prepareAndConsume(): Promise<T> {
      fence();
      const file = runtime.validateSource(store.root, asset, {maxBytes: LIMITS.sourceBytes});
      if (!fileIdentity(file.info) || file.info.size !== asset.sizeBytes) throw fault('AUDIO_PREVIEW_STALE');
      expected = Object.freeze({dev: file.info.dev, ino: file.info.ino, size: file.info.size, mtimeMs: file.info.mtimeMs, ctimeMs: file.info.ctimeMs});
      const first = await hash(); fence();
      const decoded = await runtime.decode(first.file, {sourceInFrame: source.sourceInFrame, frameCount: source.durationFrames, segments: source.decodeSegments}, {signal, beforeEffect: fence, remainingMs});
      fence();
      if (!object(decoded) || !Buffer.isBuffer(decoded.pcm) || decoded.sampleRate !== 48000 || decoded.channels !== 2 ||
          decoded.sampleFrames !== source.sampleFrames || decoded.pcm.byteLength !== source.pcmBytes ||
          !object(decoded.source) || decoded.source.sizeBytes !== source.sourceBytes ||
          typeof decoded.source.durationSeconds !== 'number' || !Number.isFinite(decoded.source.durationSeconds) ||
          decoded.source.durationSeconds <= 0 || decoded.source.durationSeconds > LIMITS.sourceSeconds ||
          source.sourceInFrame + source.durationFrames > Math.floor(decoded.source.durationSeconds * 30 + 1e-7)) throw fault('AUDIO_PREVIEW_INVALID_PCM');
      for (let offset = 0; offset < decoded.pcm.byteLength; offset += 4) {
        if (offset % (64 * 1024) === 0) fence();
        if (!Number.isFinite(decoded.pcm.readFloatLE(offset))) throw fault('AUDIO_PREVIEW_INVALID_PCM');
      }
      const second = await hash(); fence();
      if (second.file !== first.file || second.sha256 !== first.sha256 || !sameFile(second.info, first.info) || bytesHashed !== asset.sizeBytes * 2)
        throw fault('AUDIO_PREVIEW_STALE');
      // Consumer receives the same sole PCM allocation, never a join/base64 copy.
      fence();
      const consumed = await context.consume(decoded, Object.freeze({source, plan: initial.plan, signal, beforeEffect: fence}));
      fence();
      return consumed;
    }
    const work = prepareAndConsume();
    const joined = (async () => {
      try {return await work;}
      catch (error) {
        if (unconfirmed(error)) state.shutdownFailure ??= Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true});
        throw error;
      } finally {
        let closed = false;
        try {
          const results = await runtime.terminate(signal);
          if (results.some(result => result.status !== 'exited') || unconfirmed(state.shutdownFailure)) {
            const error = Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true});
            state.shutdownFailure = error;
            const actual = await runtime.waitForClose(signal);
            if (actual.some(result => result.status !== 'exited')) throw error;
            closed = true; throw error;
          }
          closed = true;
        } catch (error) {
          state.shutdownFailure = unconfirmed(error) ? Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}) : fault('AUDIO_PREVIEW_SHUTDOWN_FAILED', 503);
          throw state.shutdownFailure;
        } finally {if (closed && state.active === entry) state.active = null; clearTimeout(timer);}
      }
    })();
    entry.task = joined;
    // Retain non-cooperative hash/decode/consumer work after caller cancellation.
    entry.task.catch(error => {if (unconfirmed(error)) state.shutdownFailure ??= error;});
    try {const result = await observe(joined, signal); fence(); return result;}
    catch (error) {
      try {fence();} catch { /* Retain the first causal fence failure. */ }
      if (state.shutdownFailure) throw state.shutdownFailure;
      const cause = fencedFailure ?? error, code = codeOf(cause);
      if (timedOut) throw fault('AUDIO_PREVIEW_TIMEOUT', 503);
      // Keep public failures opaque; neither decoder stderr nor local paths leak.
      if (code?.startsWith('AUDIO_PREVIEW_') || code === 'OPERATION_CANCELLED' || code?.startsWith('WORKSPACE_') || code?.startsWith('RESTORE_')) throw fault(code, code === 'AUDIO_PREVIEW_OWNER_REQUIRED' ? 403 : 409);
      if (code?.startsWith('MANAGED_')) throw fault('AUDIO_PREVIEW_STALE');
      throw fault('AUDIO_PREVIEW_DECODE_FAILED');
    } finally {controller.abort();}
  }
  async function drain(): Promise<void> {
    stop();
    try {await runtime.boundedShutdown(Promise.allSettled(state.active ? [state.active.task] : []), 'AUDIO_PREVIEW_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (state.shutdownFailure) throw state.shutdownFailure;
  }
  return {handlers: {'timeline.audioPreview.plan': plan}, consumeSource, drain};
}
