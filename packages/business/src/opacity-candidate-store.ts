/** Internal, fixed-version test assembly. This module is deliberately absent
 * from package exports and RPC. Importing it neither opens a store nor starts a
 * service; only an explicit call can create an empty42 or reopen exact42/43. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue, StatementSync} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import {AppError} from '../../contracts/src/app-error.ts';
import {initializeWorkspaceSchema42} from './workspace-schema-v42.ts';
import {classifyWorkspaceSchemaV42V43, validateWorkspaceRestoreSchemaV43} from './workspace-restore-schema-v43.ts';
import {captureOpacityRenderInput} from '../../contracts/src/timeline-opacity-render-candidate.ts';

const require = createRequire(import.meta.url);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value);
type RestoreInfo = Readonly<{schemaVersion: 43; sourceSchema: 42; profile: 'restored-local-v10'; workspaceOrigin: string}>;
type Table = 'projects' | 'assets' | 'shots' | 'nodes' | 'edges' | 'jobs' | 'versions' | 'exports' | 'timelines';
interface Lease {isOwned(): boolean; release(): unknown}
export interface OpacityCandidateStore {
  db: DatabaseSync;
  root: string;
  get(table: Table, id: string): unknown;
  list(table: Table, projectId?: string): unknown[];
  put<T extends Record<string, unknown>>(table: Table, value: T): T;
  tx<T>(callback: () => T): T;
  close(): void;
}
interface InvocationOptions {readonly signal?: AbortSignal}
interface Invocation {
  readonly store: OpacityCandidateStore;
  readonly origin: string;
  readonly operation: string;
  readonly inputDigest: string;
  readonly projectId: unknown;
  readonly signal: AbortSignal | undefined;
  readonly validate: (() => void) | undefined;
}
const invocations = new AsyncLocalStorage<Invocation>();
const lifetimes = new WeakMap<Invocation, {live: boolean}>();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => object(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function unavailable(): never {throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This operation is unavailable in this restored workspace.', 409);}
function unverified(): never {throw Object.assign(new Error('Opacity candidate store identity is not verified.'), {code: 'RESTORE_STORE_UNVERIFIED'});}
function restoreError(code: 'RESTORED_RECORD_HELD' | 'RESTORE_WORKSPACE_ORIGIN_REQUIRED' | 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'): never {
  const messages = {RESTORED_RECORD_HELD: 'This captured record is held and cannot execute or change in this restored workspace.',
    RESTORE_WORKSPACE_ORIGIN_REQUIRED: 'A new explicit action must supply this restored workspace origin.',
    RESTORE_WORKSPACE_ORIGIN_MISMATCH: 'The action belongs to a different workspace origin.'};
  throw new AppError(code, messages[code], 409);
}
function legacyCall(module: unknown, member: string, args: unknown[]): unknown {
  if (!object(module) || typeof module[member] !== 'function') unverified();
  const result: unknown = Reflect.apply(module[member], module, args);
  return result;
}
function storageRuntime(): unknown {
  const runtime: unknown = require('../../contracts/src/private-storage.mjs');
  return runtime;
}
function preflight(root: string, storage: unknown): void {
  if (!legacyCall(storage, 'validatePrivateDirectory', [root, {allowMissing: true}])) return;
  for (const [name, privateMode] of [['media', false], ['image-staging', true], ['frame-staging', true]] as const)
    legacyCall(storage, 'validateManagedDirectory', [path.join(root, name), {root, allowMissing: true, private: privateMode}]);
  for (const name of ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm', 'workbench.sqlite-journal'])
    legacyCall(storage, 'validateManagedFile', [path.join(root, name), {root, allowMissing: true}]);
  for (const [name, maxBytes] of [['server.lock', 64], ['access-token', 4098], ['local-drafts-v1.json', 2 * 1024 * 1024], ['local-drafts-v3.json', 2 * 1024 * 1024]] as const)
    legacyCall(storage, 'validateManagedFile', [path.join(root, name), {root, allowMissing: true, private: name !== 'server.lock', maxBytes}]);
  for (const name of ['agent-settings', 'image-settings', 'comfy-settings']) {
    const directory = path.join(root, name);
    if (legacyCall(storage, 'validateManagedDirectory', [directory, {root, allowMissing: true, private: true}]))
      for (const filename of name === 'image-settings' ? ['settings.json', 'custom-settings.json'] : ['settings.json'])
        legacyCall(storage, 'validateManagedFile', [path.join(directory, filename), {root, allowMissing: true, private: true, maxBytes: name === 'comfy-settings' ? 16 * 1024 : 64 * 1024}]);
  }
}
function acquireLease(root: string): Lease {
  const runtime: unknown = require('./workspace-lock.mjs');
  const value = legacyCall(runtime, 'acquireWorkspaceLock', [root, {allowStale: true}]);
  if (!object(value) || typeof value.isOwned !== 'function' || typeof value.release !== 'function') unverified();
  return {isOwned: () => legacyCall(value, 'isOwned', []) === true, release: () => legacyCall(value, 'release', [])};
}
function nativePrepare(db: DatabaseSync, sql: string): StatementSync {
  const result: unknown = Reflect.apply(DatabaseSync.prototype.prepare, db, [sql]);
  // Statements are constructed only by the exact native SQLite method above.
  if (!result || typeof result !== 'object') unverified();
  return result as StatementSync;
}
function schemaFingerprint(db: DatabaseSync): string {
  const rows = nativePrepare(db, 'SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const markers = nativePrepare(db, 'SELECT version FROM main.schema_version ORDER BY version').all();
  if (nativePrepare(db, 'SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) unverified();
  return digest({rows, markers});
}
export function freezeOpacityCandidateInput<T>(value: T): T {
  const copy: T = structuredClone(value);
  const freeze = (item: unknown): void => {if (item !== null && typeof item === 'object') {for (const child of Object.values(item)) freeze(child); Object.freeze(item);}};
  freeze(copy); return copy;
}
export const OPACITY_CANDIDATE_RESTORE_READ_OPERATIONS = Object.freeze(['project.list', 'project.get', 'timeline.get', 'timeline.history.get', 'timeline.format.get']);
export const OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS = Object.freeze(['timeline.clip.update', 'timeline.undo', 'timeline.redo', 'timeline.render']);
export interface OpacityCandidateAssembly {
  checkpoint(): void;
  ownsLock(): boolean;
  getRestoreContext(): RestoreInfo | null;
  assertOrigin(context?: unknown): RestoreInfo | null;
  refuseOperation(operation: string, input?: unknown): void;
  refuseTask(taskId?: unknown, projectId?: unknown): void;
  assertRequestVacant(operation: string, input: unknown): void;
  freezeInput: typeof freezeOpacityCandidateInput;
  withInvocation<T>(operation: string, input: unknown, options: InvocationOptions, callback: (input: unknown) => T): T;
  hasInvocation(operation: string, input: unknown): boolean;
  effectFence(): (() => void) | undefined;
  withTaskInvocation<T>(row: unknown, options: InvocationOptions, callback: () => T): T;
  bindExport(operation: string, input: unknown, value: unknown, requestHash: string): void;
  readonly readOperations: readonly string[];
  readonly localOperations: readonly string[];
}
interface Registration {readonly assembly: OpacityCandidateAssembly; readonly check: () => void}
const assemblies = new WeakMap<object, Registration>();
/** A copied handle never acquires registration. A once-registered but revoked
 * handle throws, so it cannot fall back into the ordinary production path. */
