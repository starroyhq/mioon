/** Dormant fixed render values only. A valid JSON plan grants no store,
 * invocation, worker, media-read or rendering authority. No production barrel
 * exports or consumers are installed by this module. */
import {createRequire} from 'node:module';
import {isProxy} from 'node:util/types';
import {captureOpacityTimelineRecord} from './timeline-opacity-persistence.ts';

export const OPACITY_RENDER_CANDIDATE_PROFILE = 'mioon-clip-opacity-render-v1';
export interface OpacityRenderCandidatePlanClip {
  readonly clipId: string; readonly trackId: string; readonly assetId: string; readonly assetSha256: string;
  readonly alphaMode: 'straight' | 'premultiplied';
}
export interface OpacityRenderCandidatePlan {
  readonly profileId: typeof OPACITY_RENDER_CANDIDATE_PROFILE;
  readonly clock: 'clip-local-30fps-integer-v1';
  readonly interpolation: 'linear-held-endpoints-v1';
  readonly membership: 'half-open-v1';
  readonly stage: 'post-normalize-pre-overlay-v1';
  readonly clips: readonly OpacityRenderCandidatePlanClip[];
}
type Value = Record<string, unknown>;
type Path = readonly string[];
type Predicate = (...args: unknown[]) => unknown;
const require = createRequire(import.meta.url), legacy: unknown = require('./index.mjs');
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wellFormed = (value: string): boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
function invalid(): never {throw Object.assign(new Error('Invalid dormant opacity render value.'), {code: 'INVALID_OPACITY_RENDER_CANDIDATE'});}
function fixed(name: string): Predicate {
  if (!object(legacy) || typeof legacy[name] !== 'function') return invalid();
  return legacy[name] as Predicate;
}
function arrayLimit(path: Path): number | null {
  const leaf = path[0] === 'snapshot' ? path.slice(1) : path;
  if (leaf.length === 1 && leaf[0] === 'assets') return 100;
  if (leaf.length === 2 && leaf[0] === 'timeline' && leaf[1] === 'tracks') return 12;
  if (leaf.length === 2 && leaf[0] === 'timeline' && leaf[1] === 'clips') return 100;
  if (leaf.length === 3 && leaf[0] === 'timeline' && leaf[1] === 'subtitles' && leaf[2] === 'cues') return 100;
  if (leaf.length === 2 && ['colourPlan', 'opacityPlan'].includes(leaf[0]!) && leaf[1] === 'clips') return 100;
  if (leaf.length === 5 && leaf[0] === 'timeline' && leaf[1] === 'clips' && /^(?:0|[1-9][0-9]*)$/u.test(leaf[2]!) && leaf[4] === 'points')
    return leaf[3] === 'opacityEnvelope' ? 7 : leaf[3] === 'volumeEnvelope' ? 16 : null;
  if (path.length === 3 && path[0] === 'audioCheck' && path[1] === 'measurement' && path[2] === 'channelPeaks') return 2;
  return null;
}
function detach(value: unknown): unknown {
  let nodes = 0, strings = 0; const ancestors = new Set<object>();
  function visit(item: unknown, path: Path): unknown {
    if (++nodes > 32768 || path.length > 16) invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {if (!Number.isFinite(item) || Object.is(item, -0)) invalid();return item;}
    if (typeof item === 'string') {
      strings += Buffer.byteLength(item);
      if (item.length > 8192 || strings > 4 * 1024 * 1024 || !wellFormed(item)) invalid();
      return item;
    }
    if (typeof item !== 'object' || isProxy(item) || ancestors.has(item)) return invalid();
    const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item as object), keys = Reflect.ownKeys(descriptors);
    let length = 0;
    if (array) {
      const limit = arrayLimit(path), size: unknown = descriptors.length?.value;
      if (limit === null || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > limit || keys.length !== size + 1) invalid();
      length = size;
    } else if (keys.length > 64) invalid();
    ancestors.add(item);
    let result: unknown[] | Value;
    if (array) {
      result = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        result.push(visit(descriptor.value, [...path, String(index)]));
      }
    } else {
      result = {};
      for (const key of keys) {
        if (typeof key !== 'string' || key === '__proto__' || !wellFormed(key)) invalid();
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        result[key] = visit(descriptor.value, [...path, key]);
      }
    }
    ancestors.delete(item);return result;
  }
  return visit(value, []);
}
function snapshotProjection(snapshot: Value): Value {
  if (!object(snapshot.timeline) || !Array.isArray(snapshot.timeline.clips)) invalid();
  const result: Value = {...snapshot, timeline: {...snapshot.timeline, clips: snapshot.timeline.clips.map((clip: unknown) => {
    if (!object(clip)) invalid();const result = {...clip};delete result.opacityEnvelope;return result;
  })}};
  delete result.opacityPlan;
  return result;
}
function renderInput(value: unknown, backendIds: boolean): Value {
  const input = detach(value);
  if (!object(input) || !object(legacy) || !object(legacy.schemas)) invalid();
  const allowed = ['projectId', 'requestId', 'expectedRevision', 'purpose', 'exportSettings', 'deliveryName', 'exportRange', 'preflightSnapshotHash', ...(backendIds ? ['timelineId', 'exportId'] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid();
  const projection = {...input};delete projection.timelineId;delete projection.exportId;
  const schema = legacy.schemas['timeline.render'];
  if (!object(schema) || typeof schema.safeParse !== 'function') invalid();
  const parsed: unknown = (schema.safeParse as Predicate)(projection);
  if (!object(parsed) || parsed.success !== true) invalid();
  return input;
}
/** Exact existing render request grammar. No effect plan, flag or validator is
 * accepted from the caller; the stored timeline supplies opacity parameters. */
export function captureOpacityRenderInput(value: unknown): Value {return renderInput(value, false);}

function planned(snapshot: Value): OpacityRenderCandidatePlan | undefined {
  if (!object(snapshot.timeline) || !Array.isArray(snapshot.timeline.clips) || !Array.isArray(snapshot.assets)) invalid();
  const clips: OpacityRenderCandidatePlanClip[] = [];
  for (const clip of snapshot.timeline.clips) {
    if (!object(clip)) invalid();
    if (!own(clip, 'opacityEnvelope') || clip.opacityEnvelope === null) continue;
    const asset: unknown = snapshot.assets.find((item: unknown) => object(item) && item.id === clip.assetId);
    if (!object(asset) || typeof clip.id !== 'string' || typeof clip.trackId !== 'string' || typeof clip.assetId !== 'string' || typeof asset.sha256 !== 'string') invalid();
    const colours = object(snapshot.colourPlan) && Array.isArray(snapshot.colourPlan.clips) ? snapshot.colourPlan.clips : [];
    const premultiplied = colours.some((item: unknown) => object(item) && item.clipId === clip.id && item.kind === 'image');
    clips.push(Object.freeze({clipId: clip.id, trackId: clip.trackId, assetId: clip.assetId, assetSha256: asset.sha256, alphaMode: premultiplied ? 'premultiplied' : 'straight'}));
  }
  return clips.length ? Object.freeze({profileId: OPACITY_RENDER_CANDIDATE_PROFILE, clock: 'clip-local-30fps-integer-v1', interpolation: 'linear-held-endpoints-v1', membership: 'half-open-v1', stage: 'post-normalize-pre-overlay-v1', clips: Object.freeze(clips)}) : undefined;
}
function checkSnapshot(snapshot: unknown, purpose: 'preview' | 'export', requirePlan: boolean): {snapshot: Value; plan: OpacityRenderCandidatePlan | undefined} {
  if (!object(snapshot) || !object(snapshot.timeline)) invalid();
  captureOpacityTimelineRecord(snapshot.timeline);
  const plan = planned(snapshot), projection = snapshotProjection(snapshot);
  // A fixed historical complete render validator checks asset uniqueness,
  // exact used IDs, source ranges, subtitles, delivery/range/name and audio.
  // Its projection is never returned as the frozen render snapshot.
  const input: Value = {projectId: snapshot.timeline.projectId, requestId: 'opacity-snapshot-validation', expectedRevision: snapshot.timeline.revision, purpose};
  for (const field of ['deliveryName', 'exportRange']) if (own(snapshot, field)) input[field] = snapshot[field];
  if (object(snapshot.delivery)) input.exportSettings = snapshot.delivery.exportSettings;
  const record = {id: '00000000-0000-4000-8000-000000000000', projectId: input.projectId, requestId: input.requestId,
    mode: 'timeline', purpose, timelineRevision: input.expectedRevision, snapshot: projection, status: 'queued', assetId: null, url: null,
    error: null, createdAt: snapshot.timeline.createdAt, updatedAt: snapshot.timeline.updatedAt};
  if (fixed('isTimelineRenderRecord')(record, input) !== true) invalid();
  if (requirePlan && (own(snapshot, 'opacityPlan') !== (plan !== undefined) || plan !== undefined && !same(snapshot.opacityPlan, plan))) invalid();
  if (!requirePlan && own(snapshot, 'opacityPlan') && !same(snapshot.opacityPlan, plan)) invalid();
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 262144) invalid();
  return {snapshot, plan};
}
function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
  return object(left) && object(right) ? Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => own(right, key) && same(left[key], right[key])) : left === right;
}
/** Derive the algorithm/identity plan from complete detached values. Curves
 * remain solely in the raw timeline, avoiding a second drifting parameter copy. */
