/** Fixed internal bridge between the owned candidate export attempt and the
 * existing shared renderer. Portable JSON plans never enter this registry. */
import {isProxy} from 'node:util/types';
import {captureOpacityPreparedSourceProjection} from '../../contracts/src/timeline-opacity-render-candidate.ts';
import {opacityEnvelopeFieldsAfterEdit} from '../../contracts/src/timeline-opacity-envelope.ts';
import type {OpacityEnvelopeClip} from '../../contracts/src/timeline-opacity-envelope.ts';
import {compileTimelineOpacityFilterCandidate} from './timeline-opacity-filter-candidate.ts';
import type {TimelineOpacityAlphaModeCandidate} from './timeline-opacity-filter-candidate.ts';
import {createOpacityCandidateRenderAttempt, assertOpacityCandidateRenderAttempt} from './opacity-candidate-render-authority.ts';

type Value = Record<string, unknown>;
interface Clip extends OpacityEnvelopeClip {
  readonly startFrame: number;
  readonly alphaMode: TimelineOpacityAlphaModeCandidate;
}
export interface TimelineOpacityRenderBinding {
  /** Detached and recursively frozen. Only fixed legacy validators receive it;
   * the renderer retains the exact bound raw snapshot and its original hash. */
  readonly validationSnapshot: Readonly<Value>;
  /** Fixed owned project reader from the authority's actual preparation. */
  readonly readLut: unknown;
  /** Candidate media always uses the same lifetime as its owned attempt. */
  readonly signal: AbortSignal | undefined;
  readonly assert: () => void;
  /** Always retains the trusted attempt/source checks around any worker fence. */
  readonly effectFence: (additional?: () => void) => () => void;
  /** Raw fixed compiler stage, without a leading comma or caller graph labels. */
  readonly filterForSegment: (clipId: string, beginFrame: number, frameCount: number, alphaMode: TimelineOpacityAlphaModeCandidate) => string;
  readonly close: () => void;
}
interface Entry {
  readonly binding: Readonly<TimelineOpacityRenderBinding>;
  readonly preparedAssets: unknown;
  readonly assert: () => void;
}
const bindings = new WeakMap<object, Entry>();
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
function unavailable(): never {
  throw Object.assign(new Error('This opacity render snapshot has no live owned export attempt.'), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Inspect own data descriptors only. Accessors/proxies cannot conceal a new
 * effect field or run user code while the renderer checks the capability. */
function hasOpacityFields(snapshot: Value): boolean {
  if (isProxy(snapshot)) return unavailable();
  if (own(snapshot, 'opacityPlan')) return true;
  const timeline = Object.getOwnPropertyDescriptor(snapshot, 'timeline');
  if (!timeline) return false;
  if (!own(timeline, 'value')) return unavailable();
  if (!object(timeline.value)) return false;
  if (isProxy(timeline.value)) return unavailable();
  const clips = Object.getOwnPropertyDescriptor(timeline.value, 'clips');
  if (!clips) return false;
  if (!own(clips, 'value')) return unavailable();
  const list: unknown = clips.value;
  if (!Array.isArray(list)) return false;
  if (isProxy(list)) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(list);
  const length: unknown = Object.getOwnPropertyDescriptor(list, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 100) return unavailable();
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !own(descriptor, 'value')) return unavailable();
    const clip: unknown = descriptor.value;
    if (object(clip)) {
      if (isProxy(clip)) return unavailable();
      if (own(clip, 'opacityEnvelope')) return true;
    }
  }
  return false;
}

/** A copied/deserialized/raw snapshot cannot mint capability. Even explicit
 * null is a candidate field, so it cannot silently fall through legacy render.
 * A bound snapshot also requires the exact privately prepared Map that the
 * renderer will consume; copying it or substituting paths grants no access.
 * Old ordinary snapshots return null and contribute exactly zero filter bytes.
 */
