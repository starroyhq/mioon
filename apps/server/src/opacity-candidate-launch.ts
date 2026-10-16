/** Explicit development launch proof. The ordinary server never calls this
 * factory, and no serialized field can select a workspace profile. */
import path from 'node:path';
import {readFileSync, lstatSync} from 'node:fs';
import {openNewOpacityCandidateApplicationStore, getOpacityCandidateAssembly} from '../../../packages/business/src/opacity-candidate-store.ts';
import type {OpacityCandidateStore} from '../../../packages/business/src/opacity-candidate-store.ts';

interface Entry {readonly root: string; readonly store: OpacityCandidateStore; used: boolean}
const launches = new WeakMap<object, Entry>();
function invalid(): never {throw Object.assign(new Error('An exact unused fresh42 development launch is required.'), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});}

/** A candidate listener must serve the separately compiled candidate build.
 * A normal production HTML entry never becomes a profile switch. */
export function assertOpacityCandidateBuild(directory: string): void {
  const root = path.resolve(directory), marker = path.join(root, 'mioon-opacity-candidate-entry.json');
  try {
    const info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512) return invalid();
    const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== 3 || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
        !('profileId' in value) || value.profileId !== 'mioon-workspace-v42' ||
        !('entry' in value) || value.entry !== 'opacity-candidate.html') return invalid();
    const entry = lstatSync(path.join(root, 'opacity-candidate.html'));
    if (!entry.isFile() || entry.isSymbolicLink()) return invalid();
  } catch {throw Object.assign(new Error('Build the isolated opacity candidate frontend before launching.'), {code: 'OPACITY_CANDIDATE_BUILD_REQUIRED'});}
}

/** directory must not already exist. No migrate, reopen or fallback path. */
export function createFreshOpacityCandidateLaunch(directory: string): object {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return invalid();
  const root = path.resolve(directory), store = openNewOpacityCandidateApplicationStore(root);
  const proof = Object.freeze({});
  launches.set(proof, {root, store, used: false});
  return proof;
}

/** Only the server's fixed composition consumes this one-shot capability. */
export function consumeOpacityCandidateLaunch(value: unknown) {
  if (!value || typeof value !== 'object') return invalid();
  const entry = launches.get(value);
  if (!entry || entry.used) return invalid();
  const assembly = getOpacityCandidateAssembly(entry.store);
  if (!assembly || assembly.getRestoreContext()) return invalid();
  assembly.checkpoint();entry.used = true;
  return Object.freeze({root: entry.root, store: entry.store, assembly});
}

/** Release an unused proof when argument validation fails before composition. */
export function closeUnusedOpacityCandidateLaunch(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const entry = launches.get(value);
  if (!entry || entry.used) return;
  entry.used = true;entry.store.close();
}
