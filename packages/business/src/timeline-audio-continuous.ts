import {createHash} from 'node:crypto';
import {volumeEnvelopeField, volumeEnvelopeSnapshotFields, volumeEnvelopeReadSnapshot} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {createVolumeEnvelopeEvaluator} from '../../contracts/src/timeline-volume-envelope.ts';
import {assertVolumeEnvelopeSource} from './timeline-volume-envelope-source.ts';
import type {DatabaseSync} from 'node:sqlite';
import {CONTINUOUS_AUDIO_LIMITS as LIMITS, CONTINUOUS_AUDIO_PROFILE,
  continuousAudioPlanInputSchema, continuousAudioPlanSchema, continuousAudioBlockInputSchema,
  continuousAudioPlanDigestMaterial, continuousAudioSnapshotSchema} from '../../contracts/src/timeline-audio-continuous.ts';
import type {ContinuousAudioPlan, ContinuousAudioPlanInput, ContinuousAudioBlockInput, ContinuousAudioSnapshot} from '../../contracts/src/timeline-audio-continuous.ts';
import {audioPreviewEnvelopeGainAtLocalSample} from '../../contracts/src/timeline-audio-preview.ts';
import type {AudioPreviewVoice} from '../../contracts/src/timeline-audio-preview.ts';
import {timelineCompositionSegments} from '../../contracts/src/timeline-segments.ts';
import type {TimelineCompositionSegment} from '../../contracts/src/timeline-segments.ts';
import type {TimelineAudioPreviewFileIdentity, TimelineAudioPreviewManagedAsset, TimelineAudioPreviewHashOptions} from './timeline-audio-preview.ts';
import type {TimelineAudioPreviewSourceProbe} from './timeline-audio-preview-decoder.ts';
import type {ContinuousDecoder, ContinuousDecodeCursor} from './timeline-audio-continuous-decoder.ts';

type Snapshot = ContinuousAudioSnapshot;
type Clip = Snapshot['timeline']['clips'][number];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error('Saved timeline continuous audio is unavailable.'), {code, status});
const uncertainty = (error: unknown): boolean => object(error) && error.terminationUnconfirmed === true;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) as string;
}
function plain(value: unknown, maxBytes: number): boolean {
  let nodes = 16000; const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 8192;
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item), keys = Reflect.ownKeys(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype || item.length > 1000 || keys.length !== item.length + 1 :
      ![Object.prototype, null].includes(Object.getPrototypeOf(item)) || keys.length > 256) return false;
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item); return true;
  };
  try {return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes;} catch {return false;}
}
const sameFile = (a: TimelineAudioPreviewFileIdentity, b: TimelineAudioPreviewFileIdentity): boolean =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
const identity = (value: unknown): value is TimelineAudioPreviewFileIdentity => object(value) &&
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
export interface ContinuousAudioRuntime {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  readSavedTimeline(projectId: string): unknown;
  validateSource(root: string, asset: TimelineAudioPreviewManagedAsset, options: {maxBytes: number}): {file: string; info: TimelineAudioPreviewFileIdentity};
  hash(root: string, asset: TimelineAudioPreviewManagedAsset, options: TimelineAudioPreviewHashOptions): Promise<unknown>;
  decoder: ContinuousDecoder;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
  telemetry?: (event: Readonly<Record<string, number | string>>) => void;
}
interface Current {
  plan: ContinuousAudioPlan; snapshot: Snapshot; assets: Map<string, TimelineAudioPreviewManagedAsset>;
  segments: readonly TimelineCompositionSegment[]; voices: Clip[]; envelopeClips: Clip[];
}
interface Verified {
  file: string; info: TimelineAudioPreviewFileIdentity; asset: TimelineAudioPreviewManagedAsset;
  probe?: TimelineAudioPreviewSourceProbe; complete: boolean;
}
interface Cursor {key: string; reader: ContinuousDecodeCursor; nextFrame: number; endFrame: number}
interface Attempt {controller: AbortController; task: Promise<unknown>; token: object; releasePending?: () => void}
interface Session {
  id: string; initial: Current; controller: AbortController; timer: ReturnType<typeof setTimeout>;
  generation: number; requestedGeneration: number; sequence: number; nextFrame: number; cancelled: boolean; workFrames: number; generationWorkFrames: number;
  hashBytes: number; hashes: Map<string, Verified>; cursors: Map<string, Cursor>;
  active?: Attempt; pending?: Attempt; latest?: object; closing?: Promise<void>; failure?: unknown;
}
interface Admission {session?: Session; stopped: boolean; failure?: unknown; retired: Set<string>}
const admissions = new WeakMap<DatabaseSync, Admission>();
/** This conservative bound includes twelve source-read allocations, a 1 MiB
 * callback backing store plus 2 MiB paused-pipe allowance per cursor, six mixed
 * block copies across server/transport/renderer, and 2 MiB transport reserve.
 * Active work is retained through transport close; a replacement cannot open
 * cursors before old allocations/processes settle. The native lease separately
 * reserves the full 96 MiB across renderer retirement and window handoff. */
