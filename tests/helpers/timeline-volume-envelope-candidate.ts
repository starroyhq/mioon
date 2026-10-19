import {isProxy} from 'node:util/types';
import {isTimelineRecord, TIMELINE_RESPONSE_BYTES} from '../../packages/contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse} from '../../packages/contracts/src/timeline-acknowledgement.ts';
import {VOLUME_ENVELOPE_PROFILE, validateVolumeEnvelope, splitVolumeEnvelopeFields} from '../../packages/contracts/src/timeline-volume-envelope.ts';
import {captureVolumeEnvelopeCandidateIntent, volumeEnvelopeCandidateIntentDigest} from './timeline-volume-envelope-candidate-intent.ts';

/** Dormant, Node-only candidate evidence. No package export or production caller.
 * These pure checks perform no admission transaction, durable write, ownership
 * check, fresh media verification or playback activation. Legacy validators see
 * only detached projections; historical contracts themselves remain unchanged. */
const own = (value, key) => Object.hasOwn(value, key);
const encoder = new TextEncoder();
const fail = (message, code = 'INVALID_VOLUME_ENVELOPE_CANDIDATE_RECORD', details) => {
  throw Object.assign(new Error(message), {code, ...(details ? {details} : {})});
};
const same = (left, right) => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && same(left[key], right[key]));
};
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

// Arrays are permitted only at these typed record paths, not by a generic
// "allow arrays" switch. Points, tracks, clips and cues retain their own caps.
function arrayLimit(path) {
  if (path.length === 1 && path[0] === 'tracks') return 12;
  if (path.length === 1 && path[0] === 'clips') return 100;
  if (path.length === 2 && path[0] === 'subtitles' && path[1] === 'cues') return 100;
  if (path.length === 4 && path[0] === 'clips' && Number.isInteger(path[1]) && path[2] === 'volumeEnvelope' && path[3] === 'points') return 16;
  return null;
}
function detach(value, {timeline = false} = {}) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, path) {
    if (++nodes > 16384 || path.length > 12) fail('Candidate structure exceeds traversal limits.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail('Candidate numbers must have exact JSON identity.');
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > 8192 || !item.isWellFormed()) fail('Candidate string exceeds structural limits or is malformed Unicode.');
      return item;
    }
    // In particular, never invoke a Proxy's prototype, key or descriptor trap.
    if (typeof item !== 'object' || isProxy(item)) fail('Candidate requires ordinary data.');
    if (ancestors.has(item)) fail('Candidate data cannot be cyclic.');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('Candidate prototype is unsupported.');
    // Refuse oversized typed lists before enumerating their descriptors.
    let length;
    if (array) {
      const limit = timeline ? arrayLimit(path) : null;
      const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
      length = descriptor?.value;
      if (limit === null || !descriptor || !own(descriptor, 'value') || !Number.isInteger(length) || length < 0 || length > limit) fail('Array is not a bounded candidate list.');
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) fail('Candidate symbol fields are unsupported.');
    if (array ? keys.length !== length + 1 : keys.length > 64) fail('Candidate object has too many fields.');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    let result;
    if (array) {
      result = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail('Candidate lists cannot be sparse or accessor-backed.');
        result.push(visit(descriptor.value, [...path, index]));
      }
    } else {
      result = Object.create(null);
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !own(descriptor, 'value')) fail('Candidate fields must be enumerable data properties.');
        result[key] = visit(descriptor.value, [...path, key]);
      }
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, []);
}
function legacyProjection(timeline) {
  return {...timeline, clips: timeline.clips.map(clip => without(clip, ['volumeEnvelope']))};
}
function captureRecord(value, options) {
  const record = detach(value, {timeline: true});
  if (record === null || typeof record !== 'object' || !Array.isArray(record.clips)) fail('Candidate must be a complete timeline record.');
  for (const clip of record.clips) {
    if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) fail('Invalid candidate clip.');
    if (own(clip, 'volumeEnvelope')) validateVolumeEnvelope(clip.volumeEnvelope, clip.durationFrames);
  }
  const text = JSON.stringify(record), bytes = encoder.encode(text).byteLength;
  if (bytes > TIMELINE_RESPONSE_BYTES) fail('Complete candidate exceeds the unchanged timeline budget.', 'VOLUME_ENVELOPE_CANDIDATE_AGGREGATE_BUDGET', {bytes, maxBytes: TIMELINE_RESPONSE_BYTES});
  if (!isTimelineRecord(legacyProjection(record), options)) fail('Candidate fails the complete historical timeline contract.');
  return {record, text, bytes};
}
/** Detached capture suitable for a later admission boundary. A thrown size error
 * is not a not-applied receipt or proof that a transaction did not write. */