export function createOpacityRenderSnapshotPlan(value: unknown, purpose: 'preview' | 'export' = 'export'): OpacityRenderCandidatePlan | undefined {
  if (purpose !== 'preview' && purpose !== 'export') invalid();
  return checkSnapshot(detach(value), purpose, false).plan;
}
export function captureOpacityRenderSnapshot(value: unknown, purpose: 'preview' | 'export' = 'export'): {snapshot: Value; plan: OpacityRenderCandidatePlan | undefined} {
  if (purpose !== 'preview' && purpose !== 'export') invalid();
  return checkSnapshot(detach(value), purpose, true);
}
/** Preparation-only projection for unchanged source hash/probe helpers. It is
 * not a render input or proof that opacity was compiled or executed. */
export function captureOpacityPreparedSourceProjection(value: unknown, purpose: 'preview' | 'export' = 'export'): {snapshot: Value; sourceValidationSnapshot: Value} {
  const {snapshot} = captureOpacityRenderSnapshot(value, purpose);
  return {snapshot, sourceValidationSnapshot: snapshotProjection(snapshot)};
}
/** Complete queued/progressed ACK grammar. Caller/backend IDs, source metadata,
 * status and frozen opacity presence remain bound by the original raw values. */
export function isOpacityRenderRecord(value: unknown, input: unknown): boolean {
  try {
    const submitted = renderInput(input, true), record = detach(value);
    if (!object(record) || !['preview', 'export'].includes(String(submitted.purpose))) return false;
    const captured = checkSnapshot(record.snapshot, submitted.purpose as 'preview' | 'export', true);
    if (Buffer.byteLength(JSON.stringify(record)) > 4 * 1024 * 1024) return false;
    return fixed('isTimelineRenderRecord')({...record, snapshot: snapshotProjection(captured.snapshot)}, submitted) === true;
  } catch {return false;}
}