export const CONTINUOUS_AUDIO_PCM_ACCOUNTING = Object.freeze({sourceReadBytes: 60 * 12800,
  pipeChunkBytes: 1024 * 1024, cursors: 12, mixedCopies: 6,
  peakBoundBytes: 12 * (60 * 12800 + 3 * 1024 * 1024) + 6 * 60 * 12800 + 2 * 1024 * 1024});
export interface ContinuousAudioConsumeContext {
  plan: ContinuousAudioPlan; input: ContinuousAudioBlockInput; startFrame: number; endFrame: number;
  sampleFrames: number; signal: AbortSignal; beforeEffect: () => void;
}
interface ConsumeOptions<T> {
  signal?: AbortSignal; onResourceSettlement?: (settlement: Promise<void>) => void;
  consume: (decoded: {pcm: Buffer}, context: ContinuousAudioConsumeContext) => Promise<T>;
}

/** One store-wide pull session. A hash cache is session-local and keyed by
 * managed asset/hash/exact stat identity. The first published block brackets
 * its first source decode with TWO complete hashes; later blocks retain that
 * proof only while pathname, dev/ino/size/mtime/ctime stay identical at every
 * effect boundary. This explicitly differs from V1's double hash per window.
 * Automated sources required before their first audible block instead bracket
 * their eligibility probe with the two hashes; the same exact-identity fence
 * then protects later decode. No durable state or PCM cache is created. */
