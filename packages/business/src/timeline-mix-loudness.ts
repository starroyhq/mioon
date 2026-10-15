import {volumeEnvelopeField, volumeEnvelopeProcessingProfile, volumeEnvelopeReadSnapshot} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {createExportLoudnessAccumulator} from './export-loudness-meter.ts';
import {TIMELINE_MIX_LOUDNESS_LIMITS as LIMITS, timelineMixLoudnessInputSchema, isTimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import type {TimelineMixLoudnessInput, TimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import {EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, exportLoudnessMeasurementSchema} from '@mioon/contracts/export-loudness';
import type {ExportLoudnessMeasurement} from '@mioon/contracts/export-loudness';
import {exportAudioObservationAdmission} from './export-audio-observation.ts';
import type {ExportAudioObservationEntry} from './export-audio-observation.ts';
import {planTimelineMixLoudnessDecode} from './timeline-mix-loudness-decoder.ts';
import type {TimelineMixLoudnessTimeline, TimelineMixLoudnessAsset, TimelineMixLoudnessDecoder} from './timeline-mix-loudness-decoder.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (value: unknown): string | undefined => object(value) && typeof value.code === 'string' ? value.code : undefined;
const unconfirmed = (value: unknown): boolean => object(value) && value.terminationUnconfirmed === true;
const fault = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error('Current saved timeline loudness preparation is unavailable. Read the saved timeline and prepare again.'), {code, status});
function unavailable(): never {throw fault('TIMELINE_MIX_LOUDNESS_UNAVAILABLE', 404);}
const publicCodes = new Set(['TIMELINE_MIX_LOUDNESS_UNAVAILABLE', 'TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED',
  'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT', 'TIMELINE_MIX_LOUDNESS_SOURCE_LIMIT', 'TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT',
  'TIMELINE_MIX_LOUDNESS_BUSY', 'TIMELINE_MIX_LOUDNESS_STALE', 'TIMELINE_MIX_LOUDNESS_TIMEOUT',
  'TIMELINE_MIX_LOUDNESS_INVALID_PCM', 'TIMELINE_MIX_LOUDNESS_BUDGET', 'TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH',
  'TIMELINE_MIX_LOUDNESS_SOURCE_BOUNDS', 'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH',
  'TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT', 'OPERATION_CANCELLED',
  'RESTORE_OPERATION_UNAVAILABLE']);
const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
/** Reject accessors, cycles and oversized data before reading or serializing an
 * adapter result. Private metadata only participates in a digest, never output. */
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

export interface TimelineMixLoudnessStore {readonly db: DatabaseSync; readonly root: string}
export interface TimelineMixLoudnessFileIdentity {
  readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
}
export interface TimelineMixLoudnessManagedAsset {readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number}
export interface TimelineMixLoudnessHashOptions {
  readonly signal: AbortSignal; readonly expected: TimelineMixLoudnessFileIdentity; readonly maxBytes: number;
  readonly onBytes: (bytes: number) => void; readonly beforeEffect: () => void;
}
/** Fixed backend adapters. The coherent bounded reader validates the whole
 * saved timeline and owned source graph, never initializes or writes a row. */
export interface TimelineMixLoudnessRuntime {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  readSavedTimeline(projectId: string): unknown;
  validateSource(root: string, asset: TimelineMixLoudnessManagedAsset, options: {maxBytes: number}): {file: string; info: TimelineMixLoudnessFileIdentity};
  hash(root: string, asset: TimelineMixLoudnessManagedAsset, options: TimelineMixLoudnessHashOptions): Promise<unknown>;
  decode: TimelineMixLoudnessDecoder;
  terminate(signal: AbortSignal): Promise<readonly {status: string}[]>;
  waitForClose(signal: AbortSignal): Promise<readonly {status: string}[]>;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
}
interface Managed extends TimelineMixLoudnessManagedAsset {readonly id: string}
interface Current {
  readonly timeline: TimelineMixLoudnessTimeline;
  readonly timelineId: string;
  readonly revision: number;
  readonly identity: string;
  readonly assets: ReadonlyMap<string, TimelineMixLoudnessAsset>;
  readonly sources: readonly Managed[];
  readonly plan: ReturnType<typeof planTimelineMixLoudnessDecode>;
}
const sameFile = (a: TimelineMixLoudnessFileIdentity, b: TimelineMixLoudnessFileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function fileIdentity(value: unknown): value is TimelineMixLoudnessFileIdentity {
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

/** Ephemeral read-only full-mix observation. No mutation, persisted candidate,
 * output file, queue, source repair, or cache is reachable from this service. */
export function createTimelineMixLoudnessServices(store: TimelineMixLoudnessStore,
  options: {runtime: TimelineMixLoudnessRuntime; signal?: AbortSignal}) {
  const {runtime, signal: ownerSignal} = options;
  // Share the native-owner audio observation slot with final-file observers.
  const state = exportAudioObservationAdmission(store.db);
  const assertOwner = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fault('TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED', 403);
  };
  const available = (signal?: AbortSignal): void => {
    assertOwner();
    if (state.shutdownFailure) throw state.shutdownFailure;
    if (state.stopped || ownerSignal?.aborted || signal?.aborted) throw fault('OPERATION_CANCELLED', 503);
  };
  function current(input: {projectId: string; expectedRevision: number}): Current {
    assertOwner();
    let raw: unknown;
    try {raw = runtime.readSavedTimeline(input.projectId);} catch {return unavailable();}
    assertOwner();
    if (!plainData(raw, 4 * 1024 * 1024) || !object(raw) || !object(raw.timeline) || !Array.isArray(raw.assets) || raw.assets.length > 100) unavailable();
    const saved = raw.timeline;
    if (typeof saved.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(saved.id) || saved.projectId !== input.projectId ||
        !Number.isSafeInteger(saved.revision) || typeof saved.revision !== 'number' || saved.revision < 1 ||
        !Array.isArray(saved.tracks) || saved.tracks.length > 12 || !Array.isArray(saved.clips) || saved.clips.length > 100) unavailable();
    if (saved.revision !== input.expectedRevision) throw fault('TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT');
    const tracks = saved.tracks.map((track: unknown) => {
      if (!object(track) || typeof track.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(track.id) ||
          typeof track.orderIndex !== 'number' || !Number.isSafeInteger(track.orderIndex) || track.orderIndex < 0 || track.orderIndex > 11) return unavailable();
      return {id: track.id, kind: track.kind, orderIndex: track.orderIndex, hidden: track.hidden, muted: track.muted};
    });
    const clips = saved.clips.map((clip: unknown) => {
      if (!object(clip) || ['id', 'trackId', 'assetId'].some(key => typeof clip[key] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(clip[key] as string)) || ['transition', 'transitions', 'effects', 'speed', 'rate', 'opacity', 'blendMode'].some(key => Object.hasOwn(clip, key))) return unavailable();
      return {id: clip.id, trackId: clip.trackId, assetId: clip.assetId, startFrame: clip.startFrame,
        durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame, gain: clip.gain,
        ...(Object.hasOwn(clip, 'fadeInFrames') ? {fadeInFrames: clip.fadeInFrames} : {}),
        ...(Object.hasOwn(clip, 'fadeOutFrames') ? {fadeOutFrames: clip.fadeOutFrames} : {}),
        ...volumeEnvelopeField(clip)};
    });
    let processingSnapshot: ReturnType<typeof volumeEnvelopeReadSnapshot>;
    try {processingSnapshot = volumeEnvelopeReadSnapshot(raw);} catch {throw fault('TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT');}
    const managed = new Map<string, Managed>(), assets = new Map<string, TimelineMixLoudnessAsset>();
    const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
    for (const asset of raw.assets) {
      if (!object(asset) || !uuid(asset.id) || asset.projectId !== input.projectId || managed.has(asset.id) ||
          typeof asset.relativePath !== 'string' || asset.relativePath.length > 4096 ||
          typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
          typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 ||
          typeof asset.mimeType !== 'string' || (!asset.mimeType.startsWith('image/') && typeof asset.hasAudio !== 'boolean') ||
          (asset.mimeType.startsWith('image/') && asset.hasAudio === true) ||
          (asset.duration !== null && asset.duration !== undefined && (typeof asset.duration !== 'number' || !Number.isFinite(asset.duration) || asset.duration <= 0))) unavailable();
      managed.set(asset.id, Object.freeze({id: asset.id, relativePath: asset.relativePath, sha256: asset.sha256, sizeBytes: asset.sizeBytes}));
      assets.set(asset.id, Object.freeze({file: '', mimeType: asset.mimeType, duration: asset.duration ?? null, hasAudio: asset.hasAudio === true}));
    }
    // The decoder's pure planner independently validates every projected field,
    // clip bound, overlap and original segment before any source is opened.
    const timeline = {fps: saved.fps, durationFrames: saved.durationFrames, tracks, clips} as TimelineMixLoudnessTimeline;
    const referenced = new Set(timeline.clips.map(clip => clip.assetId));
    if (assets.size !== referenced.size || [...assets.keys()].some(id => !referenced.has(id))) unavailable();
    const plan = planTimelineMixLoudnessDecode(timeline, assets);
    const tracksById = new Map(timeline.tracks.map(track => [track.id, track]));
    // Persisted hasAudio=false cannot prove a potentially audible video is
    // silent. Pin and double-hash all unmuted positive-gain media so the real
    // probe can confirm that saved audio presence still agrees with its bytes.
    const observed = new Set(timeline.clips.filter(clip => clip.volumeEnvelope != null || !tracksById.get(clip.trackId)!.muted && clip.gain > 0 &&
      !assets.get(clip.assetId)!.mimeType.startsWith('image/')).map(clip => clip.assetId));
    const sources = [...observed].sort().map(id => managed.get(id)!);
    const totalSourceBytes = sources.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    if (sources.some(asset => asset.sizeBytes > LIMITS.sourceBytes) || totalSourceBytes > LIMITS.sourceBytes) throw fault('TIMELINE_MIX_LOUDNESS_SOURCE_LIMIT');
    if (plan.decodeWorkFrames * 2 > LIMITS.decodeWorkFrames || plan.pcmBytes * 2 > LIMITS.pcmBytes) throw fault('TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT');
    return {timeline: freeze(timeline), timelineId: saved.id, revision: saved.revision,
      identity: hashText(JSON.stringify(processingSnapshot)), assets, sources: freeze(sources), plan};
  }
  const stop = (): void => {state.stopped = true; state.active?.controller.abort();};
  ownerSignal?.addEventListener('abort', stop, {once: true});
  if (ownerSignal?.aborted) stop();

  // Backend-only synchronous continuation. A public prepare DTO cannot recreate
  // this live fence; it expires as soon as the continuation returns or throws.
  async function withFreshMeasurement<T>(rawInput: unknown,
    consume: (report: TimelineMixLoudnessResponse, finalFence: () => void) => T,
    context: {signal?: AbortSignal} = {}): Promise<T> {
    // Refuse restored workspaces before even inspecting a hostile input getter.
    runtime.assertOrdinaryWorkspace();
    if (!plainData(rawInput, 2048)) throw fault('VALIDATION_ERROR', 400);
    const parsed = timelineMixLoudnessInputSchema.safeParse(rawInput);
    if (!parsed.success) throw fault('VALIDATION_ERROR', 400);
    const input = parsed.data;
    available(context.signal);
    if (state.active) throw fault('TIMELINE_MIX_LOUDNESS_BUSY', 429);
    const started = performance.now(), initial = current(input);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ownerSignal, context.signal].filter((value): value is AbortSignal => value !== undefined));
    let timedOut = false, fencedFailure: unknown, bytesHashed = 0, pcmBytes = 0;
    const expected = new Map<string, {file: string; info: TimelineMixLoudnessFileIdentity}>();
    const remainingMs = (): number => Math.max(0, LIMITS.timeoutMs - (performance.now() - started));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, remainingMs());
    const entry: ExportAudioObservationEntry = {controller, signal, task: Promise.resolve()};
    state.active = entry;
    const fence = (): void => {
      try {
        assertOwner();
        const latest = current(input);
        if (latest.identity !== initial.identity) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
        if (state.stopped || signal.aborted) throw fault(timedOut ? 'TIMELINE_MIX_LOUDNESS_TIMEOUT' : 'OPERATION_CANCELLED', 503);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); throw fault('TIMELINE_MIX_LOUDNESS_TIMEOUT', 503);}
        for (const source of initial.sources) {
          const identity = expected.get(source.id);
          if (!identity) continue;
          const actual = runtime.validateSource(store.root, source, {maxBytes: LIMITS.sourceBytes});
          if (actual.file !== identity.file || !fileIdentity(actual.info) || actual.info.size !== source.sizeBytes || !sameFile(actual.info, identity.info)) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
        }
      } catch (error) {fencedFailure ??= error; throw fencedFailure;}
    };
    const onBytes = (bytes: number): void => {
      fence();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytesHashed + bytes > LIMITS.hashBytes)
        throw fault('TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT');
      bytesHashed += bytes;
    };
    async function hash(source: Managed): Promise<void> {
      fence();
      const identity = expected.get(source.id);
      if (!identity) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
      const previous = bytesHashed;
      const value = await runtime.hash(store.root, source, {signal, expected: identity.info,
        maxBytes: LIMITS.sourceBytes, onBytes, beforeEffect: fence});
      fence();
      if (bytesHashed - previous !== source.sizeBytes || !object(value) || value.sha256 !== source.sha256 || value.sizeBytes !== source.sizeBytes ||
          value.file !== identity.file || !fileIdentity(value.info) || !sameFile(value.info, identity.info)) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
    }
    async function measure(timeline: TimelineMixLoudnessTimeline, assets: ReadonlyMap<string, TimelineMixLoudnessAsset>): Promise<ExportLoudnessMeasurement> {
      fence();
      const meter = createExportLoudnessAccumulator(timeline.durationFrames / 30);
      let passBytes = 0;
      const decoded = await runtime.decode(timeline, new Map(assets), {signal, beforeEffect: fence, remainingMs, onPcm: chunk => {
        fence();
        if (!Buffer.isBuffer(chunk) || chunk.length > initial.plan.pcmBytes - passBytes || chunk.length > LIMITS.pcmBytes - pcmBytes)
          throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
        passBytes += chunk.length; pcmBytes += chunk.length;
        meter.write(chunk);
        fence();
      }});
      fence();
      if (!object(decoded) || decoded.sampleRate !== 48000 || decoded.channels !== 2 || decoded.sampleFrames !== timeline.durationFrames * 1600 ||
          decoded.pcmBytes !== initial.plan.pcmBytes || passBytes !== initial.plan.pcmBytes || decoded.segmentCount !== initial.plan.segmentCount ||
          decoded.decodeWorkFrames !== initial.plan.decodeWorkFrames) throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
      // AAC's +/-100ms allowance is intentionally not authority for this lane.
      const result = exportLoudnessMeasurementSchema.safeParse(meter.finish());
      if (!result.success || result.data.sampleFrames !== timeline.durationFrames * 1600) throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
      fence(); return result.data;
    }
    async function runPreparation() {
      fence();
      const assets = new Map(initial.assets);
      for (const source of initial.sources) {
        fence();
        const actual = runtime.validateSource(store.root, source, {maxBytes: LIMITS.sourceBytes});
        if (typeof actual.file !== 'string' || !fileIdentity(actual.info) || actual.info.size !== source.sizeBytes) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
        expected.set(source.id, {file: actual.file, info: Object.freeze({dev: actual.info.dev, ino: actual.info.ino, size: actual.info.size,
          mtimeMs: actual.info.mtimeMs, ctimeMs: actual.info.ctimeMs})});
        assets.set(source.id, Object.freeze({...assets.get(source.id)!, file: actual.file}));
      }
      for (const source of initial.sources) {await hash(source); fence();}
      const original = await measure(initial.timeline, assets); fence();
      const candidate = await prepareCandidate(initial, original, input.target, assets, measure, fence); fence();
      // Both measurements concern exactly these same bytes. No partial result
      // survives a failed second hash, changed metadata, or ownership loss.
      for (const source of initial.sources) {await hash(source); fence();}
      if (bytesHashed !== initial.sources.reduce((sum, source) => sum + source.sizeBytes * 2, 0)) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
      return {original, candidate};
    }
    const work = runPreparation();
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
          state.shutdownFailure = unconfirmed(error) ? Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}) : fault('TIMELINE_MIX_LOUDNESS_SHUTDOWN_FAILED', 503);
          throw state.shutdownFailure;
        } finally {if (closed && state.active === entry) state.active = null; clearTimeout(timer);}
      }
    })();
    entry.task = joined;
    // Retain the exact task across public cancellation and noncooperative I/O.
    joined.catch(error => {if (unconfirmed(error)) state.shutdownFailure ??= error;});
    let live = false;
    try {
      let response: TimelineMixLoudnessResponse;
      try {
        const result = await observe(joined, signal); fence();
        response = publish(input, initial, result, bytesHashed, pcmBytes);
        fence();
      } catch (error) {
        try {fence();} catch { /* Preserve the first causal fence failure. */ }
        if (state.shutdownFailure) throw state.shutdownFailure;
        const cause = fencedFailure ?? error, code = codeOf(cause);
        if (timedOut) throw fault('TIMELINE_MIX_LOUDNESS_TIMEOUT', 503);
        if (code && publicCodes.has(code))
          throw fault(code, code === 'TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED' ? 403 : code === 'OPERATION_CANCELLED' ? 503 : 409);
        if (code === 'MEDIA_TIMEOUT') throw fault('TIMELINE_MIX_LOUDNESS_TIMEOUT', 503);
        if (code === 'MEDIA_CANCELLED') throw fault('OPERATION_CANCELLED', 503);
        if (code === 'LOUDNESS_INVALID_PCM' || code === 'LOUDNESS_DURATION_MISMATCH') throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
        if (code?.startsWith('MANAGED_')) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
        throw fault('TIMELINE_MIX_LOUDNESS_DECODE_FAILED');
      }
      // All children have retired. Crucially, transaction/commit errors from
      // this continuation are outside media normalization and remain unknown.
      live = true;
      return consume(response, () => {
        if (!live) throw fault('TIMELINE_MIX_LOUDNESS_STALE');
        fence();
        // Synchronous adapters may consume time or revoke ownership while
        // validating the last source. Close that final boundary before writes.
        assertOwner();
        if (state.stopped || signal.aborted) throw fault(timedOut ? 'TIMELINE_MIX_LOUDNESS_TIMEOUT' : 'OPERATION_CANCELLED', 503);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); throw fault('TIMELINE_MIX_LOUDNESS_TIMEOUT', 503);}
      });
    } finally {live = false; controller.abort();}
  }
  async function drain(): Promise<void> {
    stop();
    try {await runtime.boundedShutdown(Promise.allSettled(state.active ? [state.active.task] : []), 'TIMELINE_MIX_LOUDNESS_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (state.shutdownFailure) throw state.shutdownFailure;
  }
  const prepare = (rawInput: unknown, context: {signal?: AbortSignal} = {}): Promise<TimelineMixLoudnessResponse> =>
    withFreshMeasurement(rawInput, report => report, context);
  return {handlers: {'timeline.loudness.prepare': prepare}, withFreshMeasurement, drain};
}

type Candidate = TimelineMixLoudnessResponse['candidate'];
async function prepareCandidate(initial: Current, original: ExportLoudnessMeasurement, target: TimelineMixLoudnessInput['target'],
  assets: ReadonlyMap<string, TimelineMixLoudnessAsset>,
  measure: (timeline: TimelineMixLoudnessTimeline, assets: ReadonlyMap<string, TimelineMixLoudnessAsset>) => Promise<ExportLoudnessMeasurement>,
  fence: () => void): Promise<Candidate> {
  if (original.state !== 'valid' || original.integratedLufs === null)
    return {status: 'unavailable', reason: 'NO_VALID_LOUDNESS', requiredGainDb: null, gainMultiplier: null, gains: [],
      measurement: null, meetsTarget: false, meetsTruePeak: false, marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, applyAllowed: false};
  const requiredGainDb = target.integratedLufs - original.integratedLufs, gainMultiplier = 10 ** (requiredGainDb / 20);
  const tracks = new Map(initial.timeline.tracks.map(track => [track.id, track]));
  const gains = initial.timeline.clips
    .filter(clip => !tracks.get(clip.trackId)!.muted && clip.gain > 0 && assets.get(clip.assetId)!.hasAudio)
    .map(clip => ({clipId: clip.id, assetId: clip.assetId, beforeGain: clip.gain, afterGain: clip.gain * gainMultiplier}))
    .sort((a, b) => a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0);
  if (!Number.isFinite(gainMultiplier) || gainMultiplier <= 0 || gains.some(gain => !Number.isFinite(gain.afterGain) || gain.afterGain <= 0 || gain.afterGain > 2))
    return {status: 'unavailable', reason: 'GAIN_OUT_OF_RANGE', requiredGainDb, gainMultiplier, gains: [],
      measurement: null, meetsTarget: false, meetsTruePeak: false, marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, applyAllowed: false};
  if (!gains.length) throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
  const byId = new Map(gains.map(gain => [gain.clipId, gain.afterGain]));
  // Re-render the complete mix using actual changed clip volume stages. Never
  // scale a final PCM buffer or infer candidate gate membership arithmetically.
  const candidateTimeline = freeze({...initial.timeline, clips: initial.timeline.clips.map(clip =>
    byId.has(clip.id) ? {...clip, gain: byId.get(clip.id)!} : clip)});
  fence(); const measurement = await measure(candidateTimeline, assets); fence();
  return {status: 'measured', reason: null, requiredGainDb, gainMultiplier, gains, measurement,
    meetsTarget: measurement.integratedLufs !== null && Math.abs(measurement.integratedLufs - target.integratedLufs) <= LIMITS.targetToleranceLu,
    meetsTruePeak: measurement.truePeakDbtp !== null && measurement.truePeakDbtp <= target.truePeakCeilingDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB,
    marginDb: EXPORT_LOUDNESS_ADVISORY_MARGIN_DB, applyAllowed: false};
}
function publish(input: TimelineMixLoudnessInput, initial: Current,
  result: {original: ExportLoudnessMeasurement; candidate: Candidate}, bytesHashed: number, pcmBytes: number): TimelineMixLoudnessResponse {
  const passes = result.candidate.status === 'measured' ? 2 : 1;
  const envelopeProfile = volumeEnvelopeProcessingProfile(initial.timeline.clips);
  const value = {...(envelopeProfile ? {volumeEnvelopeProcessingProfile: envelopeProfile} : {}), ...input, status: 'ready', checkedAt: new Date().toISOString(), stage: 'preencode_float_mix', applyAllowed: false,
    identity: {timelineId: initial.timelineId, timelineRevision: initial.revision, snapshotSha256: initial.identity,
      range: {startFrame: 0, endFrame: initial.timeline.durationFrames, sampleFrames: initial.timeline.durationFrames * 1600},
      sources: initial.sources.map(source => ({assetId: source.id, sha256: source.sha256, sizeBytes: source.sizeBytes}))},
    ...result, checks: {bytesHashed, pcmBytes, decodeWorkFrames: initial.plan.decodeWorkFrames * passes,
      segmentCount: initial.plan.segmentCount, passes, audioFullyDecoded: true}};
  if (pcmBytes !== initial.plan.pcmBytes * passes || !plainData(value, LIMITS.reportBytes) || !isTimelineMixLoudnessResponse(value, input))
    throw fault('TIMELINE_MIX_LOUDNESS_INVALID_PCM');
  return freeze(value);
}
