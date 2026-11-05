import {projectEntriesResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import {createProjectEntryDirectoryClient, ProjectEntryDirectoryError} from './project-entry-directory-client.ts';
import {createProjectEntryDirectoryController} from './project-entry-directory-state.ts';
import type {ProjectEntryDirectoryReadPort} from './project-entry-directory-state.ts';

export interface ProjectEntryIdentityFailure {readonly code: string; readonly status?: number}
export interface ProjectEntryIdentityState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'blocked';
  readonly snapshot: ProjectEntriesResponse | null;
  readonly appLibraryScope: string | null;
  readonly instanceId: string | null;
  readonly identityBlocked: boolean;
  readonly failure: ProjectEntryIdentityFailure | null;
}
export class ProjectEntryIdentityError extends Error {
  readonly code: 'PROJECT_ENTRY_SCOPE_MISMATCH' | 'PROJECT_ENTRY_STALE_INSTANCE';
  readonly status = 409;
  constructor(code: ProjectEntryIdentityError['code']) {super('The application identity changed. Keep the current window and inputs.'); this.name = 'ProjectEntryIdentityError'; this.code = code;}
}

/** Read-only renderer authority. Both library and service identity are pinned:
 * a new renderer must validate a replacement instance before old requests or
 * cached preferences can become eligible again. No selection is persisted. */
export function createProjectEntryIdentityOwner({read, onChange = () => {}}: {
  readonly read?: ProjectEntryDirectoryReadPort;
  readonly onChange?: (state: ProjectEntryIdentityState) => void;
} = {}) {
  const port = read ?? createProjectEntryDirectoryClient().list;
  let active = false, generation = 0, flight: Promise<ProjectEntriesResponse | null> | null = null;
  let baseline: {appLibraryScope: string; instanceId: string} | null = null;
  let blocked: ProjectEntryIdentityError | null = null;
  const listeners = new Set<() => void>();
  let state: ProjectEntryIdentityState = Object.freeze({phase: 'idle', snapshot: null, appLibraryScope: null, instanceId: null, identityBlocked: false, failure: null});
  const emit = (patch: Partial<ProjectEntryIdentityState>): void => {
    state = Object.freeze({...state, ...patch});
    if (active) {onChange(state); for (const listener of listeners) listener();}
  };
  function block(code: ProjectEntryIdentityError['code']): void {
    if (blocked) return;
    blocked = new ProjectEntryIdentityError(code);
    directory.dispose();
    emit({phase: 'blocked', snapshot: null, appLibraryScope: null, instanceId: null, identityBlocked: true, failure: Object.freeze({code, status: 409})});
  }
  const directory = createProjectEntryDirectoryController({
    read: async input => {
      const owner = generation, value = await port(input);
      if (!active || owner !== generation || input.signal.aborted || blocked) return value;
      const parsed = projectEntriesResponseSchema.safeParse(value);
      if (parsed.success && baseline) {
        if (parsed.data.appLibraryScope !== baseline.appLibraryScope) block('PROJECT_ENTRY_SCOPE_MISMATCH');
        else if (parsed.data.instanceId !== baseline.instanceId) block('PROJECT_ENTRY_STALE_INSTANCE');
      }
      return value;
    },
    onChange: next => {
      if (blocked) return;
      if (next.phase === 'blocked') {block('PROJECT_ENTRY_SCOPE_MISMATCH'); return;}
      if (next.phase === 'ready' && next.snapshot) baseline ??= {appLibraryScope: next.snapshot.appLibraryScope, instanceId: next.snapshot.instanceId};
      emit({phase: next.phase, snapshot: next.snapshot, appLibraryScope: baseline?.appLibraryScope ?? null,
        instanceId: baseline?.instanceId ?? null, failure: next.error});
    },
  });
  function discover(replace = false): Promise<ProjectEntriesResponse | null> {
    if (!active || blocked) return Promise.resolve(null);
    if (flight && !replace) return flight;
    const owner = generation;
    const work = directory.refresh().then(accepted => active && owner === generation && !blocked && accepted ? state.snapshot : null);
    flight = work;
    void work.finally(() => {if (flight === work) flight = null;});
    return work;
  }
  return {
    activate(): void {if (!active) {active = true; generation++; if (!blocked) directory.activate();}},
    dispose(): void {active = false; generation++; flight = null; directory.dispose(); if (!blocked) emit({phase: 'idle', snapshot: null, failure: null});},
    discover: () => discover(), refresh: () => discover(true),
    getVerifiedScope: (): string | null => blocked ? null : baseline?.appLibraryScope ?? null,
    getState: (): ProjectEntryIdentityState => state,
    subscribe(listener: () => void): () => void {listeners.add(listener); return () => {listeners.delete(listener);};},
    assertIdentity(): void {if (blocked) throw blocked;},
  };
}
export type ProjectEntryIdentityOwner = ReturnType<typeof createProjectEntryIdentityOwner>;

/** A missing read is an error, never an invented empty directory. The public
 * directory error keeps status handling shared with existing browser clients. */
export async function readProjectEntryIdentity(owner: ProjectEntryIdentityOwner): Promise<ProjectEntriesResponse> {
  const value = await owner.discover(); owner.assertIdentity();
  if (!value) {
    const failure = owner.getState().failure;
    throw new ProjectEntryDirectoryError(failure?.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : failure?.code === 'ORIGIN_REJECTED' ? 'ORIGIN_REJECTED' : 'PROJECT_ENTRY_UNAVAILABLE', failure?.status);
  }
  return value;
}
