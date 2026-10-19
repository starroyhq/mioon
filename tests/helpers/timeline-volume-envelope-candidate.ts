import {isProxy} from 'node:util/types';
import {isTimelineRecord, TIMELINE_RESPONSE_BYTES} from '../../packages/contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse} from '../../packages/contracts/src/timeline-acknowledgement.ts';
import {VOLUME_ENVELOPE_PROFILE, validateVolumeEnvelope, splitVolumeEnvelopeFields} from '../../packages/contracts/src/timeline-volume-envelope.ts';
import {captureVolumeEnvelopeCandidateIntent, volumeEnvelopeCandidateIntentDigest} from './timeline-volume-envelope-candidate-intent.ts';

/** Dormant, Node-only candidate evidence. No package export or production caller.
 * These pure checks perform no admission transaction, durable write, ownership
 * check, fresh media verification or playback activation. Legacy validators see
 * only detached projections; historical contracts themselves remain unchanged. */
type DraftRecord = Record<string, unknown>;
type Path = (string|number)[];
const own = (value: unknown, key: PropertyKey): boolean => Object.hasOwn(value as object, key);
const encoder = new TextEncoder();
function fail(message: string, code = 'INVALID_VOLUME_ENVELOPE_CANDIDATE_RECORD', details?: unknown): never {
  throw Object.assign(new Error(message), {code, ...(details ? {details} : {})});
}
function wellFormed(value: string): boolean { for (let index=0;index<value.length;index++){const code=value.charCodeAt(index); if(code>=0xD800&&code<=0xDBFF){const next=value.charCodeAt(index+1); if(!(next>=0xDC00&&next<=0xDFFF))return false; index++;} else if(code>=0xDC00&&code<=0xDFFF)return false;} return true; }
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left as DraftRecord);
  return keys.length === Object.keys(right as DraftRecord).length && keys.every(key => own(right, key) && same((left as DraftRecord)[key], (right as DraftRecord)[key]));
};
const without = (value: DraftRecord, keys: readonly string[]): DraftRecord => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

// Arrays are permitted only at these typed record paths, not by a generic
// "allow arrays" switch. Points, tracks, clips and cues retain their own caps.
function arrayLimit(path: Path): number|null {
  if (path.length === 1 && path[0] === 'tracks') return 12;
  if (path.length === 1 && path[0] === 'clips') return 100;
  if (path.length === 2 && path[0] === 'subtitles' && path[1] === 'cues') return 100;
  if (path.length === 4 && path[0] === 'clips' && Number.isInteger(path[1]) && path[2] === 'volumeEnvelope' && path[3] === 'points') return 16;
  return null;
}
interface DetachRecord {clips: DraftRecord[]; id?: unknown; projectId?: unknown; revision?: unknown; [key: string]: unknown}
function detach(value: unknown, {timeline = false}: {timeline?: boolean} = {}): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, path: Path): unknown {
    if (++nodes > 16384 || path.length > 12) fail('Candidate structure exceeds traversal limits.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail('Candidate numbers must have exact JSON identity.');
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > 8192 || !wellFormed(item)) fail('Candidate string exceeds structural limits or is malformed Unicode.');
      return item;
    }
    // In particular, never invoke a Proxy's prototype, key or descriptor trap.
    if (typeof item !== 'object' || isProxy(item)) fail('Candidate requires ordinary data.');
    if (ancestors.has(item as object)) fail('Candidate data cannot be cyclic.');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('Candidate prototype is unsupported.');
    // Refuse oversized typed lists before enumerating their descriptors.
    let length = 0;
    if (array) {
      const limit = timeline ? arrayLimit(path) : null;
      const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
      length = Number(descriptor?.value);
      if (limit === null || !descriptor || !own(descriptor, 'value') || !Number.isInteger(length) || length < 0 || length > limit) fail('Array is not a bounded candidate list.');
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some((key: string|symbol) => typeof key !== 'string')) fail('Candidate symbol fields are unsupported.');
    if (array ? keys.length !== length + 1 : keys.length > 64) fail('Candidate object has too many fields.');
    const descriptors = Object.getOwnPropertyDescriptors(item) as Record<string, PropertyDescriptor>;
    ancestors.add(item as object);
    let result: unknown;
    if (array) {
      const list: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail('Candidate lists cannot be sparse or accessor-backed.');
        list.push(visit(descriptor.value, [...path, index]));
      }
      result = list;
    } else {
      const record: DraftRecord = Object.create(null) as DraftRecord;
      for (const key of keys) {
        const descriptor = descriptors[String(key)];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail('Candidate fields must be enumerable data properties.');
        record[String(key)] = visit(descriptor.value, [...path, String(key)]);
      }
      result = record;
    }
    ancestors.delete(item as object);
    return result;
  }
  return visit(value, []);
}
function legacyProjection(timeline: DetachRecord): DraftRecord {
  return {...timeline, clips: timeline.clips.map((clip: DraftRecord) => without(clip, ['volumeEnvelope']))};
}
function captureRecord(value: unknown, options?: DraftRecord): {record: DetachRecord; text: string; bytes: number} {
  const record = detach(value, {timeline: true}) as DetachRecord;
  if (record === null || typeof record !== 'object' || !Array.isArray(record.clips)) fail('Candidate must be a complete timeline record.');
  for (const clipValue of record.clips) {
    const clip = clipValue as DraftRecord;
    if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) fail('Invalid candidate clip.');
    if (own(clip, 'volumeEnvelope')) validateVolumeEnvelope(clip.volumeEnvelope, clip.durationFrames as number);
  }
  const text = JSON.stringify(record), bytes = encoder.encode(text).byteLength;
  if (bytes > TIMELINE_RESPONSE_BYTES) fail('Complete candidate exceeds the unchanged timeline budget.', 'VOLUME_ENVELOPE_CANDIDATE_AGGREGATE_BUDGET', {bytes, maxBytes: TIMELINE_RESPONSE_BYTES});
  if (!isTimelineRecord(legacyProjection(record), options as never)) fail('Candidate fails the complete historical timeline contract.');
  return {record, text, bytes};
}
/** Detached capture suitable for a later admission boundary. A thrown size error
 * is not a not-applied receipt or proof that a transaction did not write. */
