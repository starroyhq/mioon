/** Narrow production extraction of the former candidate record guard. This
 * validates detached ordinary data, not ownership or execution authority.
 * The complete historical contract is supplied by trusted runtime assembly. */
import {isProxy} from 'node:util/types';
import {validateVolumeEnvelope} from './timeline-volume-envelope.ts';

type Value = Record<string, unknown>;
type Path = (string | number)[];
export type TimelineRecordPredicate = (value: unknown, options?: {projectId?: unknown}) => boolean;
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never {throw new Error('Invalid volume-envelope record structure.');}
const wellFormed = (value: string): boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
const RECORD_BYTES = 256 * 1024;

// Arrays remain permitted only at these exact typed paths.
function arrayLimit(path: Path): number | null {
  if (path.length === 1 && path[0] === 'tracks') return 12;
  if (path.length === 1 && path[0] === 'clips') return 100;
  if (path.length === 2 && path[0] === 'subtitles' && path[1] === 'cues') return 100;
  if (path.length === 4 && path[0] === 'clips' && Number.isInteger(path[1]) && path[2] === 'volumeEnvelope' && path[3] === 'points') return 16;
  return null;
}
function detach(value: unknown, timeline = false): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, path: Path): unknown {
    if (++nodes > 16384 || path.length > 12) fail();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail();
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > 8192 || !wellFormed(item)) fail();
      return item;
    }
    // Proxy checks precede all prototype, key and descriptor operations.
    if (typeof item !== 'object' || isProxy(item)) fail();
    if (ancestors.has(item)) fail();
    const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    let length = 0;
    if (array) {
      const limit = timeline ? arrayLimit(path) : null;
      const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
      const size: unknown = descriptor?.value;
      if (limit === null || !descriptor || !own(descriptor, 'value') || typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > limit) fail();
      length = size;
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) fail();
    if (array ? keys.length !== length + 1 : keys.length > 64) fail();
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
      const record: Value = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') fail();
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
        record[key] = visit(descriptor.value, [...path, key]);
      }
      result = record;
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, []);
}

/** Preserve the former record guard's structural rejection before invoking the
 * actual historical validator. Options are detached too, so this helper cannot
 * launder hostile accessors into a trusted validator. Missing dependency closes. */
export function isTimelineVolumeEnvelopeRecord(value: unknown, options: {projectId?: unknown}, isTimelineRecord: TimelineRecordPredicate): boolean {
  try {
    if (typeof isTimelineRecord !== 'function') return false;
    const checked = detach(options);
    if (!object(checked) || Object.keys(checked).some(key => key !== 'projectId')) return false;
    const record = detach(value, true);
    if (!object(record) || !Array.isArray(record.clips)) return false;
    for (const clip of record.clips) {
      if (!object(clip)) return false;
      if (own(clip, 'volumeEnvelope')) {
        if (typeof clip.durationFrames !== 'number') return false;
        validateVolumeEnvelope(clip.volumeEnvelope, clip.durationFrames);
      }
    }
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > RECORD_BYTES) return false;
    const projected = {...record, clips: record.clips.map((clip: Value) => Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'volumeEnvelope')))};
    return isTimelineRecord(projected, checked);
  } catch {return false;}
}
