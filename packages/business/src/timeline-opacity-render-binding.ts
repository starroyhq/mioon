/** Fixed internal renderer guard for opacity fields. No export attempt binds
 * an opacity render, so an own opacity field fails closed instead of silently
 * falling through the legacy render. Portable JSON plans grant nothing. */
import {isProxy} from 'node:util/types';
import type {TimelineOpacityAlphaModeCandidate} from './timeline-opacity-filter-candidate.ts';

type Value = Record<string, unknown>;
/** The renderer's binding contract. Nothing produces a binding; the renderer
 * keeps this shape so an unbound opacity field still refuses. */
export interface TimelineOpacityRenderBinding {
  /** Detached and recursively frozen. Only fixed legacy validators receive it;
   * the renderer retains the exact bound raw snapshot and its original hash. */
  readonly validationSnapshot: Readonly<Value>;
  /** Fixed owned project reader from the authority's actual preparation. */
  readonly readLut: unknown;
  /** Media always uses the same lifetime as its owned attempt. */
  readonly signal: AbortSignal | undefined;
  readonly assert: () => void;
  /** Always retains the trusted attempt/source checks around any worker fence. */
  readonly effectFence: (additional?: () => void) => () => void;
  /** Raw fixed compiler stage, without a leading comma or caller graph labels. */
  readonly filterForSegment: (clipId: string, beginFrame: number, frameCount: number, alphaMode: TimelineOpacityAlphaModeCandidate) => string;
  readonly close: () => void;
}
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
function unavailable(): never {
  throw Object.assign(new Error('This opacity render snapshot has no live owned export attempt.'), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
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
 * null is an opacity field, so it cannot silently fall through legacy render;
 * a prepared source Map grants no access either. Old ordinary snapshots
 * return null and contribute exactly zero filter bytes.
 */
export function getTimelineOpacityRenderBinding(snapshot: unknown, _preparedAssets?: unknown): Readonly<TimelineOpacityRenderBinding> | null {
  if (!object(snapshot)) return null;
  if (hasOpacityFields(snapshot)) return unavailable();
  return null;
}