export function captureTimelineVolumeEnvelopeCandidateRecord(value: unknown, options: DraftRecord = {}): {record: DetachRecord; text: string; bytes: number} {
  const checked = detach(options) as DraftRecord|null;
  if (checked === null || typeof checked !== 'object' || Object.keys(checked).some((key: string) => key !== 'projectId')) fail('Unknown candidate record options.');
  return captureRecord(value, checked);
}
export function isTimelineVolumeEnvelopeCandidateRecord(value: unknown, options: DraftRecord = {}): boolean {
  try { captureTimelineVolumeEnvelopeCandidateRecord(value, options); return true; } catch { return false; }
}

/** Standalone candidate evidence shape, deliberately NOT a render/continuous
 * snapshot schema. Null and absent fields need no processing profile but retain
 * their exact field presence. A value requires exactly the one known profile. */
export function isTimelineVolumeEnvelopeCandidateSnapshot(value: unknown, options: DraftRecord = {}): boolean {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, keys = Reflect.ownKeys(descriptors);
    if (!own(descriptors, 'timeline') || keys.some((key: string|symbol) => !['timeline', 'volumeEnvelopeProfile'].includes(String(key))) || keys.some((key: string|symbol) => !descriptors[String(key)]?.enumerable || !own(descriptors[String(key)]!, 'value'))) return false;
    const {record} = captureTimelineVolumeEnvelopeCandidateRecord(descriptors['timeline']!.value, options);
    const required = record.clips.some((clip: DraftRecord) => own(clip, 'volumeEnvelope') && clip.volumeEnvelope !== null);
    if (own(descriptors, 'volumeEnvelopeProfile') !== required) return false;
    const complete: DraftRecord = {timeline: record};
    if (required) {
      const profile = detach(descriptors['volumeEnvelopeProfile']!.value) as DraftRecord|null;
      if (profile === null || typeof profile !== 'object' || Object.keys(profile).length !== 1 || profile.profileId !== VOLUME_ENVELOPE_PROFILE) return false;
      complete.volumeEnvelopeProfile = profile;
    }
    return encoder.encode(JSON.stringify(complete)).byteLength <= TIMELINE_RESPONSE_BYTES;
  } catch { return false; }
}

const operations = new Set(['timeline.clip.add', 'timeline.clip.update', 'timeline.clip.replaceSource', 'timeline.clip.split', 'timeline.undo', 'timeline.redo']);
const addFields = ['assetId', 'trackId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope'];
const historyContent = (value: DraftRecord): DraftRecord => without(value, ['revision', 'updatedAt']);
const unchangedMetadata = (before: DraftRecord, after: DraftRecord): boolean => same(without(before, ['revision', 'updatedAt', 'durationFrames', 'clips']), without(after, ['revision', 'updatedAt', 'durationFrames', 'clips']));
function matchingAddition(clip: DraftRecord, input: DraftRecord, timeline: DraftRecord): boolean {
  return addFields.every(key => !own(input, key) || own(clip, key) && same(clip[key], input[key])) &&
    ['volumeEnvelope', 'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole'].every(key => own(input, key) === own(clip, key)) &&
    clip.sourceInFrame === (input.sourceInFrame ?? 0) && clip.gain === (input.gain ?? 1) &&
    same(clip.rect, input.rect ?? {x: 0, y: 0, width: timeline.width, height: timeline.height}) &&
    ['versionId', 'shotId', 'jobId'].every(key => !own(clip, key));
}
/** Payload/previous-record bound candidate ACK. `previous` is the original
 * pre-mutation record, not the latest timeline after Undo or later edits.
 * Undo/redo additionally require caller-owned `expectedHistory` content. This
 * validates payload semantics, not authority, source eligibility or receipt
 * provenance. A timeline has no requestId: two otherwise-identical requests
 * with distinct valid IDs cannot be distinguished here. Use the separate
 * candidate receipt shape below for exact request identity binding. */
