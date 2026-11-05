import {backgroundTaskQueryResponseSchema, BACKGROUND_TASK_QUERY_LIMITS} from '../../../packages/contracts/src/background-task-query.ts';
import type {BackgroundTaskQueryResponse} from '../../../packages/contracts/src/background-task-query.ts';
import {projectEntriesResponseSchema, PROJECT_ENTRY_LIMITS} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import {BACKGROUND_TASK_INDEX_LIMITS} from '../../../packages/contracts/src/project-registry.ts';
import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';

export type HomeBackgroundTask = BackgroundTaskQueryResponse['projects'][number];
export interface HomeBackgroundIdentity {
  readonly appLibraryScope: string;
  readonly instanceId: string;
  /** Local catalog lifetime, including reopening the same project or backend. */
  readonly epoch: number;
}
export type HomeBackgroundDirectory = HomeBackgroundIdentity & Pick<ProjectEntriesResponse, 'registered'>;
export type HomeBackgroundError = 'invalid-directory' | 'invalid-response' | 'pagination' | 'budget' | 'unavailable';
export type HomeBackgroundState =
  | {readonly kind: 'unknown'; readonly identity: null; readonly tasks: null}
  | {readonly kind: 'loading'; readonly identity: HomeBackgroundIdentity; readonly tasks: null}
  | {readonly kind: 'error'; readonly identity: HomeBackgroundIdentity | null; readonly tasks: null; readonly error: HomeBackgroundError; readonly retryable: true}
  | {readonly kind: 'ready'; readonly identity: HomeBackgroundIdentity; readonly tasks: readonly HomeBackgroundTask[]};
export interface HomeBackgroundReadInput {readonly cursor?: string; readonly signal: AbortSignal}
export const HOME_BACKGROUND_LIMITS = Object.freeze({
  maxPages: BACKGROUND_TASK_INDEX_LIMITS.application,
  maxProjects: BACKGROUND_TASK_INDEX_LIMITS.application,
  maxTasks: BACKGROUND_TASK_INDEX_LIMITS.application,
});

const unknown = (): HomeBackgroundState => Object.freeze({kind: 'unknown', identity: null, tasks: null});
class BackgroundReadError extends Error {
  readonly code: HomeBackgroundError;
  constructor(code: HomeBackgroundError) {super('Unable to verify background tasks.'); this.code = code;}
}
function fail(code: HomeBackgroundError): never {throw new BackgroundReadError(code);}

/** Reads application metadata only. A complete current read can establish a
 * zero count; loading, errors and invalidation deliberately retain unknown.
 * Project opening, permissions and task mutations have no port here. */
export function createProjectHomeBackgroundController({readPage, onChange = () => {}}: {
  readonly readPage: (input: HomeBackgroundReadInput) => Promise<unknown>;
  readonly onChange?: (state: HomeBackgroundState) => void;
}) {
  let active = false, serial = 0;
  let pending: AbortController | null = null;
  let state = unknown();
  const emit = (next: HomeBackgroundState): void => {state = Object.freeze(next); if (active) onChange(state);};
  const stop = (): void => {serial++; pending?.abort(); pending = null;};
  async function read(input: HomeBackgroundReadInput): Promise<unknown> {
    let rejectAbort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {rejectAbort = () => reject(new BackgroundReadError('unavailable'));});
    input.signal.addEventListener('abort', rejectAbort, {once: true});
    try {
      input.signal.throwIfAborted();
      // A replaced owner also retires its promise when a port ignores signal.
      return await Promise.race([readPage(input), interrupted]);
    } finally {input.signal.removeEventListener('abort', rejectAbort);}
  }

  async function refresh(directory: HomeBackgroundDirectory): Promise<void> {
    if (!active) return;
    stop();
    const request = serial, abort = new AbortController(); pending = abort;
    const current = (): boolean => active && request === serial && !abort.signal.aborted;
    let identity: HomeBackgroundIdentity | null = null;
    try {
      // The caller supplies its validated catalog. Retain only its authority
      // and IDs: a waiting-task summary never admits a stored filesystem path.
      if (!directory || !Number.isSafeInteger(directory.epoch) || directory.epoch < 0 ||
        !projectEntriesResponseSchema.safeParse({version: 1, appLibraryScope: directory.appLibraryScope, instanceId: directory.instanceId, registered: []}).success ||
        !Array.isArray(directory.registered) || directory.registered.length > PROJECT_ENTRY_LIMITS.maxEntries) fail('invalid-directory');
      const registered = new Set<string>();
      for (const entry of directory.registered) {
        const id = entry?.project?.projectId;
        if (!projectIdSchema.safeParse(id).success || registered.has(id)) fail('invalid-directory');
        registered.add(id);
      }
      identity = Object.freeze({appLibraryScope: directory.appLibraryScope, instanceId: directory.instanceId, epoch: directory.epoch});
      emit({kind: 'loading', identity, tasks: null});
      if (!current()) return;
      const tasks: HomeBackgroundTask[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined, pages = 0, totalTasks = 0;
      for (;;) {
        if (++pages > HOME_BACKGROUND_LIMITS.maxPages) fail('budget');
        const raw = await read({...(cursor ? {cursor} : {}), signal: abort.signal});
        if (!current()) return;
        const parsed = backgroundTaskQueryResponseSchema.safeParse(raw);
        if (!parsed.success) fail('invalid-response');
        const page = parsed.data;
        if (new TextEncoder().encode(JSON.stringify(page)).byteLength > BACKGROUND_TASK_QUERY_LIMITS.responseBytes) fail('budget');
        for (const task of page.projects) {
          if (seen.has(task.projectId) || cursor !== undefined && task.projectId <= cursor) fail('pagination');
          seen.add(task.projectId); totalTasks += task.taskCount;
          if (seen.size > HOME_BACKGROUND_LIMITS.maxProjects || totalTasks > HOME_BACKGROUND_LIMITS.maxTasks) fail('budget');
          if (registered.has(task.projectId)) {
            Object.freeze(task.reasonCodes);
            tasks.push(Object.freeze(task));
          }
        }
        if (page.nextCursor === null) break;
        if (cursors.has(page.nextCursor) || cursor !== undefined && page.nextCursor <= cursor) fail('pagination');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      if (current()) emit({kind: 'ready', identity, tasks: Object.freeze(tasks)});
    } catch (error) {
      if (current()) emit({kind: 'error', identity, tasks: null, error: error instanceof BackgroundReadError ? error.code : 'unavailable', retryable: true});
    } finally {if (request === serial) pending = null;}
  }

  return {
    activate() {if (!active) {active = true; serial++;}},
    dispose() {active = false; stop(); state = unknown();},
    invalidate() {stop(); emit(unknown());},
    refresh,
    getState: (): HomeBackgroundState => state,
  };
}
export type ProjectHomeBackgroundController = ReturnType<typeof createProjectHomeBackgroundController>;