export function captureTimelineVolumeEnvelopeCandidateRecord(value, options = {}) {
  const checked = detach(options);
  if (checked === null || typeof checked !== 'object' || Object.keys(checked).some(key => key !== 'projectId')) fail('Unknown candidate record options.');
  return captureRecord(value, checked);
}
export function isTimelineVolumeEnvelopeCandidateRecord(value, options = {}) {
  try { captureTimelineVolumeEnvelopeCandidateRecord(value, options); return true; } catch { return false; }
}

/** Standalone candidate evidence shape, deliberately NOT a render/continuous
 * snapshot schema. Null and absent fields need no processing profile but retain
 * their exact field presence. A value requires exactly the one known profile. */
export function isTimelineVolumeEnvelopeCandidateSnapshot(value, options = {}) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (!own(descriptors, 'timeline') || keys.some(key => !['timeline', 'volumeEnvelopeProfile'].includes(key)) || keys.some(key => !descriptors[key].enumerable || !own(descriptors[key], 'value'))) return false;
    const {record} = captureTimelineVolumeEnvelopeCandidateRecord(descriptors.timeline.value, options);
    const required = record.clips.some(clip => own(clip, 'volumeEnvelope') && clip.volumeEnvelope !== null);
    if (own(descriptors, 'volumeEnvelopeProfile') !== required) return false;
    const complete = {timeline: record};
    if (required) {
      const profile = detach(descriptors.volumeEnvelopeProfile.value);
      if (profile === null || typeof profile !== 'object' || Object.keys(profile).length !== 1 || profile.profileId !== VOLUME_ENVELOPE_PROFILE) return false;
      complete.volumeEnvelopeProfile = profile;
    }
    return encoder.encode(JSON.stringify(complete)).byteLength <= TIMELINE_RESPONSE_BYTES;
  } catch { return false; }
}