export function getTimelineOpacityRenderBinding(snapshot: unknown, preparedAssets?: unknown): Readonly<TimelineOpacityRenderBinding> | null {
  if (!object(snapshot)) return null;
  const entry = bindings.get(snapshot);
  if (entry) {
    if (preparedAssets !== entry.preparedAssets) return unavailable();
    entry.assert(); return entry.binding;
  }
  if (hasOpacityFields(snapshot)) return unavailable();
  return null;
}

/** The fixed authority module independently verifies the exact registered
 * store, current export/receipt/origin and privately prepared source Map. No
 * caller callback, supplied validator or JSON receipt can supply that proof. */
export function bindTimelineOpacityRenderAttempt(
  store: unknown,
  exportRecord: unknown,
  preparedAssets: unknown,
  options: {readonly signal?: AbortSignal} = {},
): Readonly<TimelineOpacityRenderBinding> {
  const attempt = createOpacityCandidateRenderAttempt(store, exportRecord, preparedAssets, options);
  try {
    assertOpacityCandidateRenderAttempt(attempt);
    const snapshot: unknown = attempt.snapshot;
    if (!object(snapshot) || bindings.has(snapshot) || !object(exportRecord) ||
        exportRecord.snapshot !== snapshot || exportRecord.purpose !== 'preview' && exportRecord.purpose !== 'export') return unavailable();
    const prepared = captureOpacityPreparedSourceProjection(snapshot, exportRecord.purpose);
    if (!object(prepared.snapshot.timeline) || !Array.isArray(prepared.snapshot.timeline.clips)) return unavailable();
    const clips = new Map<string, Readonly<Clip>>();
    const colours = object(prepared.snapshot.colourPlan) && Array.isArray(prepared.snapshot.colourPlan.clips)
      ? prepared.snapshot.colourPlan.clips : [];
    for (const raw of prepared.snapshot.timeline.clips) {
      if (!object(raw) || typeof raw.id !== 'string' || typeof raw.startFrame !== 'number' || typeof raw.durationFrames !== 'number') return unavailable();
      const alphaMode = colours.some((item: unknown) => object(item) && item.clipId === raw.id && item.kind === 'image') ? 'premultiplied' : 'straight';
      clips.set(raw.id, freeze({startFrame: raw.startFrame, durationFrames: raw.durationFrames, alphaMode, ...opacityEnvelopeFieldsAfterEdit(raw, {})}));
    }
    // Capture has rejected proxies/accessors and cycles before freezing. Keep
    // raw presence, curves and plan exactly as accepted, never replace them by
    // the legacy projection used solely for unchanged validation boundaries.
    freeze(snapshot);
    const validationSnapshot = freeze(prepared.sourceValidationSnapshot);
    const signal = attempt.signal;
    let live = true;
    const close = (): void => {live = false; attempt.close(); signal?.removeEventListener('abort', close);};
    const assert = (): void => {
      if (!live || signal?.aborted) return unavailable();
      try {assertOpacityCandidateRenderAttempt(attempt);} catch (error) {close(); throw error;}
    };
    signal?.addEventListener('abort', close, {once: true});
    const binding: Readonly<TimelineOpacityRenderBinding> = Object.freeze({
      validationSnapshot, readLut: attempt.readLut, signal, assert, close,
      effectFence(additional?: () => void): () => void {
        if (additional !== undefined && typeof additional !== 'function') return unavailable();
        return (): void => {assert(); additional?.(); assert();};
      },
      filterForSegment(clipId: string, beginFrame: number, frameCount: number, alphaMode: TimelineOpacityAlphaModeCandidate): string {
        assert();
        const clip = clips.get(clipId);
        if (!clip || clip.alphaMode !== alphaMode || !Number.isSafeInteger(beginFrame) || Object.is(beginFrame, -0)) return unavailable();
        return compileTimelineOpacityFilterCandidate(clip, beginFrame - clip.startFrame, frameCount, clip.alphaMode).filter;
      },
    });
    assert(); bindings.set(snapshot, {binding, preparedAssets, assert}); return binding;
  } catch (error) {attempt.close(); throw error;}
}
