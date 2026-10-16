/** Fixed, data-only opacity persistence grammar. Historical validators remain
 * closed: projections are used only for checking and are never returned. */
import {createRequire} from 'node:module';
import {isProxy} from 'node:util/types';
import {createTimelineOpacityCandidateContracts, type OpacityCandidateContext, type OpacityCandidateOperation} from './timeline-opacity-candidate.ts';

type Value = Record<string, unknown>;
type Predicate = (...args: unknown[]) => unknown;
const require = createRequire(import.meta.url);
const legacy: unknown = require('./index.mjs');
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const wellFormed = (value: string): boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
function fail(): never {throw Object.assign(new Error('Invalid opacity persistence value.'), {code: 'INVALID_OPACITY_CANDIDATE'});}
function fn(name: string): Predicate {
  if (!object(legacy) || typeof legacy[name] !== 'function') return fail();
  return legacy[name] as Predicate;
}
// Retain the concrete legacy parser functions once. Neither user data nor
// later replacement of an exported schema-map slot can select a validator.
const parsers = new Map<string, Predicate>();
if (!object(legacy) || !object(legacy.schemas)) fail();
for (const [operation, selected] of Object.entries(legacy.schemas)) {
  if (!object(selected) || typeof selected.safeParse !== 'function') fail();
  parsers.set(operation, (selected.safeParse as Predicate).bind(selected));
}
function schema(operation: string, value: unknown): boolean {
  const parse = parsers.get(operation);
  if (!parse) return false;
  const result: unknown = parse(value);
  return object(result) && result.success === true;
}
const fixed = createTimelineOpacityCandidateContracts({
  isTimelineRecord: (value, options) => fn('isTimelineRecord')(value, options) === true,
  validateClipIntent: (operation, value) => schema(operation, value),
});

/** Descriptor capture is also used for the complete prepare shell. Each array
 * permission is a typed leaf; no general array or getter admission is added. */
function capture(value: unknown, maxNodes = 128, maxDepth = 8, root: readonly string[] = []) {
  let nodes = 0, depth = 0;
  const parents = new Set<object>();
  function visit(item: unknown, path: readonly string[]): unknown {
    if (++nodes > maxNodes || path.length > maxDepth) fail();
    depth = Math.max(depth, path.length);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {if (!Number.isFinite(item) || Object.is(item, -0)) fail(); return item;}
    if (typeof item === 'string') {if (item.length > 16384 || !wellFormed(item)) fail(); return item;}
    if (typeof item !== 'object' || isProxy(item) || parents.has(item)) return fail();
    const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item);
    parents.add(item);
    let result: unknown[] | Value;
    if (array) {
      const leaf = [...root, ...path].join('.');
      const limit = /^(?:input\.)?(?:patch\.)?opacityEnvelope\.points$/.test(leaf) ? 7 : /^(?:input\.)?(?:patch\.)?volumeEnvelope\.points$/.test(leaf) ? 16 : 0;
      const length: unknown = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || typeof length !== 'number' || length < 1 || length > limit || keys.length !== length + 1) fail();
      result = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !own(descriptor, 'value')) fail();
        result.push(visit(descriptor.value, [...path, String(index)]));
      }
    } else {
      result = {};
      if (keys.length > 64) fail();
      for (const key of keys) {
        if (typeof key !== 'string' || key === '__proto__' || !wellFormed(key)) fail();
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !own(descriptor, 'value')) fail();
        result[key] = visit(descriptor.value, [...path, key]);
      }
    }
    parents.delete(item);return result;
  }
  const captured = visit(value, []);
  return {value: captured, nodes, depth};
}
const defaultContext: OpacityCandidateContext = Object.freeze({trackKind: 'video', durationFrames: 18000});
export function captureOpacityTimelineRecord(value: unknown, options: {projectId?: unknown} = {}) {
  return fixed.captureRecord(value, options);
}
export function captureOpacityTimelineIntent(operation: string, value: unknown, context: OpacityCandidateContext = defaultContext) {
  if (operation === 'timeline.clip.add' || operation === 'timeline.clip.update') {
    const result = fixed.captureIntent(operation, value, context);
    if (!object(result.input)) return fail();
    return {...result, input: result.input};
  }
  const result = capture(value, 124, 7);
  if (!object(result.value) || !schema(operation, result.value)) return fail();
  const text = JSON.stringify(result.value), bytes = Buffer.byteLength(text);
  if (bytes > 8192) fail();
  return {input: result.value, text, bytes, nodes: result.nodes, depth: result.depth, prepareNodes: result.nodes + 4, prepareDepth: result.depth + 1};
}
export function captureOpacityTimelinePrepare(value: unknown) {
  const captured = capture(value);
  if (!object(captured.value) || Object.keys(captured.value).length !== 4 || !['projectId', 'operation', 'input', 'origin'].every(key => own(captured.value as object, key))) return fail();
  const args = captured.value;
  if (typeof args.operation !== 'string' || !['timeline.clip.update', 'timeline.undo', 'timeline.redo'].includes(args.operation) || !['new', 'legacy_session'].includes(String(args.origin))) return fail();
  const intent = captureOpacityTimelineIntent(args.operation, args.input);
  if (intent.input.projectId !== args.projectId) fail();
  return {...args, input: intent.input};
}