export function createTimelineAudioContinuousServices(store: {db: DatabaseSync; root: string},
  {runtime, signal: ownerSignal}: {runtime: ContinuousAudioRuntime; signal?: AbortSignal}) {
  let state = admissions.get(store.db);
  if (!state) {state = {stopped: false, retired: new Set()}; admissions.set(store.db, state);}
  const admission = state;
  const available = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fail('AUDIO_PREVIEW_OWNER_REQUIRED', 403);
    if (admission.failure) throw admission.failure;
    if (admission.stopped || ownerSignal?.aborted) throw fail('OPERATION_CANCELLED', 503);
  };
  function current(input: ContinuousAudioPlanInput): Current {
    available();
    let raw: unknown;
    try {raw = runtime.readSavedTimeline(input.projectId);} catch {throw fail('AUDIO_PREVIEW_UNAVAILABLE', 404);}
    if (!plain(raw, 4 * 1024 * 1024) || !object(raw) || !object(raw.timeline) || !Array.isArray(raw.assets)) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
    const saved = raw.timeline, managed = new Map<string, TimelineAudioPreviewManagedAsset>();
    if (!Array.isArray(saved.tracks) || !Array.isArray(saved.clips)) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
    let envelopeProfile: ReturnType<typeof volumeEnvelopeSnapshotFields>;
    try {
      volumeEnvelopeReadSnapshot(raw);
      envelopeProfile = volumeEnvelopeSnapshotFields({clips: saved.clips});
    } catch {throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');}
    const projected = {...envelopeProfile, timeline: {id: saved.id, projectId: saved.projectId, revision: saved.revision, fps: saved.fps,
      durationFrames: saved.durationFrames,
      tracks: saved.tracks.map((track: unknown) => {
        if (!object(track)) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
        return {id: track.id, kind: track.kind, orderIndex: track.orderIndex, hidden: track.hidden, muted: track.muted};
      }),
      clips: saved.clips.map((clip: unknown) => {
        if (!object(clip) || ['transition', 'transitions', 'effects', 'speed', 'rate', 'opacity', 'blendMode'].some(key => Object.hasOwn(clip, key))) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
        return {id: clip.id, trackId: clip.trackId, assetId: clip.assetId, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
          sourceInFrame: clip.sourceInFrame, gain: clip.gain, ...volumeEnvelopeField(clip),
          ...(Object.hasOwn(clip, 'fadeInFrames') ? {fadeInFrames: clip.fadeInFrames} : {}),
          ...(Object.hasOwn(clip, 'fadeOutFrames') ? {fadeOutFrames: clip.fadeOutFrames} : {})};
      })}, assets: raw.assets.map((asset: unknown) => {
      if (!object(asset) || typeof asset.id !== 'string' || typeof asset.relativePath !== 'string' || asset.relativePath.length > 4096 ||
          typeof asset.sha256 !== 'string' || typeof asset.sizeBytes !== 'number' || managed.has(asset.id)) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
      managed.set(asset.id, {relativePath: asset.relativePath, sha256: asset.sha256, sizeBytes: asset.sizeBytes});
      return {id: asset.id, projectId: asset.projectId, sha256: asset.sha256, sizeBytes: asset.sizeBytes,
        mimeType: asset.mimeType, duration: asset.duration ?? null, ...(Object.hasOwn(asset, 'hasAudio') ? {hasAudio: asset.hasAudio} : {})};
    })};
    const checked = continuousAudioSnapshotSchema.safeParse(projected);
    if (!checked.success) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
    const snapshot = checked.data, {timeline, assets} = snapshot;
    if (timeline.id !== input.timelineId || timeline.projectId !== input.projectId) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
    if (timeline.revision !== input.expectedRevision) throw fail('AUDIO_PREVIEW_REVISION_CONFLICT');
    if (input.startFrame >= timeline.durationFrames) throw fail('AUDIO_PREVIEW_RANGE_BOUNDS');
    const tracks = new Map(timeline.tracks.map(track => [track.id, track])), sources = new Map(assets.map(asset => [asset.id, asset]));
    if (tracks.size !== timeline.tracks.length || sources.size !== assets.length || assets.some(asset => asset.projectId !== input.projectId) ||
        timeline.tracks.some(track => track.kind === 'audio' && track.hidden)) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
    const clipIds = new Set<string>(), byTrack = new Map<string, Clip[]>(), voices: Clip[] = [], envelopeClips: Clip[] = []; let duration = 0;
    for (const clip of timeline.clips) {
      const track = tracks.get(clip.trackId), asset = sources.get(clip.assetId), end = clip.startFrame + clip.durationFrames;
      if (!track || !asset || clipIds.has(clip.id) || end > 18000) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
      clipIds.add(clip.id); duration = Math.max(duration, end);
      const image = asset.mimeType.startsWith('image/'), audio = asset.mimeType.startsWith('audio/');
      if (track.kind === 'audio' ? !audio : audio) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
      if (image ? asset.hasAudio === true || clip.sourceInFrame !== 0 : typeof asset.hasAudio !== 'boolean' || asset.duration === null ||
          asset.duration <= 0 || clip.sourceInFrame + clip.durationFrames > Math.floor(asset.duration * 30 + 1e-6)) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
      if ((clip.fadeInFrames ?? 0) + (clip.fadeOutFrames ?? 0) > clip.durationFrames ||
          ((clip.fadeInFrames ?? 0) > 0 || (clip.fadeOutFrames ?? 0) > 0) && asset.hasAudio !== true && clip.volumeEnvelope == null) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
      const list = byTrack.get(clip.trackId) ?? []; list.push(clip); byTrack.set(clip.trackId, list);
      if (clip.volumeEnvelope != null) {
        if (image) throw fail('VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');
        if (asset.sizeBytes > LIMITS.sourceBytes || asset.duration === null || asset.duration > 600) throw fail('AUDIO_PREVIEW_SOURCE_LIMIT');
        envelopeClips.push(clip);
      }
      if (!track.muted && clip.gain !== 0 && asset.hasAudio === true) {
        if (asset.sizeBytes > LIMITS.sourceBytes || asset.duration === null || asset.duration > 600) throw fail('AUDIO_PREVIEW_SOURCE_LIMIT');
        voices.push(clip);
      }
    }
    if (duration !== timeline.durationFrames) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
    for (const clips of byTrack.values()) {
      clips.sort((a, b) => a.startFrame - b.startFrame);
      if (clips.some((clip, index) => index > 0 && clip.startFrame < clips[index - 1]!.startFrame + clips[index - 1]!.durationFrames)) throw fail('AUDIO_PREVIEW_INVALID_SNAPSHOT');
    }
    const segments = timelineCompositionSegments(timeline), uniqueAssets = new Set([...voices, ...envelopeClips].map(clip => clip.assetId));
    const hashBytes = [...uniqueAssets].reduce((sum, id) => sum + 2 * sources.get(id)!.sizeBytes, 0);
    let workFrames = 0, runs = 0;
    for (const clip of voices) for (const segment of segments) if (segment.beginFrame >= clip.startFrame && segment.endFrame <= clip.startFrame + clip.durationFrames) {
      workFrames += segment.endFrame - segment.beginFrame + 1; runs++;
    }
    if (hashBytes > LIMITS.hashReadBytes) throw fail('AUDIO_PREVIEW_HASH_LIMIT');
    if (workFrames > LIMITS.decodeWorkFrames || runs > LIMITS.decodeSegments) throw fail('AUDIO_PREVIEW_BUDGET');
    const snapshotHash = hash(canonical(snapshot));
    const plan: ContinuousAudioPlan = {...volumeEnvelopeSnapshotFields(timeline), schemaVersion: 2, status: 'planned', profileId: CONTINUOUS_AUDIO_PROFILE,
      projectId: input.projectId, timelineId: input.timelineId, timelineRevision: input.expectedRevision,
      startFrame: input.startFrame, durationFrames: timeline.durationFrames, blockFrames: 60, sampleRate: 48000,
      channels: 2, admittedBytes: LIMITS.memoryBytes, snapshotHash, planHash: '0'.repeat(64)};
    plan.planHash = hash(continuousAudioPlanDigestMaterial(plan));
    continuousAudioPlanSchema.parse(plan);
    // A track owns one cursor. Consume its earlier clip tail before opening a
    // later clip head when both intersect a block, regardless of UUID order.
    voices.sort((a, b) => tracks.get(a.trackId)!.orderIndex - tracks.get(b.trackId)!.orderIndex ||
      a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    return {plan, snapshot, assets: managed, segments, voices, envelopeClips};
  }
  const inputOf = (input: ContinuousAudioBlockInput): ContinuousAudioPlanInput => ({projectId: input.projectId, timelineId: input.timelineId,
    expectedRevision: input.expectedRevision, startFrame: input.startFrame});
  const fenceSession = (session: Session, signal?: AbortSignal): void => {
    available();
    if (session.failure) throw session.failure;
    if (session.controller.signal.aborted || signal?.aborted || session.closing) throw fail('OPERATION_CANCELLED', 503);
    const latest = current({projectId: session.initial.plan.projectId, timelineId: session.initial.plan.timelineId,
      expectedRevision: session.initial.plan.timelineRevision, startFrame: session.initial.plan.startFrame});
    if (latest.plan.planHash !== session.initial.plan.planHash || canonical([...latest.assets]) !== canonical([...session.initial.assets])) throw fail('AUDIO_PREVIEW_STALE');
    for (const verified of session.hashes.values()) {
      const actual = runtime.validateSource(store.root, verified.asset, {maxBytes: LIMITS.sourceBytes});
      if (!identity(actual.info) || actual.file !== verified.file || !sameFile(actual.info, verified.info)) throw fail('AUDIO_PREVIEW_STALE');
    }
  };
  async function closeCursors(session: Session): Promise<void> {
    const readers = [...session.cursors.values()];
    const results = await Promise.allSettled(readers.map(cursor => cursor.reader.close()));
    for (const result of results) if (result.status === 'rejected') {
      session.failure = result.reason; admission.failure = result.reason; throw result.reason;
    }
    session.cursors.clear();
  }
  async function retireSessionById(sessionId: string): Promise<void> {
    const session = admission.session;
    if (!session || session.id !== sessionId) return;
    if (!session.closing) {
      session.controller.abort(); session.active?.controller.abort(); session.pending?.controller.abort(); clearTimeout(session.timer);
      session.closing = (async () => {
        await Promise.allSettled([session.active?.task, session.pending?.task]);
        await closeCursors(session);
        if (session.failure && uncertainty(session.failure)) throw session.failure;
        session.hashes.clear();
        if (admission.session === session) admission.session = undefined;
        admission.retired.add(session.id);
        if (admission.retired.size > 256) admission.retired.delete(admission.retired.values().next().value!);
      })();
      session.closing.catch(() => {});
    }
    return session.closing;
  }
  const stop = (): void => {
    admission.stopped = true;
    const session = admission.session;
    if (session) void retireSessionById(session.id).catch(error => {admission.failure = error;});
  };
  ownerSignal?.addEventListener('abort', stop, {once: true}); if (ownerSignal?.aborted) stop();
  async function plan(raw: unknown, context: {signal?: AbortSignal} = {}): Promise<ContinuousAudioPlan> {
    runtime.assertOrdinaryWorkspace();
    if (!plain(raw, 2048)) throw fail('VALIDATION_ERROR', 400);
    const parsed = continuousAudioPlanInputSchema.safeParse(raw);
    if (!parsed.success) throw fail('VALIDATION_ERROR', 400);
    if (context.signal?.aborted) throw fail('OPERATION_CANCELLED', 503);
    return current(parsed.data).plan;
  }
  async function verifiedAsset(session: Session, assetId: string, signal: AbortSignal): Promise<Verified> {
    const existing = session.hashes.get(assetId);
    if (existing) {fenceSession(session, signal); return existing;}
    const asset = session.initial.assets.get(assetId);
    if (!asset) throw fail('AUDIO_PREVIEW_UNAVAILABLE');
    const source = runtime.validateSource(store.root, asset, {maxBytes: LIMITS.sourceBytes});
    if (!identity(source.info) || source.info.size !== asset.sizeBytes) throw fail('AUDIO_PREVIEW_STALE');
    const verified: Verified = {file: source.file, info: {...source.info}, asset, complete: false};
    session.hashes.set(assetId, verified);
    try {
      await hashAsset(session, verified, signal);
      verified.probe = await runtime.decoder.probe(verified.file, {signal, beforeEffect: () => fenceSession(session, signal)});
      if (verified.probe.sizeBytes !== asset.sizeBytes) throw fail('AUDIO_PREVIEW_STALE');
      fenceSession(session, signal); return verified;
    } catch (error) {session.hashes.delete(assetId); throw error;}
  }
  async function hashAsset(session: Session, verified: Verified, signal: AbortSignal): Promise<void> {
    const before = session.hashBytes, fence = (): void => fenceSession(session, signal);
    const result = await runtime.hash(store.root, verified.asset, {signal, expected: verified.info, maxBytes: LIMITS.sourceBytes, beforeEffect: fence,
      onBytes(bytes) {
        fence();
        if (!Number.isSafeInteger(bytes) || bytes < 1 || session.hashBytes + bytes > LIMITS.hashReadBytes) throw fail('AUDIO_PREVIEW_HASH_LIMIT');
        session.hashBytes += bytes;
      }});
    fence();
    if (session.hashBytes - before !== verified.asset.sizeBytes || !object(result) || result.sha256 !== verified.asset.sha256 ||
        result.file !== verified.file || result.sizeBytes !== verified.asset.sizeBytes || !identity(result.info) || !sameFile(result.info, verified.info)) throw fail('AUDIO_PREVIEW_STALE');
    runtime.telemetry?.({type: 'hash', bytes: session.hashBytes});
  }
  async function sourcePart(session: Session, clip: Clip, segment: TimelineCompositionSegment, from: number, to: number, signal: AbortSignal): Promise<Buffer> {
    const key = `${clip.id}:${segment.beginFrame}:${segment.endFrame}`;
    let cursor = session.cursors.get(clip.trackId);
    if (cursor && (cursor.key !== key || cursor.nextFrame !== from)) {
      await cursor.reader.close(); session.cursors.delete(clip.trackId); cursor = undefined;
    }
    const verified = await verifiedAsset(session, clip.assetId, signal);
    if (!cursor) {
      const fullWork = segment.endFrame - segment.beginFrame + 1, prefix = from - segment.beginFrame;
      // A seek really decodes its original-segment prefix. Charge it before
      // opening, plus a fixed conservative pipe/filter read-ahead allowance.
      // Thereafter charge actual produced output cumulatively, never refunding
      // cancellation. Charging an unexecuted ten-minute suffix on every pause
      // would exhaust normal controls despite bounded physical work.
      const reserve = Math.ceil(3 * 1024 * 1024 / 12800);
      let producedBytes = 0, charged = Math.min(fullWork, prefix + 1 + reserve);
      const debit = (frames: number): void => {
        if (session.workFrames + frames > LIMITS.sessionDecodeWorkFrames || session.generationWorkFrames + frames > LIMITS.decodeWorkFrames) throw fail('AUDIO_PREVIEW_BUDGET');
        session.workFrames += frames; session.generationWorkFrames += frames;
      };
      debit(charged);
      const reader = runtime.decoder.open(verified.file, verified.probe!, {sourceInFrame: clip.sourceInFrame + segment.beginFrame - clip.startFrame,
        frameCount: segment.endFrame - segment.beginFrame, trimStartFrame: from - segment.beginFrame},
      {signal: session.controller.signal, beforeEffect: () => fenceSession(session), onDecodedBytes(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 1) throw fail('AUDIO_PREVIEW_INVALID_PCM');
        producedBytes += bytes;
        const next = Math.min(fullWork, prefix + 1 + reserve + Math.ceil(producedBytes / 12800));
        debit(next - charged); charged = next;
      }});
      cursor = {key, reader, nextFrame: from, endFrame: segment.endFrame}; session.cursors.set(clip.trackId, cursor);
      runtime.telemetry?.({type: 'decode', workFrames: session.workFrames, activeCursors: session.cursors.size});
    }
    const cancel = (): void => {void cursor?.reader.close().catch(error => {session.failure = error; admission.failure = error;});};
    signal.addEventListener('abort', cancel, {once: true});
    try {
      const pcm = await cursor.reader.read((to - from) * 1600); fenceSession(session, signal);
      if (!Buffer.isBuffer(pcm) || pcm.length !== (to - from) * 12800) throw fail('AUDIO_PREVIEW_INVALID_PCM');
      cursor.nextFrame = to;
      if (!verified.complete) {await hashAsset(session, verified, signal); verified.complete = true;}
      if (to === cursor.endFrame) {await cursor.reader.done; await cursor.reader.close(); session.cursors.delete(clip.trackId);}
      return pcm;
    } finally {signal.removeEventListener('abort', cancel);}
  }
  function mixPart(output: Buffer, pcm: Buffer, clip: Clip, from: number, to: number, blockStart: number): void {
    const voice: AudioPreviewVoice = {...clip, clipId: clip.id, sourceKey: '0'.repeat(64), fadeInFrames: clip.fadeInFrames ?? 0,
      fadeOutFrames: clip.fadeOutFrames ?? 0, intersectionStartFrame: from, intersectionEndFrame: to};
    const start = (from - clip.startFrame) * 1600, end = (to - clip.startFrame) * 1600;
    if (clip.volumeEnvelope != null) {
      const envelope = createVolumeEnvelopeEvaluator(clip);
      for (let sample = start; sample < end; sample++) {
        // Linear fade × linear automation is generally quadratic, not a ramp.
        const gain = audioPreviewEnvelopeGainAtLocalSample(voice, sample) * envelope.atSample(sample);
        const sourceOffset = (sample - start) * 8;
        const targetOffset = ((from - blockStart) * 1600 + sample - start) * 8;
        for (let channel = 0; channel < 2; channel++) {
          const offset = targetOffset + channel * 4;
          const value = output.readFloatLE(offset) + pcm.readFloatLE(sourceOffset + channel * 4) * gain;
          if (!Number.isFinite(Math.fround(value))) throw fail('AUDIO_PREVIEW_INVALID_PCM');
          output.writeFloatLE(value, offset);
        }
      }
      return;
    }
    const splits = [...new Set([start, end, voice.fadeInFrames * 1600, (clip.durationFrames - voice.fadeOutFrames) * 1600])]
      .filter(sample => sample >= start && sample <= end).sort((a, b) => a - b);
    for (let part = 0; part < splits.length - 1; part++) {
      const begin = splits[part]!, finish = splits[part + 1]!, count = finish - begin;
      const first = audioPreviewEnvelopeGainAtLocalSample(voice, begin), last = audioPreviewEnvelopeGainAtLocalSample(voice, finish);
      for (let sample = begin; sample < finish; sample++) {
        const gain = first + (last - first) * ((sample - begin) / count), sourceOffset = (sample - start) * 8;
        const targetOffset = ((from - blockStart) * 1600 + sample - start) * 8;
        for (let channel = 0; channel < 2; channel++) {
          const offset = targetOffset + channel * 4;
          const value = output.readFloatLE(offset) + pcm.readFloatLE(sourceOffset + channel * 4) * gain;
          if (!Number.isFinite(Math.fround(value))) throw fail('AUDIO_PREVIEW_INVALID_PCM');
          output.writeFloatLE(value, offset);
        }
      }
    }
  }
  async function consumeBlockWork<T>(raw: unknown, context: ConsumeOptions<T>): Promise<T> {
    runtime.assertOrdinaryWorkspace();
    if (!plain(raw, 4096)) throw fail('VALIDATION_ERROR', 400);
    const parsed = continuousAudioBlockInputSchema.safeParse(raw);
    if (!parsed.success || !context || typeof context.consume !== 'function') throw fail('VALIDATION_ERROR', 400);
    const input = parsed.data; available();
    if (context.signal?.aborted) throw fail('OPERATION_CANCELLED', 503);
    let session = admission.session;
    if (!session) {
      if (admission.retired.has(input.sessionId)) throw fail('AUDIO_PREVIEW_STALE');
      const initial = current(inputOf(input)); if (initial.plan.planHash !== input.planHash) throw fail('AUDIO_PREVIEW_STALE');
      if (input.blockStartFrame >= initial.plan.durationFrames) throw fail('AUDIO_PREVIEW_RANGE_BOUNDS');
      const controller = new AbortController();
      session = {id: input.sessionId, initial, controller, timer: setTimeout(() => {}, LIMITS.sessionTimeoutMs), generation: input.generation, requestedGeneration: input.generation, sequence: 0,
        nextFrame: input.blockStartFrame, cancelled: false, workFrames: 0, generationWorkFrames: 0, hashBytes: 0, hashes: new Map(), cursors: new Map()};
      clearTimeout(session.timer);
      const created = session;
      session.timer = setTimeout(() => {void retireSessionById(created.id).catch(error => {admission.failure = error;});}, LIMITS.sessionTimeoutMs);
      session.timer.unref?.(); admission.session = session;
    }
    const owned = session;
    if (owned.id !== input.sessionId || owned.closing || owned.initial.plan.planHash !== input.planHash ||
        input.projectId !== owned.initial.plan.projectId || input.timelineId !== owned.initial.plan.timelineId ||
        input.expectedRevision !== owned.initial.plan.timelineRevision || input.startFrame !== owned.initial.plan.startFrame ||
        input.sequence <= owned.sequence || input.generation < owned.requestedGeneration || input.blockStartFrame >= owned.initial.plan.durationFrames) throw fail('AUDIO_PREVIEW_STALE');
    owned.sequence = input.sequence; owned.requestedGeneration = input.generation;
    const previous = owned.active, token = {}; owned.latest = token;
    previous?.controller.abort();
    owned.pending?.controller.abort();
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, owned.controller.signal, context.signal].filter((value): value is AbortSignal => value !== undefined));
    const attempt: Attempt = {controller, token, task: Promise.resolve()};
    if (previous) owned.pending = attempt; else {owned.pending = undefined; owned.active = attempt;}
    const task = (async () => {
      if (previous) await new Promise<void>((resolve, reject) => {
        const released = (): void => {signal.removeEventListener('abort', cancelled); resolve();};
        const cancelled = (): void => {
          signal.removeEventListener('abort', cancelled);
          if (previous.releasePending === released) previous.releasePending = undefined;
          reject(fail('OPERATION_CANCELLED', 503));
        };
        signal.addEventListener('abort', cancelled, {once: true});
        // Exactly one waiter is retained by an active attempt. Replacing the
        // pending intent rejects it immediately and detaches this slot; it
        // cannot append another then-chain to non-cooperative active work.
        previous.releasePending = released;
        if (signal.aborted) cancelled();
      });
      if (owned.latest !== token) throw fail('OPERATION_CANCELLED', 503);
      if (owned.pending === attempt) owned.pending = undefined;
      owned.active = attempt;
      fenceSession(owned, signal);
      if (input.generation > owned.generation) {
        await closeCursors(owned); owned.generation = input.generation; owned.generationWorkFrames = 0;
        owned.nextFrame = input.blockStartFrame; owned.cancelled = false;
      }
      if (input.blockStartFrame !== owned.nextFrame) throw fail('AUDIO_PREVIEW_STALE');
      owned.active = attempt;
      const abortCursors = (): void => {for (const cursor of owned.cursors.values()) void cursor.reader.close().catch(error => {owned.failure = error; admission.failure = error;});};
      signal.addEventListener('abort', abortCursors, {once: true});
      const timer = setTimeout(() => controller.abort(), LIMITS.prepareTimeoutMs);
      const beforeEffect = (): void => {if (owned.latest !== token) throw fail('OPERATION_CANCELLED'); fenceSession(owned, signal);};
      try {
        beforeEffect();
        const startFrame = input.blockStartFrame, endFrame = Math.min(startFrame + 60, owned.initial.plan.durationFrames);
        // Eligibility is independent of audibility and block intersection. Verify
        // every automated source before allocating/publishing even silent output.
        for (const clip of owned.initial.envelopeClips) {
          beforeEffect();
          const verified = await verifiedAsset(owned, clip.assetId, signal);
          const asset = owned.initial.snapshot.assets.find(asset => asset.id === clip.assetId)!;
          assertVolumeEnvelopeSource(clip, {mimeType: asset.mimeType, audio: verified.probe ?? null});
          if (asset.hasAudio !== true) throw fail('AUDIO_PREVIEW_STALE');
          if (!verified.complete && !owned.initial.voices.some(voice => voice.assetId === clip.assetId &&
              voice.startFrame < endFrame && voice.startFrame + voice.durationFrames > startFrame)) {
            await hashAsset(owned, verified, signal); verified.complete = true;
          }
        }
        const pcm = Buffer.alloc((endFrame - startFrame) * 12800);
        for (const clip of owned.initial.voices) {
          const from = Math.max(startFrame, clip.startFrame), to = Math.min(endFrame, clip.startFrame + clip.durationFrames);
          if (from >= to) continue;
          for (const segment of owned.initial.segments) {
            if (segment.beginFrame < clip.startFrame || segment.endFrame > clip.startFrame + clip.durationFrames) continue;
            const begin = Math.max(from, segment.beginFrame), end = Math.min(to, segment.endFrame);
            if (begin >= end) continue;
            beforeEffect(); const part = await sourcePart(owned, clip, segment, begin, end, signal); beforeEffect();
            mixPart(pcm, part, clip, begin, end, startFrame);
          }
        }
        beforeEffect();
        const result = await context.consume({pcm}, {plan: owned.initial.plan, input, startFrame, endFrame,
          sampleFrames: (endFrame - startFrame) * 1600, signal, beforeEffect});
        beforeEffect(); owned.nextFrame = endFrame; owned.cancelled = false;
        runtime.telemetry?.({type: 'block', startFrame, endFrame, pcmBytes: pcm.length,
          pcmPeakBoundBytes: CONTINUOUS_AUDIO_PCM_ACCOUNTING.peakBoundBytes, hashBytes: owned.hashBytes, workFrames: owned.workFrames});
        return result;
      } catch (error) {
        owned.cancelled = true;
        await closeCursors(owned);
        if (uncertainty(error)) {owned.failure = error; admission.failure = error;}
        if (object(error) && typeof error.code === 'string' && (/^(?:VOLUME_ENVELOPE_|AUDIO_PREVIEW_|OPERATION_CANCELLED|RESTORE_|WORKSPACE_)/u.test(error.code))) throw error;
        if (uncertainty(error)) throw error;
        throw fail(signal.aborted ? 'OPERATION_CANCELLED' : 'AUDIO_PREVIEW_DECODE_FAILED');
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abortCursors);
        if (owned.active === attempt) owned.active = undefined;
      }
    })();
    const settledTask = task.catch(async error => {
      if (owned.active === attempt) {
        try {await closeCursors(owned);} finally {if (owned.active === attempt) owned.active = undefined;}
      }
      throw error;
    }).finally(() => {
      if (owned.active === attempt) owned.active = undefined;
      if (owned.pending === attempt) owned.pending = undefined;
      attempt.releasePending?.(); attempt.releasePending = undefined;
    });
    attempt.task = settledTask; settledTask.catch(() => {});
    return settledTask;
  }
  async function consumeBlock<T>(raw: unknown, context: ConsumeOptions<T>): Promise<T> {
    // Register the native resource gate BEFORE even the first source hash can
    // start. A failing registration must not leave untracked decoder effects.
    runtime.assertOrdinaryWorkspace();
    if (!context || typeof context.consume !== 'function' || context.onResourceSettlement !== undefined &&
        typeof context.onResourceSettlement !== 'function') throw fail('VALIDATION_ERROR', 400);
    let resolveResources!: () => void, rejectResources!: (error: unknown) => void;
    const resources = new Promise<void>((resolve, reject) => {resolveResources = resolve; rejectResources = reject;});
    resources.catch(() => {});
    try {context.onResourceSettlement?.(resources);} catch (error) {resolveResources(); throw error;}
    try {const result = await consumeBlockWork(raw, context); resolveResources(); return result;}
    catch (error) {
      if (uncertainty(error) || admission.failure) rejectResources(admission.failure ?? error); else resolveResources();
      throw error;
    }
  }
  async function retireSession(raw: unknown): Promise<void> {
    runtime.assertOrdinaryWorkspace();
    if (!plain(raw, 4096)) throw fail('VALIDATION_ERROR', 400);
    const parsed = continuousAudioBlockInputSchema.safeParse(raw);
    if (!parsed.success) throw fail('VALIDATION_ERROR', 400);
    available();
    const session = admission.session, input = parsed.data;
    if (session && (session.id !== input.sessionId || session.initial.plan.planHash !== input.planHash || session.initial.plan.projectId !== input.projectId ||
        session.initial.plan.timelineId !== input.timelineId || session.initial.plan.timelineRevision !== input.expectedRevision ||
        session.initial.plan.startFrame !== input.startFrame || input.sequence < session.sequence || input.generation < session.generation)) throw fail('AUDIO_PREVIEW_STALE');
    await retireSessionById(input.sessionId);
  }
  async function drain(): Promise<void> {
    stop();
    const session = admission.session;
    try {await runtime.boundedShutdown(session ? retireSessionById(session.id) : Promise.resolve(), 'AUDIO_PREVIEW_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (admission.failure) throw admission.failure;
  }
  return {handlers: {'timeline.audioPreview.continuousPlan': plan}, consumeBlock, retireSession, retireSessionById, drain,
    /** Trusted backend I/O gate for the legacy resource. */
    assertNoContinuousSession(): void {if (admission.session) throw fail('AUDIO_PREVIEW_BUSY', 429);}};
}
