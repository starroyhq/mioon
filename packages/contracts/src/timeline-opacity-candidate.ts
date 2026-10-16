/** Dormant, Node-only value admission. No package export, ledger, workspace,
 * mutation, render capability or execution authority is installed here. */
import {isProxy} from 'node:util/types';
import {OPACITY_ENVELOPE_LIMITS, validateOpacityEnvelope} from './timeline-opacity-envelope.ts';

type Value = Record<string, unknown>;
type Path = readonly (string | number)[];
export type OpacityCandidateOperation = 'timeline.clip.add' | 'timeline.clip.update';
export interface OpacityCandidateValidators {
  readonly isTimelineRecord: (value: unknown, options: {projectId?: unknown}) => boolean;
  readonly validateClipIntent: (operation: OpacityCandidateOperation, value: unknown) => boolean;
}
export interface OpacityCandidateContext {
  readonly trackKind: 'video' | 'audio';
  readonly durationFrames?: number;
}
export const OPACITY_CANDIDATE_LIMITS = Object.freeze({
  prepareNodes: 128, prepareDepth: 8, inputBytes: 8192, recordBytes: 262144,
});
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = (value: string): boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
function fail(code = 'INVALID_OPACITY_CANDIDATE'): never {
  throw Object.assign(new Error('Invalid dormant opacity-envelope candidate.'), {code});
}
type Mode = OpacityCandidateOperation | 'record' | 'context';
function arrayLimit(mode: Mode, path: Path): number | null {
  const fields = mode === 'timeline.clip.update' ? ['patch'] : [];
  if (mode === 'record') {
    if (path.length === 1 && path[0] === 'tracks') return 12;
    if (path.length === 1 && path[0] === 'clips') return 100;
    if (path.length === 2 && path[0] === 'subtitles' && path[1] === 'cues') return 100;
    if (path.length !== 4 || path[0] !== 'clips' || !Number.isInteger(path[1])) return null;
  } else if (mode === 'context' || path.length !== fields.length + 2 || fields.some((key, i) => key !== path[i])) return null;
  const field = path.at(-2);
  if (path.at(-1) !== 'points') return null;
  return field === 'opacityEnvelope' ? OPACITY_ENVELOPE_LIMITS.points : field === 'volumeEnvelope' ? 16 : null;
}
function detach(value: unknown, mode: Mode) {
  let nodes = 0, depth = 0;
  const ancestors = new Set<object>(), intent = mode.startsWith('timeline.');
  // prepare({projectId, operation, input, origin}) adds four nodes and one
  // level to the exact input. Account for that actual outer walker too.
  const maxNodes = intent ? 124 : mode === 'record' ? 16384 : 16;
  const maxDepth = intent ? 7 : mode === 'record' ? 12 : 2;
  function visit(item: unknown, path: Path): unknown {
    if (++nodes > maxNodes || path.length > maxDepth) fail('OPACITY_CANDIDATE_STRUCTURE_LIMIT');
    depth = Math.max(depth, path.length);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail();
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > 8192 || !wellFormed(item)) fail();
      return item;
    }
    if (typeof item !== 'object' || isProxy(item) || ancestors.has(item)) fail();
    const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    let length = 0;
    if (array) {
      const limit = arrayLimit(mode, path), descriptor = Object.getOwnPropertyDescriptor(item, 'length');
      const size: unknown = descriptor?.value;
      if (limit === null || !descriptor || !own(descriptor, 'value') || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > limit) fail();
      length = size;
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string' || key === '__proto__' || !wellFormed(key)) || (array ? keys.length !== length + 1 : keys.length > 64)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    let result: unknown[] | Value;
    if (array) {
      result = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
        result.push(visit(descriptor.value, [...path, index]));
      }
    } else {
      result = {};
      for (const key of keys) {
        if (typeof key !== 'string') fail();
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
        result[key] = visit(descriptor.value, [...path, key]);
      }
    }
    ancestors.delete(item);
    return result;
  }
  const captured = visit(value, []);
  return {value: captured, nodes, depth};
}