function projection(record: Value): Value {
  if (!Array.isArray(record.clips)) return fail();
  return {...record, clips: record.clips.map((clip: unknown) => {
    if (!object(clip)) return fail();
    const result = {...clip};delete result.opacityEnvelope;return result;
  })};
}
function intentProjection(operation: OpacityCandidateOperation, input: Value, sentinel = 0): Value {
  const fields = operation === 'timeline.clip.update' ? input.patch : input;
  if (!object(fields)) return fail();
  const result = {...fields};delete result.opacityEnvelope;
  if (operation === 'timeline.clip.update' && !Object.keys(result).length) result.gain = sentinel;
  return operation === 'timeline.clip.update' ? {...input, patch: result} : result;
}
function sameEnvelope(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (!object(left) || !object(right) || left.profileId !== right.profileId || !Array.isArray(left.points) || !Array.isArray(right.points) || left.points.length !== right.points.length) return false;
  const points = right.points;
  return left.points.every((point: unknown, index: number) => object(point) && object(points[index]) && point.frame === points[index].frame && point.opacity === points[index].opacity);
}
export function isOpacityTimelineMutationResponse(operation: string, input: unknown, value: unknown): boolean {
  try {
    if (!['timeline.clip.update', 'timeline.undo', 'timeline.redo'].includes(operation)) return fn('isTimelineMutationResponse')(operation, input, value) === true;
    const record = captureOpacityTimelineRecord(value).record;
    if (!object(record)) return false;
    const submitted = captureOpacityTimelineIntent(operation, input).input;
    const projectedRecord = projection(record);
    if (operation !== 'timeline.clip.update') return fn('isTimelineMutationResponse')(operation, submitted, projectedRecord) === true;
    if (!Array.isArray(record.clips) || !object(submitted.patch)) return false;
    const target: unknown = record.clips.find((clip: unknown) => object(clip) && clip.id === submitted.clipId);
    if (!object(target) || typeof target.gain !== 'number') return false;
    // A same-request response must retain the exact submitted field, including
    // null. Other old fields are checked by the fixed historical ACK grammar.
    if (own(submitted.patch, 'opacityEnvelope') && (!own(target, 'opacityEnvelope') || !sameEnvelope(target.opacityEnvelope, submitted.patch.opacityEnvelope))) return false;
    return fn('isTimelineMutationResponse')(operation, intentProjection(operation, submitted, target.gain), projectedRecord) === true;
  } catch {return false;}
}
export function isOpacityTimelineTask(value: unknown): boolean {
  try {
    // Capture the entire public task through descriptors before reading its
    // payload. Its row budget remains independent from the 128-node intent.
    const taskCapture = capture(value, 256, 10), task = taskCapture.value;
    if (!object(task) || typeof task.operation !== 'string') return false;
    if (!['timeline.clip.update', 'timeline.undo', 'timeline.redo'].includes(task.operation)) return fn('isEditTask')(task) === true;
    const intent = captureOpacityTimelineIntent(task.operation, task.input);
    if (Buffer.byteLength(JSON.stringify(task)) > 16384) return false;
    const projectedInput = task.operation === 'timeline.clip.update' ? intentProjection(task.operation, intent.input) : intent.input;
    return fn('isEditTask')({...task, input: projectedInput}) === true;
  } catch {return false;}
}