export function getOpacityCandidateAssembly(store: unknown): OpacityCandidateAssembly | null {
  if (!store || typeof store !== 'object') return null;
  const entry = assemblies.get(store);
  if (!entry) return null;
  entry.check(); return entry.assembly;
}

/** No options or supplied implementations can choose a profile or suppress the
 * exclusive lease. Existing ordinary40/restored41 are deliberately refused. */
export function openOpacityCandidateStore(directory: string): OpacityCandidateStore {
  const root = path.resolve(directory), storage = storageRuntime();
  preflight(root, storage);
  legacyCall(storage, 'ensurePrivateDirectory', [root, {create: true}]);
  preflight(root, storage);
  let db: DatabaseSync | undefined, lease: Lease | undefined;
  try {
    lease = acquireLease(root); preflight(root, storage);
    db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    db.exec('PRAGMA trusted_schema=OFF;');
    if (db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0) unverified();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const markersExist = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='schema_version'").get();
    const restoredMarker = markersExist && db.prepare('SELECT 1 FROM main.schema_version WHERE version=43').get();
    if (!restoredMarker) initializeWorkspaceSchema42(db);
    const classification = classifyWorkspaceSchemaV42V43(db);
    const restored: RestoreInfo | null = classification.schemaVersion === 43 ? validateWorkspaceRestoreSchemaV43(db) : null;
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) unverified();
    if (!legacyCall(storage, 'validateManagedDirectory', [path.join(root, 'media'), {root, allowMissing: true}]))
      legacyCall(storage, 'ensurePrivateDirectory', [path.join(root, 'media'), {create: true}]);
    const fixedDb = db, fixedLease = lease, fingerprint = schemaFingerprint(db);
    let active = true, closed = false;
    const check = (): void => {
      // An inherited invocation grants authority only over its exact store.
      // This refusal is contextual: it must not revoke the unrelated store.
      const inherited = invocations.getStore();
      if (inherited && inherited.store !== store) unavailable();
      if (!active || closed || store.db !== fixedDb || store.root !== root || fixedDb.isOpen !== true) {active = false; unverified();}
      try {
        if (!fixedLease.isOwned() || schemaFingerprint(fixedDb) !== fingerprint ||
            nativePrepare(fixedDb, 'PRAGMA trusted_schema').get()?.trusted_schema !== 0 ||
            nativePrepare(fixedDb, 'PRAGMA foreign_keys').get()?.foreign_keys !== 1) {active = false; unverified();}
        if (restored) {
          const origin = nativePrepare(fixedDb, 'SELECT workspaceOrigin,sourceSchema,profile FROM workspace_restoration WHERE id=1').get();
          if (origin?.workspaceOrigin !== restored.workspaceOrigin || origin.sourceSchema !== 42 || origin.profile !== 'restored-local-v10') {active = false; unverified();}
        }
      } catch {active = false; unverified();}
    };
    const tableNames: ReadonlySet<string> = new Set(['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines']);
    const table = (name: Table): string => {if (!tableNames.has(name)) throw new Error('Unknown table'); return name;};
    const get = (name: Table, id: string): unknown => {check(); const row = fixedDb.prepare(`SELECT data FROM ${table(name)} WHERE id=?`).get(id); return row ? JSON.parse(String(row.data)) as unknown : null;};
    const list = (name: Table, projectId?: string): unknown[] => {check(); return fixedDb.prepare(`SELECT data FROM ${table(name)}${projectId ? ' WHERE projectId=?' : ''}`).all(...projectId ? [projectId] : []).map(row => JSON.parse(String(row.data)) as unknown);};
    const put = <T extends Record<string, unknown>>(name: Table, value: T): T => {
      check(); table(name);
      const columns = name === 'projects' ? ['id', 'data'] : name === 'versions' ? ['id', 'projectId', 'jobId', 'data'] : ['id', 'projectId', 'data'];
      const values: SQLInputValue[] = columns.map(key => {
        const item = key === 'data' ? JSON.stringify(value) : value[key];
        if (typeof item !== 'string') throw new TypeError('Store identity columns require strings');
        return item;
      });
      fixedDb.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);
      return value;
    };
    const tx = <T>(callback: () => T): T => {
      check();
      if (typeof callback !== 'function' || isAsyncFunction(callback)) throw new TypeError('Transactions require a synchronous callback');
      if (fixedDb.isTransaction) throw new Error('Nested transactions are not supported');
      fixedDb.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
          if (isPromise(result)) void result.catch(() => {});
          throw new TypeError('Transactions require a synchronous result');
        }
        check(); fixedDb.exec('COMMIT'); return result;
      } catch (error) {if (fixedDb.isTransaction) fixedDb.exec('ROLLBACK'); throw error;}
    };
    const close = (): void => {if (closed) return; active = false; try {fixedDb.close();} finally {closed = true; fixedLease.release();}};
    const store: OpacityCandidateStore = {db: fixedDb, root, get, list, put, tx, close};
    const held = (kind: string, id: string): boolean => Boolean(nativePrepare(fixedDb, 'SELECT 1 FROM workspace_restore_holds WHERE kind=? AND id=?').get(kind, id));
    const context = (): RestoreInfo | null => {check(); return restored;};
    const requestVacant = (operation: string, input: unknown): void => {
      check(); if (!restored || !object(input) || typeof input.requestId !== 'string') return;
      if (!OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes(operation) || !uuid(input.projectId) ||
          !nativePrepare(fixedDb, 'SELECT 1 FROM projects WHERE id=?').get(input.projectId)) unavailable();
      const captured = nativePrepare(fixedDb, "SELECT projectId FROM workspace_restore_holds WHERE requestId=? AND namespace IN ('timeline','timeline:mutation') LIMIT 2").all(input.requestId);
      if (captured.length) {if (captured.every(row => row.projectId === input.projectId)) restoreError('RESTORED_RECORD_HELD'); unavailable();}
      const foreign = nativePrepare(fixedDb, "SELECT 1 FROM agent_edit_proposals p JOIN workspace_restore_holds h ON h.kind='agent_edit_proposals' AND h.id=p.id WHERE p.projectId<>? AND EXISTS(SELECT 1 FROM json_tree(p.definition) WHERE key='requestId' AND path='$.input' AND value=?) AND EXISTS(SELECT 1 FROM json_each(p.definition) WHERE key='operation' AND value='timeline.clip.update') LIMIT 1").get(input.projectId, input.requestId);
      if (foreign) unavailable();
      const rows = nativePrepare(fixedDb, "SELECT p.id,p.projectId,p.runId,p.digest,CASE WHEN length(CAST(p.definition AS BLOB)) BETWEEN 1 AND 131072 THEN p.definition END AS definition FROM agent_edit_proposals p JOIN workspace_restore_holds h ON h.kind='agent_edit_proposals' AND h.id=p.id WHERE p.projectId=? LIMIT 2049").all(input.projectId);
      if (rows.length > 2048) unavailable();
      for (const row of rows) {
        let definition: unknown; try {if (typeof row.definition !== 'string') unavailable(); definition = JSON.parse(row.definition) as unknown;} catch {unavailable();}
        if (!object(definition) || definition.id !== row.id || definition.projectId !== input.projectId || definition.runId !== row.runId || digest(definition) !== row.digest ||
            !['shot.update', 'timeline.clip.update'].includes(String(definition.operation)) || !object(definition.input) || typeof definition.input.requestId !== 'string') unavailable();
        if (definition.operation === 'timeline.clip.update' && definition.input.requestId === input.requestId) restoreError('RESTORED_RECORD_HELD');
      }
    };
    const live = (entry: Invocation | undefined): Invocation => {
      check();
      if (!entry || !lifetimes.get(entry)?.live || entry.store !== store || entry.signal?.aborted || entry.origin !== (restored?.workspaceOrigin ?? '')) unavailable();
      entry.validate?.(); return entry;
    };
    const assertInvocation = (operation: string, input: unknown): void => {
      if (!context() && operation !== 'timeline.render') return;
      const entry = live(invocations.getStore());
      if (operation === 'timeline.get' && object(input) && input.projectId === entry.projectId && entry.operation === 'timeline.clip.update') return;
      if (entry.operation !== operation || entry.inputDigest !== digest(input)) unavailable();
    };
    const runInvocation = <T>(operation: string, input: unknown, options: InvocationOptions, validate: (() => void) | undefined, callback: (input: unknown) => T): T => {
      if (!OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes(operation)) unavailable();
      if (operation === 'timeline.render') {try {captureOpacityRenderInput(input);} catch {unavailable();}}
      const inherited = invocations.getStore();
      if (inherited && inherited.store !== store) unavailable();
      if (!context() && operation !== 'timeline.render') return callback(input);
      if (inherited) {assertInvocation(operation, input); return callback(input);}
      const frozen = freezeOpacityCandidateInput(input);
      const entry: Invocation = Object.freeze({store, origin: restored?.workspaceOrigin ?? '', operation, inputDigest: digest(frozen), projectId: object(frozen) ? frozen.projectId : undefined, signal: options.signal, validate});
      const state = {live: true}; lifetimes.set(entry, state);
      const revoke = (): void => {state.live = false;};
      options.signal?.addEventListener('abort', revoke, {once: true});
      const finish = (): void => {revoke(); options.signal?.removeEventListener('abort', revoke);};
      try {
        live(entry); const result = invocations.run(entry, () => callback(frozen));
        if (isPromise(result)) return result.finally(finish) as T;
        if (object(result) && typeof result.then === 'function') {finish(); unavailable();}
        finish(); return result;
      } catch (error) {finish(); throw error;}
    };
    const assembly: OpacityCandidateAssembly = Object.freeze({
      checkpoint: check,
      ownsLock: () => {try {check(); return true;} catch {return false;}},
      getRestoreContext: context,
      assertOrigin: (value?: unknown) => {
        if (!context()) return null;
        const origin = object(value) ? value.expectedWorkspaceOrigin : undefined;
        if (!uuid(origin)) restoreError('RESTORE_WORKSPACE_ORIGIN_REQUIRED');
        if (origin !== restored!.workspaceOrigin) restoreError('RESTORE_WORKSPACE_ORIGIN_MISMATCH');
        return restored;
      },
      refuseOperation: (operation: string, input?: unknown) => {
        const restore = context();
        if (OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes(operation)) {if (restore || operation === 'timeline.render') {assertInvocation(operation, input); requestVacant(operation, input);} return;}
        if (OPACITY_CANDIDATE_RESTORE_READ_OPERATIONS.includes(operation)) return;
        unavailable();
      },
      refuseTask: (taskId?: unknown, projectId?: unknown) => {
        if (!context()) return;
        if (typeof taskId === 'string' && typeof projectId === 'string' && nativePrepare(fixedDb, 'SELECT 1 FROM edit_tasks WHERE id=? AND projectId=?').get(taskId, projectId) && held('edit_tasks', taskId)) restoreError('RESTORED_RECORD_HELD');
        unavailable();
      },
      assertRequestVacant: requestVacant,
      freezeInput: freezeOpacityCandidateInput,
      withInvocation: <T>(operation: string, input: unknown, options: InvocationOptions, callback: (value: unknown) => T) => runInvocation(operation, input, options, undefined, callback),
      hasInvocation: (operation: string, input: unknown) => {
        check(); const entry = invocations.getStore(); if (!entry) return false;
        if (entry.store !== store) unavailable();
        assertInvocation(operation, input); return true;
      },
      effectFence: () => {const inherited = invocations.getStore();if (!context() && inherited?.operation !== 'timeline.render') return undefined; const entry = live(inherited); return () => {live(entry);};},
      withTaskInvocation: <T>(row: unknown, options: InvocationOptions, callback: () => T): T => {
        if (object(row) && row.operation === 'timeline.render') unavailable();
        if (!context()) return callback();
        if (!object(row) || !uuid(row.id) || !uuid(row.projectId) || typeof row.operation !== 'string' || typeof row.input !== 'string' ||
            typeof row.digest !== 'string' || typeof row.claim !== 'string' || !row.claim || typeof row.claimInstance !== 'string' || row.executionEpoch !== restored!.workspaceOrigin || held('edit_tasks', row.id)) unavailable();
        const identity = Object.freeze({id: row.id, projectId: row.projectId, operation: row.operation, input: row.input, digest: row.digest, claim: row.claim, claimInstance: row.claimInstance, executionEpoch: row.executionEpoch});
        const validate = (): void => {
          const actual = nativePrepare(fixedDb, 'SELECT id,projectId,operation,input,digest,claim,claimInstance,executionEpoch,status FROM edit_tasks WHERE id=? AND projectId=?').get(identity.id, identity.projectId);
          if (!actual || actual.status !== 'dispatching' || actual.executionEpoch !== restored!.workspaceOrigin || !actual.claim ||
              Object.entries(identity).some(([key, value]) => actual[key] !== value) || held('edit_tasks', identity.id)) unavailable();
        };
        validate();
        let input: unknown; try {input = freezeOpacityCandidateInput(JSON.parse(identity.input) as unknown);} catch {unavailable();}
        if (digest({operation: identity.operation, input}) !== identity.digest) unavailable();
        return runInvocation(identity.operation, input, options, validate, callback);
      },
      bindExport: (operation: string, input: unknown, value: unknown, requestHash: string): void => {
        check(); assertInvocation(operation, input);
        if (operation !== 'timeline.render' || !object(input) || !object(value) || !fixedDb.isTransaction ||
            !uuid(value.id) || !uuid(value.projectId) || value.projectId !== input.projectId || value.requestId !== input.requestId ||
            value.mode !== 'timeline' || value.status !== 'queued' || value.assetId !== null || value.url !== null ||
            requestHash !== digest({operation, input}) || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) unavailable();
        requestVacant(operation, input);
        const row = nativePrepare(fixedDb, 'SELECT id,projectId,data FROM exports WHERE id=? AND projectId=?').get(value.id, value.projectId);
        const receipt = nativePrepare(fixedDb, 'SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(String(input.requestId));
        if (!row || row.data !== JSON.stringify(value) || !receipt || receipt.requestHash !== requestHash || receipt.response !== row.data) unavailable();
        if (restored) {
          const identityHash = digest(Object.fromEntries(['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'orderedVersionIds', 'snapshot', 'createdAt'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
          nativePrepare(fixedDb, 'INSERT INTO workspace_restore_export_origins(exportId,projectId,workspaceOrigin,requestScope,requestId,requestHash,identityHash) VALUES(?,?,?,?,?,?,?)')
            .run(value.id, value.projectId, restored.workspaceOrigin, 'timeline.render', String(input.requestId), requestHash, identityHash);
        }
      },
      readOperations: OPACITY_CANDIDATE_RESTORE_READ_OPERATIONS,
      localOperations: OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS,
    });
    assemblies.set(store, {assembly, check}); return store;
  } catch (error) {
    try {db?.close();} catch {}
    lease?.release(); throw error;
  }
}