/** Trusted predicate injection avoids changing or importing any frozen legacy
 * constructor. Detached projections are verification-only; never store them.
 * This factory is not a substitute for future owned-workspace admission. */
export function createTimelineOpacityCandidateContracts(validators: OpacityCandidateValidators) {
  const {isTimelineRecord, validateClipIntent} = validators;
  if (typeof isTimelineRecord !== 'function' || typeof validateClipIntent !== 'function') fail();
  function captureIntent(operation: OpacityCandidateOperation, value: unknown, context: OpacityCandidateContext) {
    if (operation !== 'timeline.clip.add' && operation !== 'timeline.clip.update') fail();
    const checked = detach(context, 'context').value;
    if (!object(checked) || !['video', 'audio'].includes(String(checked.trackKind)) ||
        Object.keys(checked).some(key => key !== 'trackKind' && key !== 'durationFrames') ||
        own(checked, 'durationFrames') && (typeof checked.durationFrames !== 'number' || !Number.isSafeInteger(checked.durationFrames) || checked.durationFrames < 1 || checked.durationFrames > 18000)) fail();
    const captured = detach(value, operation), input = captured.value;
    if (!object(input)) fail();
    const fields = operation === 'timeline.clip.add' ? input : input.patch;
    if (!object(fields)) fail();
    if (own(fields, 'opacityEnvelope')) {
      if (checked.trackKind !== 'video') fail('OPACITY_CANDIDATE_VISUAL_REQUIRED');
      const duration = own(fields, 'durationFrames') ? fields.durationFrames : checked.durationFrames;
      if (fields.opacityEnvelope !== null) {
        if (typeof duration !== 'number') fail();
        validateOpacityEnvelope(fields.opacityEnvelope, duration);
      }
    }
    const projectedFields = {...fields};
    delete projectedFields.opacityEnvelope;
    // A curve-only update has no nonempty historical counterpart. This scalar
    // sentinel is used only to check the frozen input grammar, never returned.
    if (operation === 'timeline.clip.update' && own(fields, 'opacityEnvelope') && !Object.keys(projectedFields).length) projectedFields.gain = 0;
    const projection = operation === 'timeline.clip.add' ? projectedFields : {...input, patch: projectedFields};
    if (!validateClipIntent(operation, projection)) fail();
    const text = JSON.stringify(input), bytes = Buffer.byteLength(text);
    if (bytes > OPACITY_CANDIDATE_LIMITS.inputBytes) fail('OPACITY_CANDIDATE_INPUT_LIMIT');
    return {input, text, bytes, nodes: captured.nodes, depth: captured.depth,
      prepareNodes: captured.nodes + 4, prepareDepth: captured.depth + 1};
  }
  function captureRecord(value: unknown, options: {projectId?: unknown} = {}) {
    const checked = detach(options, 'context').value;
    if (!object(checked) || Object.keys(checked).some(key => key !== 'projectId')) fail();
    const record = detach(value, 'record').value;
    if (!object(record) || !Array.isArray(record.tracks) || !Array.isArray(record.clips)) fail();
    const tracks: unknown[] = record.tracks;
    const projectedClips = record.clips.map((clip: unknown) => {
      if (!object(clip)) fail();
      if (own(clip, 'opacityEnvelope')) {
        if (!tracks.some((track: unknown) => object(track) && track.id === clip.trackId && track.kind === 'video')) fail('OPACITY_CANDIDATE_VISUAL_REQUIRED');
        if (typeof clip.durationFrames !== 'number') fail();
        validateOpacityEnvelope(clip.opacityEnvelope, clip.durationFrames);
      }
      const projected = {...clip};
      delete projected.opacityEnvelope;
      return projected;
    });
    const text = JSON.stringify(record), bytes = Buffer.byteLength(text);
    if (bytes > OPACITY_CANDIDATE_LIMITS.recordBytes) fail('OPACITY_CANDIDATE_RECORD_LIMIT');
    if (!isTimelineRecord({...record, clips: projectedClips}, checked)) fail();
    return {record, text, bytes};
  }
  return Object.freeze({captureIntent, captureRecord});
}
