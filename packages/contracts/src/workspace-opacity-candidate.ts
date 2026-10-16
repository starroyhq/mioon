/** Reserved candidate descriptors only. There is deliberately no SQL, database
 * classifier, initializer, restore installer, dispatch wiring or permission. */
import {isProxy} from 'node:util/types';

export const OPACITY_ORDINARY_SCHEMA_CANDIDATE = 42;
export const OPACITY_RESTORED_SCHEMA_CANDIDATE = 43;
export const OPACITY_RESTORED_PROFILE_CANDIDATE = 'restored-local-v10';
export type WorkspaceOpacityCandidateProfile = Readonly<
  {schemaVersion: 42; profile: 'ordinary'} |
  {schemaVersion: 43; sourceSchema: 42; profile: typeof OPACITY_RESTORED_PROFILE_CANDIDATE}
>;
const through40 = [...Array.from({length: 24}, (_, index) => index + 1), 26, 28, 30, 32, 34, 36, 38, 40];
export const OPACITY_ORDINARY_CANDIDATE_MARKERS: readonly number[] = Object.freeze([...through40, 42]);
export const OPACITY_RESTORED_CANDIDATE_MARKERS: readonly number[] = Object.freeze([...through40, 42, 43]);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
function fail(): never {throw Object.assign(new Error('Invalid dormant opacity workspace profile.'), {code: 'INVALID_OPACITY_WORKSPACE_CANDIDATE'});}

export function captureWorkspaceOpacityCandidateProfile(value: unknown): WorkspaceOpacityCandidateProfile {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(value), result: Record<string, unknown> = {};
  if (keys.length < 2 || keys.length > 3) fail();
  for (const key of keys) {
    if (typeof key !== 'string' || !['schemaVersion', 'sourceSchema', 'profile'].includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  if (keys.length === 2 && result.schemaVersion === 42 && result.profile === 'ordinary' && !own(result, 'sourceSchema'))
    return Object.freeze({schemaVersion: 42, profile: 'ordinary'});
  if (keys.length === 3 && result.schemaVersion === 43 && result.sourceSchema === 42 && result.profile === OPACITY_RESTORED_PROFILE_CANDIDATE)
    return Object.freeze({schemaVersion: 43, sourceSchema: 42, profile: OPACITY_RESTORED_PROFILE_CANDIDATE});
  return fail();
}

/** Plain marker evidence alone never establishes a real schema or grants
 * restoration/editing authority. A later separately reviewed catalog gate is
 * still required; these descriptors are not accepted by existing dispatch. */
export function isWorkspaceOpacityCandidateMarkerEvidence(profile: unknown, markers: unknown): boolean {
  try {
    const checked = captureWorkspaceOpacityCandidateProfile(profile);
    const expected = checked.schemaVersion === 42 ? OPACITY_ORDINARY_CANDIDATE_MARKERS : OPACITY_RESTORED_CANDIDATE_MARKERS;
    if (!markers || typeof markers !== 'object' || isProxy(markers) || !Array.isArray(markers) || Object.getPrototypeOf(markers) !== Array.prototype) return false;
    const length = Object.getOwnPropertyDescriptor(markers, 'length');
    if (!length || !own(length, 'value') || length.value !== expected.length || Reflect.ownKeys(markers).length !== expected.length + 1) return false;
    return expected.every((version, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(markers, String(index));
      return Boolean(descriptor && descriptor.enumerable && own(descriptor, 'value') && descriptor.value === version);
    });
  } catch {return false;}
}