interface StrictClip extends DraftRecord {id: string; durationFrames: number; startFrame: number; sourceInFrame: number; volumeEnvelope?: unknown; fadeInFrames?: number; fadeOutFrames?: number; colour?: DraftRecord|null; assetId?: unknown; shotId?: unknown}
interface StrictTimeline extends DraftRecord {id: string; projectId: string; revision: number; width: number; clips: StrictClip[]}
export function isTimelineVolumeEnvelopeCandidateMutationResponse(operation: string, input: unknown, value: unknown, context: DraftRecord = {}): boolean {
  try {
    if (!operations.has(operation)) return false;
    // Inspect context descriptors without reading a previous/history getter.
    if (context === null || typeof context !== 'object' || isProxy(context) || Array.isArray(context)) return false;
    const prototype = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(context) as Record<string, PropertyDescriptor>, keys = Reflect.ownKeys(descriptors);
    if (!own(descriptors, 'previous') || keys.some((key: string|symbol) => !['previous', 'expectedHistory'].includes(String(key))) || keys.some((key: string|symbol) => !descriptors[String(key)]?.enumerable || !own(descriptors[String(key)]!, 'value'))) return false;
    const previous = captureRecord(descriptors['previous']!.value).record as unknown as StrictTimeline;
    const candidate = captureRecord(value, {projectId: previous.projectId}).record as unknown as StrictTimeline;
    let request: DraftRecord;
    if (operation === 'timeline.clip.add') request = captureVolumeEnvelopeCandidateIntent(operation, input).input as DraftRecord;
    else if (operation === 'timeline.clip.update') {
      // Read only a descriptor-checked scalar clip ID before resolving duration.
      if (input === null || typeof input !== 'object' || isProxy(input)) return false;
      const idDescriptor = Object.getOwnPropertyDescriptor(input, 'clipId');
      if (!idDescriptor || !idDescriptor.enumerable || !own(idDescriptor, 'value')) return false;
      const original = previous.clips.find(clip => clip.id === idDescriptor.value);
      if (!original) return false;
      request = captureVolumeEnvelopeCandidateIntent(operation, input, {durationFrames: original.durationFrames}).input as DraftRecord;
    } else request = detach(input) as DraftRecord;
    if (request === null || typeof request !== 'object' || request.projectId !== previous.projectId || request.expectedRevision !== previous.revision || candidate.id !== previous.id) return false;
    const projectedRequest = operation === 'timeline.clip.add' ? without(request, ['volumeEnvelope']) : operation === 'timeline.clip.update' ? {...request, patch: without(request.patch as DraftRecord, ['volumeEnvelope'])} : request;
    if (operation === 'timeline.clip.update' && Object.keys(projectedRequest.patch as DraftRecord).length === 0) {
      // The historical ACK requires a nonempty patch. This exact no-op scalar
      // is solely an internal validator bridge and never changes the request.
      projectedRequest.patch = {gain: candidate.clips.find((clip: StrictClip) => clip.id === request.clipId)?.gain};
    }
    if (!isTimelineMutationResponse(operation, projectedRequest, legacyProjection(candidate))) return false;
    if (operation === 'timeline.undo' || operation === 'timeline.redo') {
      if (!own(descriptors, 'expectedHistory')) return false;
      const expected = captureRecord(descriptors['expectedHistory']!.value, {projectId: request.projectId}).record;
      return same(historyContent(candidate as DraftRecord), historyContent(expected as unknown as DraftRecord));
    }
    if (own(descriptors, 'expectedHistory') || !unchangedMetadata(previous, candidate)) return false;
    if (operation === 'timeline.clip.add') {
      const oldIds = new Set(previous.clips.map((clip: StrictClip) => clip.id));
      const added = candidate.clips.filter((clip: StrictClip) => !oldIds.has(clip.id));
      return added.length === 1 && candidate.clips.length === previous.clips.length + 1 &&
        same(candidate.clips.filter((clip: StrictClip) => oldIds.has(clip.id)), previous.clips) && matchingAddition(added[0]!, request, candidate);
    }
    const index = previous.clips.findIndex((clip: StrictClip) => clip.id === request.clipId);
    if (index < 0) return false;
    const original = previous.clips[index] as StrictClip, target = candidate.clips.find((clip: StrictClip) => clip.id === request.clipId);
    if (!target) return false;
    if (operation === 'timeline.clip.update') {
      const expected = previous.clips.map((clip: StrictClip, i: number) => i === index ? {...clip, ...(request.patch as DraftRecord)} : clip);
      return same(candidate.clips, expected);
    }
    if (operation === 'timeline.clip.replaceSource') {
      if (original.assetId === request.assetId) return false;
      const expectedTarget: DraftRecord = {...without(original, ['versionId', 'shotId', 'jobId']), assetId: request.assetId};
      if (original.colour != null) expectedTarget.colour = {...original.colour, source: null};
      if (own(request, 'versionId')) Object.assign(expectedTarget, {versionId: request.versionId, shotId: target.shotId});
      return same(candidate.clips, previous.clips.map((clip: StrictClip, i: number) => i === index ? expectedTarget : clip));
    }
    const cut = (request.atFrame as number) - original.startFrame;
    if (cut < (original.fadeInFrames ?? 0) || cut > original.durationFrames - (original.fadeOutFrames ?? 0)) return false;
    const [leftEnvelope, rightEnvelope] = splitVolumeEnvelopeFields(original as never, cut);
    const left: DraftRecord = {...without(original, ['volumeEnvelope']), ...(leftEnvelope as DraftRecord), durationFrames: cut};
    const rightActual = candidate.clips[index + 1];
    if (!rightActual || previous.clips.some((clip: StrictClip) => clip.id === rightActual.id)) return false;
    const right: DraftRecord = {...without(original, ['volumeEnvelope']), ...(rightEnvelope as DraftRecord), id: rightActual.id,
      startFrame: request.atFrame, durationFrames: original.durationFrames - cut,
      sourceInFrame: original.sourceInFrame + cut};
    // Historical still-image split semantics remain available only without
    // non-null automation. This is not a claim of source-audio verification.
    if (original.volumeEnvelope == null && original.sourceInFrame === 0 && rightActual.sourceInFrame === 0) right.sourceInFrame = 0;
    if (own(original, 'fadeInFrames')) right.fadeInFrames = 0;
    if (own(original, 'fadeOutFrames')) left.fadeOutFrames = 0;
    return same(candidate.clips, [...previous.clips.slice(0, index), left, right, ...previous.clips.slice(index + 1)]);
  } catch { return false; }
}

