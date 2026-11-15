import type {ProjectEntriesResponse, ProjectEntryIdentity} from '../../../packages/contracts/src/project-entry.ts';
import {ProjectEntryDirectoryError} from './project-entry-directory-client.ts';
import {createProjectEntryDirectoryController, createProjectEntryIdentityReader} from './project-entry-directory-state.ts';
import type {ProjectEntryDirectoryFailure, ProjectEntryDirectoryReadPort, ProjectEntryDirectoryRefreshOptions, ProjectEntryDirectoryState} from './project-entry-directory-state.ts';

type ProjectEntryIdentityFailure = ProjectEntryDirectoryFailure | {readonly code: 'PROJECT_ENTRY_STALE_INSTANCE'; readonly status: 409};

export interface ProjectEntryIdentityState<T extends ProjectEntryIdentity = ProjectEntriesResponse> {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'blocked';
  readonly snapshot: T | null;
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

interface OwnerOptions<T extends ProjectEntryIdentity> {
  readonly read?: ProjectEntryDirectoryReadPort;
  readonly onChange?: (state: ProjectEntryIdentityState<T>) => void;
}
export function createProjectEntryIdentityOwner(options: OwnerOptions<ProjectEntriesResponse> = {}) {
  return createIdentityOwner(options, createProjectEntryDirectoryController);
}
export function createSettingsWorkspaceIdentityOwner(options: OwnerOptions<ProjectEntryIdentity> = {}) {
  return createIdentityOwner(options, createProjectEntryIdentityReader);
}

/** Both library and service identity stay pinned for this renderer. */
function createIdentityOwner<T extends ProjectEntryIdentity>({read, onChange = () => {}}: OwnerOptions<T>,
  createReader: (options: {read?: ProjectEntryDirectoryReadPort; onChange: (state: ProjectEntryDirectoryState<T>) => void}) =>
    Pick<ReturnType<typeof createProjectEntryDirectoryController>, 'activate' | 'dispose' | 'refresh'>) {
  let active = false, generation = 0, flight: {result: Promise<T | null>; background: boolean} | null = null;
  let baseline: ProjectEntryIdentity | null = null;
  let blocked: ProjectEntryIdentityError | null = null;
  const listeners = new Set<() => void>();
  let state: ProjectEntryIdentityState<T> = Object.freeze({phase: 'idle', snapshot: null, appLibraryScope: null, instanceId: null, identityBlocked: false, failure: null});
  const emit = (patch: Partial<ProjectEntryIdentityState<T>>): void => {
    state = Object.freeze({...state, ...patch});
    if (active) {onChange(state); for (const listener of listeners) listener();}
  };
  function block(code: ProjectEntryIdentityError['code']): void {
    if (blocked) return;
    blocked = new ProjectEntryIdentityError(code);
    directory.dispose();
    emit({phase: 'blocked', snapshot: null, appLibraryScope: null, instanceId: null, identityBlocked: true, failure: Object.freeze({code, status: 409})});
  }
  const directory = createReader({
    ...(read ? {read} : {}),
    onChange: next => {
      if (blocked) return;
      if (next.phase === 'blocked') {block('PROJECT_ENTRY_SCOPE_MISMATCH'); return;}
      if (next.phase === 'ready' && next.snapshot) {
        const {appLibraryScope, instanceId} = next.snapshot;
        if (baseline && baseline.instanceId !== instanceId) {block('PROJECT_ENTRY_STALE_INSTANCE'); return;}
        baseline ??= {appLibraryScope, instanceId};
      }
      emit({phase: next.phase, snapshot: next.snapshot, appLibraryScope: baseline?.appLibraryScope ?? null,
        instanceId: baseline?.instanceId ?? null, failure: next.error});
    },
  });
  function discover(replace = false, options?: ProjectEntryDirectoryRefreshOptions): Promise<T | null> {
    if (!active || blocked) return Promise.resolve(null);
    const background = options?.background === true;
    if (flight && !replace && (background || !flight.background)) return flight.result;
    const owner = generation;
    const work = directory.refresh(options).then(accepted => active && owner === generation && !blocked && accepted ? state.snapshot : null);
    flight = {result: work, background};
    void work.finally(() => {if (flight?.result === work) flight = null;});
    return work;
  }
  return {
    activate(): void {if (!active) {active = true; generation++; if (!blocked) directory.activate();}},
    dispose(): void {active = false; generation++; flight = null; directory.dispose(); if (!blocked) emit({phase: 'idle', snapshot: null, failure: null});},
    discover: (options?: ProjectEntryDirectoryRefreshOptions) => discover(false, options), refresh: () => discover(true),
    getVerifiedScope: (): string | null => blocked ? null : baseline?.appLibraryScope ?? null,
    getState: (): ProjectEntryIdentityState<T> => state,
    subscribe(listener: () => void): () => void {listeners.add(listener); return () => {listeners.delete(listener);};},
    assertIdentity(): void {if (blocked) throw blocked;},
  };
}
export type ProjectEntryIdentityOwner = ReturnType<typeof createProjectEntryIdentityOwner>;
export type SettingsWorkspaceIdentityOwner = ReturnType<typeof createSettingsWorkspaceIdentityOwner>;

/** A missing read is an error, never an invented empty directory. The public
 * directory error keeps status handling shared with existing browser clients. */
export async function readProjectEntryIdentity(owner: ProjectEntryIdentityOwner, options?: ProjectEntryDirectoryRefreshOptions): Promise<ProjectEntriesResponse> {
  const value = await owner.discover(options?.background ? options : undefined);
  if (options?.background && owner.getState().identityBlocked) throw new ProjectEntryDirectoryError('PROJECT_ENTRY_SCOPE_MISMATCH', 409);
  owner.assertIdentity();
  if (!value) {
    const failure = owner.getState().failure;
    if (options?.background) {
      const code = failure?.code === 'PROJECT_ENTRY_STALE_INSTANCE' ? 'PROJECT_ENTRY_SCOPE_MISMATCH' : failure?.code;
      throw new ProjectEntryDirectoryError(code ?? 'BACKEND_UNAVAILABLE', failure?.status);
    }
    throw new ProjectEntryDirectoryError(failure?.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : failure?.code === 'ORIGIN_REJECTED' ? 'ORIGIN_REJECTED' : 'PROJECT_ENTRY_UNAVAILABLE', failure?.status);
  }
  return value;
}
