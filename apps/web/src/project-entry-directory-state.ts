import {projectEntriesResponseSchema, projectEntryIdentitySchema} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse, ProjectEntryIdentity} from '../../../packages/contracts/src/project-entry.ts';
import {createProjectEntryDirectoryClient, ProjectEntryDirectoryError} from './project-entry-directory-client.ts';
import type {ProjectEntryDirectoryErrorCode} from './project-entry-directory-client.ts';

export interface ProjectEntryDirectoryFailure {readonly code: ProjectEntryDirectoryErrorCode; readonly status?: number}
export interface ProjectEntryDirectoryIdentity {
  readonly appLibraryScope: string;
  readonly instanceId: string;
  readonly epoch: number;
}
export interface ProjectEntryDirectoryState<T extends ProjectEntryIdentity = ProjectEntriesResponse> {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'blocked';
  readonly snapshot: T | null;
  /** Changes only after a complete, validated snapshot from a new instance. */
  readonly epoch: number;
  readonly error: ProjectEntryDirectoryFailure | null;
}
export type ProjectEntryDirectoryReadPort = (options: {readonly signal: AbortSignal}) => Promise<unknown>;
const validScope = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function freezeSnapshot(value: ProjectEntriesResponse): ProjectEntriesResponse {
  for (const entry of value.registered) {
    Object.freeze(entry.project.fileIdentity);
    if (entry.project.summary) {if (entry.project.summary.cover) Object.freeze(entry.project.summary.cover); Object.freeze(entry.project.summary);}
    Object.freeze(entry.project); Object.freeze(entry.availability); Object.freeze(entry);
  }
  Object.freeze(value.registered); return Object.freeze(value);
}

interface ControllerOptions<T extends ProjectEntryIdentity> {
  readonly read?: ProjectEntryDirectoryReadPort;
  readonly expectedScope?: () => string | null | undefined;
  readonly onChange?: (state: ProjectEntryDirectoryState<T>) => void;
}

/** Catalog consumers get complete rows. Settings only needs the identity. */
export function createProjectEntryDirectoryController(options: ControllerOptions<ProjectEntriesResponse> = {}) {
  return createReadController(options, createProjectEntryDirectoryClient().list, projectEntriesResponseSchema, freezeSnapshot);
}
export function createProjectEntryIdentityReader(options: ControllerOptions<ProjectEntryIdentity> = {}) {
  return createReadController(options, createProjectEntryDirectoryClient().readIdentity, projectEntryIdentitySchema, Object.freeze);
}

/** A read owner for one application library. Disposal retires pending reads,
 * but cannot erase a verified library pin or unblock an identity mismatch. */
function createReadController<T extends ProjectEntryIdentity>(
  {read, expectedScope = () => null, onChange = () => {}}: ControllerOptions<T>, defaultRead: ProjectEntryDirectoryReadPort,
  schema: {safeParse(value: unknown): {success: true; data: T} | {success: false}}, freeze: (value: T) => T,
) {
  const port = read ?? defaultRead;
  let active = false, generation = 0, readSerial = 0;
  let pinnedScope: string | null = null, instanceId: string | null = null, pending: AbortController | null = null;
  let state: ProjectEntryDirectoryState<T> = Object.freeze({phase: 'idle', snapshot: null, epoch: 0, error: null});
  const publish = (patch: Partial<ProjectEntryDirectoryState<T>>): void => {state = Object.freeze({...state, ...patch}); if (active) onChange(state);};
  const current = (owner: number, serial: number): boolean => active && generation === owner && readSerial === serial && state.phase !== 'blocked';
  const block = (): void => {
    readSerial++; pending?.abort(); pending = null;
    publish({phase: 'blocked', snapshot: null, error: Object.freeze({code: 'PROJECT_ENTRY_SCOPE_MISMATCH', status: 409})});
  };
  function expectation(): string | null {
    const value = expectedScope();
    if (value === null || value === undefined) return null;
    if (!validScope(value)) throw new ProjectEntryDirectoryError('BACKEND_PROTOCOL_ERROR');
    if (pinnedScope !== null && pinnedScope !== value) {block(); return null;}
    return value;
  }
  return {
    getState: (): ProjectEntryDirectoryState<T> => state,
    /** A refresh clears display rows, not the identity already verified for
     * an in-flight receipt. New actions still require a ready snapshot. */
    getVerifiedIdentity(): ProjectEntryDirectoryIdentity | null {
      if (!active || state.phase === 'blocked' || pinnedScope === null || instanceId === null) return null;
      try {
        const expected = expectedScope();
        if (expected !== null && expected !== undefined && (!validScope(expected) || expected !== pinnedScope)) return null;
      } catch {return null;}
      return Object.freeze({appLibraryScope: pinnedScope, instanceId, epoch: state.epoch});
    },
    activate(): void {if (!active) {active = true; generation++;}},
    dispose(): void {
      active = false; generation++; readSerial++; pending?.abort(); pending = null;
      if (state.phase !== 'blocked') publish({phase: 'idle', snapshot: null, error: null});
    },
    async refresh(): Promise<boolean> {
      if (!active || state.phase === 'blocked') return false;
      const owner = generation, serial = ++readSerial;
      pending?.abort(); const controller = new AbortController(); pending = controller;
      publish({phase: 'loading', snapshot: null, error: null});
      let stop = (): void => {};
      try {
        if (!current(owner, serial) || controller.signal.aborted) return false;
        const expectedBefore = expectation();
        if (!current(owner, serial)) return false;
        const aborted = new Promise<never>((_resolve, reject) => {stop = () => reject(new ProjectEntryDirectoryError('INTERRUPTED'));});
        controller.signal.addEventListener('abort', stop, {once: true});
        const value = await Promise.race([port({signal: controller.signal}), aborted]);
        if (!current(owner, serial) || controller.signal.aborted) return false;
        const expectedAfter = expectation();
        if (!current(owner, serial)) return false;
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new ProjectEntryDirectoryError('BACKEND_PROTOCOL_ERROR');
        const snapshot = parsed.data;
        if (pinnedScope !== null && snapshot.appLibraryScope !== pinnedScope ||
          expectedBefore !== null && snapshot.appLibraryScope !== expectedBefore ||
          expectedAfter !== null && snapshot.appLibraryScope !== expectedAfter) {block(); return false;}
        const epoch = state.epoch + (instanceId === snapshot.instanceId ? 0 : 1);
        pinnedScope = snapshot.appLibraryScope; instanceId = snapshot.instanceId;
        publish({phase: 'ready', snapshot: freeze(snapshot), epoch, error: null});
        return true;
      } catch (error) {
        if (!current(owner, serial) || controller.signal.aborted) return false;
        // A changed external library revokes an old response, including errors.
        try {expectation();} catch {error = new ProjectEntryDirectoryError('BACKEND_PROTOCOL_ERROR');}
        if (!current(owner, serial)) return false;
        if (error instanceof ProjectEntryDirectoryError && error.code === 'PROJECT_ENTRY_SCOPE_MISMATCH') {block(); return false;}
        const failure: ProjectEntryDirectoryFailure = error instanceof ProjectEntryDirectoryError
          ? {code: error.code, ...(error.status === undefined ? {} : {status: error.status})} : {code: 'BACKEND_UNAVAILABLE'};
        publish({phase: 'error', snapshot: null, error: Object.freeze(failure)});
        return false;
      } finally {controller.signal.removeEventListener('abort', stop); if (pending === controller) pending = null;}
    },
  };
}
export type ProjectEntryDirectoryController = ReturnType<typeof createProjectEntryDirectoryController>;