/** Separate dormant add/update receipt evidence, NOT the historical receipt
 * shape or proof of a durable transaction. Self-consistent caller data cannot
 * establish receipt provenance; a future ledger must retain and verify it. */
export function isTimelineVolumeEnvelopeCandidateMutationReceipt(operation: string, input: unknown, value: unknown, context: DraftRecord = {}): boolean {
  try {
    if (!['timeline.clip.add', 'timeline.clip.update'].includes(operation) ||
        value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, keys = Reflect.ownKeys(descriptors);
    const fields = ['operation', 'projectId', 'requestId', 'inputDigest', 'result'];
    if (keys.length !== fields.length || keys.some((key: string|symbol) => !fields.includes(String(key))) ||
        keys.some((key: string|symbol) => !descriptors[String(key)]?.enumerable || !own(descriptors[String(key)]!, 'value'))) return false;
    const shell = detach(Object.fromEntries(keys.filter((key: string|symbol) => key !== 'result').map((key: string|symbol) => [String(key), descriptors[String(key)]!.value]))) as DraftRecord;
    if (!isTimelineVolumeEnvelopeCandidateMutationResponse(operation, input, descriptors['result']!.value, context)) return false;
    // The ACK above has already safely validated input/context descriptors.
    // Recapture rather than read caller-owned properties or reuse aliases.
    const previous = captureRecord(Object.getOwnPropertyDescriptor(context, 'previous')!.value).record as unknown as StrictTimeline;
    let durationFrames: number|undefined;
    if (operation === 'timeline.clip.update') {
      const clipId = Object.getOwnPropertyDescriptor(input as object, 'clipId')!.value;
      durationFrames = previous.clips.find((clip: StrictClip) => clip.id === clipId)!.durationFrames;
    }
    const intentContext = operation === 'timeline.clip.update' ? {durationFrames: durationFrames as number} : {};
    const captured = captureVolumeEnvelopeCandidateIntent(operation, input, intentContext) as {input: DraftRecord}
    if (shell.operation !== operation || shell.projectId !== captured.input.projectId || shell.requestId !== captured.input.requestId ||
        shell.inputDigest !== volumeEnvelopeCandidateIntentDigest(operation, captured.input, intentContext)) return false;
    const result = captureRecord(descriptors['result']!.value, {projectId: captured.input.projectId}).record;
    return encoder.encode(JSON.stringify({...shell, result})).byteLength <= TIMELINE_RESPONSE_BYTES;
  } catch { return false; }
}