const operations = new Set(['timeline.clip.add', 'timeline.clip.update', 'timeline.clip.replaceSource', 'timeline.clip.split', 'timeline.undo', 'timeline.redo']);
const addFields = ['assetId', 'trackId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope'];
const historyContent = value => without(value, ['revision', 'updatedAt']);
const unchangedMetadata = (before, after) => same(without(before, ['revision', 'updatedAt', 'durationFrames', 'clips']), without(after, ['revision', 'updatedAt', 'durationFrames', 'clips']));
function matchingAddition(clip, input, timeline) {
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
export function isTimelineVolumeEnvelopeCandidateMutationResponse(operation, input, value, context = {}) {
  try {
    if (!operations.has(operation)) return false;
    // Inspect context descriptors without reading a previous/history getter.
    if (context === null || typeof context !== 'object' || isProxy(context) || Array.isArray(context)) return false;
    const prototype = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(context), keys = Reflect.ownKeys(descriptors);
    if (!own(descriptors, 'previous') || keys.some(key => !['previous', 'expectedHistory'].includes(key)) || keys.some(key => !descriptors[key].enumerable || !own(descriptors[key], 'value'))) return false;
    const previous = captureRecord(descriptors.previous.value).record;
    const candidate = captureRecord(value, {projectId: previous.projectId}).record;
    let request;
    if (operation === 'timeline.clip.add') request = captureVolumeEnvelopeCandidateIntent(operation, input).input;
    else if (operation === 'timeline.clip.update') {
      // Read only a descriptor-checked scalar clip ID before resolving duration.
      if (input === null || typeof input !== 'object' || isProxy(input)) return false;
      const idDescriptor = Object.getOwnPropertyDescriptor(input, 'clipId');
      if (!idDescriptor || !idDescriptor.enumerable || !own(idDescriptor, 'value')) return false;
      const original = previous.clips.find(clip => clip.id === idDescriptor.value);
      if (!original) return false;
      request = captureVolumeEnvelopeCandidateIntent(operation, input, {durationFrames: original.durationFrames}).input;
    } else request = detach(input);
    if (request === null || typeof request !== 'object' || request.projectId !== previous.projectId || request.expectedRevision !== previous.revision || candidate.id !== previous.id) return false;
    const projectedRequest = operation === 'timeline.clip.add' ? without(request, ['volumeEnvelope']) : operation === 'timeline.clip.update' ? {...request, patch: without(request.patch, ['volumeEnvelope'])} : request;
    if (operation === 'timeline.clip.update' && Object.keys(projectedRequest.patch).length === 0) {
      // The historical ACK requires a nonempty patch. This exact no-op scalar
      // is solely an internal validator bridge and never changes the request.
      projectedRequest.patch = {gain: candidate.clips.find(clip => clip.id === request.clipId)?.gain};
    }
    if (!isTimelineMutationResponse(operation, projectedRequest, legacyProjection(candidate))) return false;
    if (operation === 'timeline.undo' || operation === 'timeline.redo') {
      if (!own(descriptors, 'expectedHistory')) return false;
      const expected = captureRecord(descriptors.expectedHistory.value, {projectId: request.projectId}).record;
      return same(historyContent(candidate), historyContent(expected));
    }
    if (own(descriptors, 'expectedHistory') || !unchangedMetadata(previous, candidate)) return false;
    if (operation === 'timeline.clip.add') {
      const oldIds = new Set(previous.clips.map(clip => clip.id));
      const added = candidate.clips.filter(clip => !oldIds.has(clip.id));
      return added.length === 1 && candidate.clips.length === previous.clips.length + 1 &&
        same(candidate.clips.filter(clip => oldIds.has(clip.id)), previous.clips) && matchingAddition(added[0], request, candidate);
    }
    const index = previous.clips.findIndex(clip => clip.id === request.clipId);
    if (index < 0) return false;
    const original = previous.clips[index], target = candidate.clips.find(clip => clip.id === request.clipId);
    if (!target) return false;
    if (operation === 'timeline.clip.update') {
      const expected = previous.clips.map((clip, i) => i === index ? {...clip, ...request.patch} : clip);
      return same(candidate.clips, expected);
    }
    if (operation === 'timeline.clip.replaceSource') {
      if (original.assetId === request.assetId) return false;
      const expectedTarget = {...without(original, ['versionId', 'shotId', 'jobId']), assetId: request.assetId};
      if (original.colour != null) expectedTarget.colour = {...original.colour, source: null};
      if (own(request, 'versionId')) Object.assign(expectedTarget, {versionId: request.versionId, shotId: target.shotId});
      return same(candidate.clips, previous.clips.map((clip, i) => i === index ? expectedTarget : clip));
    }
    const cut = request.atFrame - original.startFrame;
    if (cut < (original.fadeInFrames ?? 0) || cut > original.durationFrames - (original.fadeOutFrames ?? 0)) return false;
    const [leftEnvelope, rightEnvelope] = splitVolumeEnvelopeFields(original, cut);
    const left = {...without(original, ['volumeEnvelope']), ...leftEnvelope, durationFrames: cut};
    const rightActual = candidate.clips[index + 1];
    if (!rightActual || previous.clips.some(clip => clip.id === rightActual.id)) return false;
    const right = {...without(original, ['volumeEnvelope']), ...rightEnvelope, id: rightActual.id,
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
export function isTimelineVolumeEnvelopeCandidateMutationReceipt(operation, input, value, context = {}) {
  try {
    if (!['timeline.clip.add', 'timeline.clip.update'].includes(operation) ||
        value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    const fields = ['operation', 'projectId', 'requestId', 'inputDigest', 'result'];
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        keys.some(key => !descriptors[key].enumerable || !own(descriptors[key], 'value'))) return false;
    const shell = detach(Object.fromEntries(keys.filter(key => key !== 'result').map(key => [key, descriptors[key].value])));
    if (!isTimelineVolumeEnvelopeCandidateMutationResponse(operation, input, descriptors.result.value, context)) return false;
    // The ACK above has already safely validated input/context descriptors.
    // Recapture rather than read caller-owned properties or reuse aliases.
    const previous = captureRecord(Object.getOwnPropertyDescriptor(context, 'previous').value).record;
    let durationFrames;
    if (operation === 'timeline.clip.update') {
      const clipId = Object.getOwnPropertyDescriptor(input, 'clipId').value;
      durationFrames = previous.clips.find(clip => clip.id === clipId).durationFrames;
    }
    const intentContext = operation === 'timeline.clip.update' ? {durationFrames} : {};
    const captured = captureVolumeEnvelopeCandidateIntent(operation, input, intentContext);
    if (shell.operation !== operation || shell.projectId !== captured.input.projectId || shell.requestId !== captured.input.requestId ||
        shell.inputDigest !== volumeEnvelopeCandidateIntentDigest(operation, captured.input, intentContext)) return false;
    const result = captureRecord(descriptors.result.value, {projectId: captured.input.projectId}).record;
    return encoder.encode(JSON.stringify({...shell, result})).byteLength <= TIMELINE_RESPONSE_BYTES;
  } catch { return false; }
}
