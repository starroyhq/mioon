import {volumeEnvelopeField, volumeEnvelopeProcessingProfile, volumeEnvelopeReadSnapshot} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {createLoudnessRangeMeter} from './loudness-range-meter.ts';
import {loudnessRangeMeasurementSchema} from '@mioon/contracts/loudness-range';
import type {LoudnessRangeMeasurement} from '@mioon/contracts/loudness-range';
import {createExportLoudnessAccumulator} from './export-loudness-meter.ts';
import {TIMELINE_CLIP_LOUDNESS_LIMITS as LIMITS, TIMELINE_CLIP_LOUDNESS_PROFILE, timelineClipLoudnessInputSchema, isTimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import type {TimelineClipLoudnessInput, TimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import {exportLoudnessMeasurementSchema} from '@mioon/contracts/export-loudness';
import type {ExportLoudnessMeasurement} from '@mioon/contracts/export-loudness';
import {exportAudioObservationAdmission} from './export-audio-observation.ts';
import type {ExportAudioObservationEntry} from './export-audio-observation.ts';
import {planTimelineClipLoudnessDecode} from './timeline-clip-loudness-decoder.ts';
import type {TimelineClipLoudnessSignal, TimelineClipLoudnessDecoder} from './timeline-clip-loudness-decoder.ts';
import type {TimelineMixLoudnessTimeline, TimelineMixLoudnessAsset} from './timeline-mix-loudness-decoder.ts';
import {prepareTimelineClipLoudnessCandidate} from './timeline-clip-loudness-candidate.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (value: unknown): string | undefined => object(value) && typeof value.code === 'string' ? value.code : undefined;
const unconfirmed = (value: unknown): boolean => object(value) && value.terminationUnconfirmed === true;
const messages: Readonly<Record<string, string>> = Object.freeze({
  TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT: 'This first increment supports a complete selected clip of at most 60 seconds (1800 frames). Longer clips are refused, never trimmed automatically.',
  TIMELINE_CLIP_LOUDNESS_MUTED: 'The selected clip belongs to a muted track. No source-only measurement was substituted.',
  TIMELINE_CLIP_LOUDNESS_ZERO_GAIN: 'The selected clip has zero saved gain. No source-only measurement was substituted.',
  TIMELINE_CLIP_LOUDNESS_NO_AUDIO: 'The selected clip has no supported audio stream. This is not a digital-silence measurement.',
  TIMELINE_CLIP_LOUDNESS_UNSUPPORTED_FORMAT: 'The selected source has an unsupported audio format or channel layout.',
});
const fault = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error(messages[code] ?? 'The selected saved clip loudness measurement is unavailable. Read the saved timeline and explicitly analyze again.'), {code, status});
function unavailable(): never {throw fault('TIMELINE_CLIP_LOUDNESS_UNAVAILABLE', 404);}
const publicCodes = new Set(['TIMELINE_CLIP_LOUDNESS_UNAVAILABLE', 'TIMELINE_CLIP_LOUDNESS_OWNER_REQUIRED',
  'TIMELINE_CLIP_LOUDNESS_REVISION_CONFLICT', 'TIMELINE_CLIP_LOUDNESS_SOURCE_LIMIT', 'TIMELINE_CLIP_LOUDNESS_RESOURCE_LIMIT',
  'TIMELINE_CLIP_LOUDNESS_BUSY', 'TIMELINE_CLIP_LOUDNESS_STALE', 'TIMELINE_CLIP_LOUDNESS_TIMEOUT',
  'TIMELINE_CLIP_LOUDNESS_INVALID_PCM', 'TIMELINE_CLIP_LOUDNESS_BUDGET', 'TIMELINE_CLIP_LOUDNESS_SAMPLE_COUNT_MISMATCH',
  'TIMELINE_CLIP_LOUDNESS_SOURCE_BOUNDS', 'TIMELINE_CLIP_LOUDNESS_SOURCE_METADATA_MISMATCH',
  'TIMELINE_CLIP_LOUDNESS_UNSUPPORTED_FORMAT', 'OPERATION_CANCELLED',
  'RESTORE_OPERATION_UNAVAILABLE', 'TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT', 'TIMELINE_CLIP_LOUDNESS_MUTED', 'TIMELINE_CLIP_LOUDNESS_ZERO_GAIN', 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO']);
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

export interface TimelineClipLoudnessStore {readonly db: DatabaseSync; readonly root: string}
export interface TimelineClipLoudnessFileIdentity {
  readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
}
export interface TimelineClipLoudnessManagedAsset {readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number}
export interface TimelineClipLoudnessHashOptions {
  readonly signal: AbortSignal; readonly expected: TimelineClipLoudnessFileIdentity; readonly maxBytes: number;
  readonly onBytes: (bytes: number) => void; readonly beforeEffect: () => void;
}
/** Fixed backend adapters. The coherent bounded reader validates the whole
 * saved timeline and owned source graph, never initializes or writes a row. */
export interface TimelineClipLoudnessRuntime {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  readSavedTimeline(projectId: string): unknown;
  validateSource(root: string, asset: TimelineClipLoudnessManagedAsset, options: {maxBytes: number}): {file: string; info: TimelineClipLoudnessFileIdentity};
  hash(root: string, asset: TimelineClipLoudnessManagedAsset, options: TimelineClipLoudnessHashOptions): Promise<unknown>;
  decode: TimelineClipLoudnessDecoder;
  terminate(signal: AbortSignal): Promise<readonly {status: string}[]>;
  waitForClose(signal: AbortSignal): Promise<readonly {status: string}[]>;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
}
interface Managed extends TimelineClipLoudnessManagedAsset {readonly id: string}
interface Current {
  readonly signal: TimelineClipLoudnessSignal;
  readonly timelineId: string;
  readonly revision: number;
  readonly identity: string;
  readonly assets: ReadonlyMap<string, TimelineMixLoudnessAsset>;
  readonly sources: readonly Managed[];
  readonly plan: ReturnType<typeof planTimelineClipLoudnessDecode>;
}
const sameFile = (a: TimelineClipLoudnessFileIdentity, b: TimelineClipLoudnessFileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function fileIdentity(value: unknown): value is TimelineClipLoudnessFileIdentity {
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

/** Ephemeral read-only independent saved-clip observation. No mutation, persisted candidate,
 * output file, queue, source repair, or cache is reachable from this service. */
export function createTimelineClipLoudnessServices(store: TimelineClipLoudnessStore,
  options: {runtime: TimelineClipLoudnessRuntime; signal?: AbortSignal}) {
  const {runtime, signal: ownerSignal} = options;
  // Share the native-owner audio observation slot with final-file observers.
  const state = exportAudioObservationAdmission(store.db);
  const assertOwner = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fault('TIMELINE_CLIP_LOUDNESS_OWNER_REQUIRED', 403);
  };
  const available = (signal?: AbortSignal): void => {
    assertOwner();
    if (state.shutdownFailure) throw state.shutdownFailure;
    if (state.stopped || ownerSignal?.aborted || signal?.aborted) throw fault('OPERATION_CANCELLED', 503);
  };
  function current(input: TimelineClipLoudnessInput): Current {
    assertOwner();
    let raw: unknown;
    try {raw = runtime.readSavedTimeline(input.projectId);} catch {return unavailable();}
    assertOwner();
    if (!plainData(raw, 4 * 1024 * 1024) || !object(raw) || !object(raw.timeline) || !Array.isArray(raw.assets) || raw.assets.length > 100) unavailable();
    const saved = raw.timeline;
    if (typeof saved.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(saved.id) || saved.projectId !== input.projectId ||
        !Number.isSafeInteger(saved.revision) || typeof saved.revision !== 'number' || saved.revision < 1 ||
        !Array.isArray(saved.tracks) || saved.tracks.length > 12 || !Array.isArray(saved.clips) || saved.clips.length > 100) unavailable();
    if (saved.id !== input.timelineId) unavailable();
    if (saved.revision !== input.expectedRevision) throw fault('TIMELINE_CLIP_LOUDNESS_REVISION_CONFLICT');
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
    try {processingSnapshot = volumeEnvelopeReadSnapshot(raw);} catch {throw fault('TIMELINE_CLIP_LOUDNESS_RESOURCE_LIMIT');}
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
    const timeline = {fps: saved.fps, durationFrames: saved.durationFrames, tracks, clips} as TimelineMixLoudnessTimeline;
    const referenced = new Set(timeline.clips.map(clip => clip.assetId));
    if (assets.size !== referenced.size || [...assets.keys()].some(id => !referenced.has(id))) unavailable();
    const clip = timeline.clips.find(item => item.id === input.clipId);
    if (!clip) unavailable();
    const track = timeline.tracks.find(item => item.id === clip.trackId), asset = assets.get(clip.assetId), source = managed.get(clip.assetId);
    if (!track || !asset || !source) unavailable();
    if (source.sha256 !== input.expectedAssetSha256) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
    if (clip.durationFrames > LIMITS.clipFrames) throw fault('TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT');
    if (track.muted) throw fault('TIMELINE_CLIP_LOUDNESS_MUTED');
    if (clip.gain === 0) throw fault('TIMELINE_CLIP_LOUDNESS_ZERO_GAIN');
    if (asset.mimeType.startsWith('image/')) throw fault('TIMELINE_CLIP_LOUDNESS_NO_AUDIO');
    const signal = freeze({clip, track, asset});
    const plan = planTimelineClipLoudnessDecode(signal);
    if (source.sizeBytes > LIMITS.sourceBytes) throw fault('TIMELINE_CLIP_LOUDNESS_SOURCE_LIMIT');
    if (plan.decodeWorkFrames > LIMITS.decodeWorkFrames || plan.pcmBytes > LIMITS.pcmBytes) throw fault('TIMELINE_CLIP_LOUDNESS_RESOURCE_LIMIT');
    return {signal, timelineId: saved.id, revision: saved.revision,
      identity: hashText(JSON.stringify({saved: processingSnapshot, selection: input})), assets,
      sources: freeze([source]), plan};
  }
  const stop = (): void => {state.stopped = true; state.active?.controller.abort();};
  ownerSignal?.addEventListener('abort', stop, {once: true});
  if (ownerSignal?.aborted) stop();

  async function measureClip(rawInput: unknown, context: {signal?: AbortSignal} = {}): Promise<TimelineClipLoudnessResponse> {
    // Refuse restored workspaces before even inspecting a hostile input getter.
    runtime.assertOrdinaryWorkspace();
    if (!plainData(rawInput, 2048)) throw fault('VALIDATION_ERROR', 400);
    const parsed = timelineClipLoudnessInputSchema.safeParse(rawInput);
    if (!parsed.success) throw fault('VALIDATION_ERROR', 400);
    const input = parsed.data;
    available(context.signal);
    if (state.active) throw fault('TIMELINE_CLIP_LOUDNESS_BUSY', 429);
    const started = performance.now(), initial = current(input);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ownerSignal, context.signal].filter((value): value is AbortSignal => value !== undefined));
    let timedOut = false, fencedFailure: unknown, bytesHashed = 0, pcmBytes = 0;
    const expected = new Map<string, {file: string; info: TimelineClipLoudnessFileIdentity}>();
    const remainingMs = (): number => Math.max(0, LIMITS.timeoutMs - (performance.now() - started));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, remainingMs());
    const entry: ExportAudioObservationEntry = {controller, signal, task: Promise.resolve()};
    state.active = entry;
    const fence = (): void => {
      try {
        assertOwner();
        const latest = current(input);
        if (latest.identity !== initial.identity) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
        if (state.stopped || signal.aborted) throw fault(timedOut ? 'TIMELINE_CLIP_LOUDNESS_TIMEOUT' : 'OPERATION_CANCELLED', 503);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); throw fault('TIMELINE_CLIP_LOUDNESS_TIMEOUT', 503);}
        for (const source of initial.sources) {
          const identity = expected.get(source.id);
          if (!identity) continue;
          const actual = runtime.validateSource(store.root, source, {maxBytes: LIMITS.sourceBytes});
          if (actual.file !== identity.file || !fileIdentity(actual.info) || actual.info.size !== source.sizeBytes || !sameFile(actual.info, identity.info)) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
        }
      } catch (error) {fencedFailure ??= error; throw fencedFailure;}
    };
    const onBytes = (bytes: number): void => {
      fence();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytesHashed + bytes > LIMITS.hashBytes)
        throw fault('TIMELINE_CLIP_LOUDNESS_RESOURCE_LIMIT');
      bytesHashed += bytes;
    };
    async function hash(source: Managed): Promise<void> {
      fence();
      const identity = expected.get(source.id);
      if (!identity) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
      const previous = bytesHashed;
      const value = await runtime.hash(store.root, source, {signal, expected: identity.info,
        maxBytes: LIMITS.sourceBytes, onBytes, beforeEffect: fence});
      fence();
      if (bytesHashed - previous !== source.sizeBytes || !object(value) || value.sha256 !== source.sha256 || value.sizeBytes !== source.sizeBytes ||
          value.file !== identity.file || !fileIdentity(value.info) || !sameFile(value.info, identity.info)) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
    }
    async function measure(asset: TimelineMixLoudnessAsset): Promise<{measurement: ExportLoudnessMeasurement; loudnessRange: LoudnessRangeMeasurement;
      candidate?: NonNullable<TimelineClipLoudnessResponse['candidate']>}> {
      const durationFrames = initial.signal.clip.durationFrames;
      fence();
      const meter = createExportLoudnessAccumulator(durationFrames / 30), rangeMeter = createLoudnessRangeMeter();
      // A target is optional. Only its candidate measurement retains the
      // complete bounded isolated float signal; ordinary analysis stays fully
      // streaming. Adapters may reuse chunks, so retain owned bytes immediately.
      const candidatePcm = input.target ? Buffer.allocUnsafe(initial.plan.pcmBytes) : null;
      let passBytes = 0;
      const decoded = await runtime.decode({...initial.signal, asset}, {signal, beforeEffect: fence, remainingMs, onPcm: chunk => {
        fence();
        if (!Buffer.isBuffer(chunk) || chunk.length > initial.plan.pcmBytes - passBytes || chunk.length > LIMITS.pcmBytes - pcmBytes)
          throw fault('TIMELINE_CLIP_LOUDNESS_INVALID_PCM');
        meter.write(chunk); rangeMeter.push(chunk);
        if (candidatePcm) chunk.copy(candidatePcm, passBytes);
        passBytes += chunk.length; pcmBytes += chunk.length;
        fence();
      }});
      fence();
      if (!object(decoded) || decoded.sampleRate !== 48000 || decoded.channels !== 2 || decoded.sampleFrames !== durationFrames * 1600 ||
          decoded.pcmBytes !== initial.plan.pcmBytes || passBytes !== initial.plan.pcmBytes || decoded.segmentCount !== initial.plan.segmentCount ||
          decoded.decodeWorkFrames !== initial.plan.decodeWorkFrames) throw fault('TIMELINE_CLIP_LOUDNESS_INVALID_PCM');
      // AAC's +/-100ms allowance is intentionally not authority for this lane.
      const result = exportLoudnessMeasurementSchema.safeParse(meter.finish());
      if (!result.success || result.data.sampleFrames !== durationFrames * 1600) throw fault('TIMELINE_CLIP_LOUDNESS_INVALID_PCM');
      const loudnessRange = loudnessRangeMeasurementSchema.parse(rangeMeter.finish(durationFrames / 30));
      fence();
      const candidate = input.target && candidatePcm ? await prepareTimelineClipLoudnessCandidate({pcm: candidatePcm,
        original: result.data, target: input.target, beforeGain: initial.signal.clip.gain, fence}) : undefined;
      fence(); return {measurement: result.data, loudnessRange, ...(candidate ? {candidate} : {})};
    }
    async function runPreparation() {
      fence();
      const assets = new Map(initial.assets);
      for (const source of initial.sources) {
        fence();
        const actual = runtime.validateSource(store.root, source, {maxBytes: LIMITS.sourceBytes});
        if (typeof actual.file !== 'string' || !fileIdentity(actual.info) || actual.info.size !== source.sizeBytes) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
        expected.set(source.id, {file: actual.file, info: Object.freeze({dev: actual.info.dev, ino: actual.info.ino, size: actual.info.size,
          mtimeMs: actual.info.mtimeMs, ctimeMs: actual.info.ctimeMs})});
        assets.set(source.id, Object.freeze({...assets.get(source.id)!, file: actual.file}));
      }
      for (const source of initial.sources) {await hash(source); fence();}
      const result = await measure(assets.get(initial.signal.clip.assetId)!); fence();
      // The measurement concerns exactly these same bytes. No partial result
      // survives a failed second hash, changed metadata, or ownership loss.
      for (const source of initial.sources) {await hash(source); fence();}
      if (bytesHashed !== initial.sources.reduce((sum, source) => sum + source.sizeBytes * 2, 0)) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
      return result;
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
          state.shutdownFailure = unconfirmed(error) ? Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}) : fault('TIMELINE_CLIP_LOUDNESS_SHUTDOWN_FAILED', 503);
          throw state.shutdownFailure;
        } finally {if (closed && state.active === entry) state.active = null; clearTimeout(timer);}
      }
    })();
    entry.task = joined;
    // Retain the exact task across public cancellation and noncooperative I/O.
    joined.catch(error => {if (unconfirmed(error)) state.shutdownFailure ??= error;});
    try {
      let response: TimelineClipLoudnessResponse;
      try {
        const result = await observe(joined, signal); fence();
        const clip = initial.signal.clip, source = initial.sources[0]!;
        response = {...(volumeEnvelopeProcessingProfile([clip]) ? {volumeEnvelopeProcessingProfile: volumeEnvelopeProcessingProfile([clip])} : {}), ...input, status: 'ready', checkedAt: new Date().toISOString(), applyAllowed: false,
          processingProfile: TIMELINE_CLIP_LOUDNESS_PROFILE, stage: 'isolated_clip_post_gain_fades_pre_mix',
          identity: {...(clip.volumeEnvelope != null ? {volumeEnvelopeSha256: hashText(JSON.stringify(clip.volumeEnvelope))} : {}), snapshotSha256: initial.identity, trackId: clip.trackId, assetId: clip.assetId,
            assetSha256: source.sha256, sourceBytes: source.sizeBytes, startFrame: clip.startFrame,
            durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame, gain: clip.gain,
            fadeInFrames: clip.fadeInFrames ?? 0, fadeOutFrames: clip.fadeOutFrames ?? 0,
            trackMuted: false, measurementStartFrame: 0, measurementEndFrame: clip.durationFrames},
          ...result, checks: {bytesHashed, pcmBytes, decodeWorkFrames: initial.plan.decodeWorkFrames,
            segmentCount: 1, passes: 1, audioFullyDecoded: true}};
        if (!isTimelineClipLoudnessResponse(response, input)) throw fault('TIMELINE_CLIP_LOUDNESS_INVALID_PCM');
        fence();
      } catch (error) {
        try {fence();} catch { /* Preserve the first causal fence failure. */ }
        if (state.shutdownFailure) throw state.shutdownFailure;
        const cause = fencedFailure ?? error, rawCode = codeOf(cause);
        const code = rawCode?.replace(/^TIMELINE_MIX_LOUDNESS_/u, 'TIMELINE_CLIP_LOUDNESS_');
        if (timedOut) throw fault('TIMELINE_CLIP_LOUDNESS_TIMEOUT', 503);
        if (code && publicCodes.has(code))
          throw fault(code, code === 'TIMELINE_CLIP_LOUDNESS_OWNER_REQUIRED' ? 403 : code === 'OPERATION_CANCELLED' ? 503 : 409);
        if (code === 'MEDIA_TIMEOUT') throw fault('TIMELINE_CLIP_LOUDNESS_TIMEOUT', 503);
        if (code === 'MEDIA_CANCELLED') throw fault('OPERATION_CANCELLED', 503);
        if (code === 'LOUDNESS_INVALID_PCM' || code === 'LOUDNESS_DURATION_MISMATCH') throw fault('TIMELINE_CLIP_LOUDNESS_INVALID_PCM');
        if (code?.startsWith('MANAGED_')) throw fault('TIMELINE_CLIP_LOUDNESS_STALE');
        throw fault('TIMELINE_CLIP_LOUDNESS_DECODE_FAILED');
      }
      // Publication is observation only. No continuation can turn this into
      // write authority; all owned children have already retired.
      fence();
      return freeze(response);
    } finally {controller.abort();}
  }
  async function drain(): Promise<void> {
    stop();
    try {await runtime.boundedShutdown(Promise.allSettled(state.active ? [state.active.task] : []), 'TIMELINE_CLIP_LOUDNESS_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (state.shutdownFailure) throw state.shutdownFailure;
  }
  return {handlers: {'timeline.clip.loudness': measureClip}, drain};
}
