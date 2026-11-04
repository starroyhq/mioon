import {createHash} from 'node:crypto';
import {calculateWorkspaceScope} from '@mioon/contracts/workspace-scope';
import {heldProjectHistoryIdentity, isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {SQLInputValue} from 'node:sqlite';

export type LocalDraftRepositoryReason = 'OWNER_REQUIRED' | 'SCOPE_MISMATCH' | 'CONFLICT' | 'LIMIT' | 'CAPACITY' | 'STORAGE_UNAVAILABLE' | 'SAVE_UNCERTAIN';
export class LocalDraftRepositoryError extends Error {
  readonly reason: LocalDraftRepositoryReason;
  constructor(reason: LocalDraftRepositoryReason, cause?: unknown) {
    super('Local draft storage is unavailable', {cause});
    this.reason = reason;
  }
}
export type LocalDraftKind = 'clip' | 'delivery' | 'shot-text';
interface DraftBundle {version: number; workspaceScope: string; entries: readonly object[]}
interface RepositoryOptions<Disk extends DraftBundle> {
  store: ProjectStore;
  kind: LocalDraftKind;
  ownsLock(): boolean;
  channel?: 'web' | 'production' | 'development';
  signal?: AbortSignal;
  relocate?: () => void;
  validate(value: unknown): Disk;
  fault?: (point: 'beforeCommit' | 'afterCommit') => void;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function localDraftDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
}
const DEFINITIONS = {
  clip: {table: 'local_clip_drafts', version: 2, keys: ['projectId', 'timelineId', 'clipId'], revisions: ['revision'], rowBytes: 8192, envelopeBytes: 2097152},
  delivery: {table: 'local_delivery_drafts', version: 1, keys: ['projectId'], revisions: ['draftRevision', 'intentRevision'], rowBytes: 8192, envelopeBytes: 2097152},
  'shot-text': {table: 'local_shot_text_drafts', version: 1, keys: ['projectId', 'shotId'], revisions: ['draftRevision', 'intentRevision'], rowBytes: 262144, envelopeBytes: 16777216},
} as const;
function failure(reason: LocalDraftRepositoryReason, cause?: unknown): never {throw new LocalDraftRepositoryError(reason, cause);}

/** One bounded typed bundle on the host's exact connection. The bundle is an
 * application value only; no legacy JSON file is read, created or repaired. */
export function createLocalDraftRepository<Disk extends DraftBundle>({store, kind, ownsLock, channel = 'web', signal, relocate, validate, fault}: RepositoryOptions<Disk>) {
  const definition = DEFINITIONS[kind];
  if (!definition || !['web', 'production', 'development'].includes(channel)) throw new TypeError('Invalid local draft repository');
  let initialScope: string | undefined;
  function scope(): string {
    if (signal?.aborted) failure('STORAGE_UNAVAILABLE');
    if (!isProjectStore(store) || ownsLock() !== true) failure('OWNER_REQUIRED');
    const identity = heldProjectHistoryIdentity(store);
    const current = calculateWorkspaceScope({channel, root: store.localDir, ...identity});
    if (initialScope !== undefined && initialScope !== current) failure('SCOPE_MISMATCH');
    initialScope = current;
    return current;
  }
  function safe<T>(work: () => T): T {
    try {return work();}
    catch (error) {
      const raw = error as {code?: unknown; errcode?: unknown; message?: unknown} | null;
      // A committed write may already have been wrapped as SAVE_UNCERTAIN.
      // Preserve relocation even through that safe public-error boundary.
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && object(cause); depth++, cause = cause.cause) {
        if (cause.code === 'PROJECT_FILE_MOVED' || Number(cause.errcode) === 1032 || cause.code === 'SQLITE_READONLY_DBMOVED') {relocate?.(); break;}
      }
      if (error instanceof LocalDraftRepositoryError) throw error;
      if (raw?.code === 'PROJECT_HISTORY_IDENTITY_CHANGED') failure('SCOPE_MISMATCH', error);
      const message = typeof raw?.message === 'string' ? raw.message : '';
      if (message.includes('LOCAL_DRAFT_SQL_CONFLICT')) failure('CONFLICT', error);
      if (message.includes('LOCAL_DRAFT_SQL_CAPACITY')) failure('CAPACITY', error);
      if (message.includes('local_draft_row_limit')) failure('LIMIT', error);
      failure('STORAGE_UNAVAILABLE', error);
    }
  }
  function rawRows() {
    return store.db.prepare(`SELECT rowid,ordinal,data FROM main.${definition.table} ORDER BY ordinal LIMIT 129`).all();
  }
  function read(): Disk {
    const workspaceScope = scope();
    const state = store.db.prepare('SELECT workspaceScope FROM main.local_draft_states WHERE kind=?').get(kind);
    const rows = rawRows();
    if (!state && rows.length) failure('STORAGE_UNAVAILABLE');
    if (state && state.workspaceScope !== workspaceScope) failure('SCOPE_MISMATCH');
    if (rows.length > 128) failure('STORAGE_UNAVAILABLE');
    const entries = rows.map(row => {
      if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > definition.rowBytes) failure('STORAGE_UNAVAILABLE');
      return JSON.parse(row.data) as unknown;
    });
    const disk = validate({version: definition.version, workspaceScope, entries});
    const keys = new Set<string>();
    for (const entry of disk.entries) {
      if (!object(entry) || entry.projectId !== store.projectId) failure('STORAGE_UNAVAILABLE');
      const key = keyOf(entry);
      if (keys.has(key)) failure('STORAGE_UNAVAILABLE');
      keys.add(key);
    }
    if (Buffer.byteLength(JSON.stringify(disk) + '\n') > definition.envelopeBytes) failure('STORAGE_UNAVAILABLE');
    scope();
    return disk;
  }
  function keyOf(row: Record<string, unknown>): string {return JSON.stringify(definition.keys.map(key => row[key]));}
  function columns(row: Record<string, unknown>): {names: string[]; values: SQLInputValue[]} {
    const names: string[] = [...definition.keys, ...definition.revisions];
    const values = names.map(name => row[name] as SQLInputValue);
    if (kind !== 'clip') {
      const intent = object(row.intent) ? row.intent : null;
      const input = intent && object(intent.input) ? intent.input : null;
      const outcome = intent && object(intent.outcome) ? intent.outcome : null;
      names.push('intentId', 'requestId', 'intentStatus');
      values.push(intent?.intentId as string ?? null, input?.requestId as string ?? null, outcome?.status as string ?? null);
    }
    names.push('data'); values.push(JSON.stringify(row));
    return {names, values};
  }
  function save(disk: Disk, expectedDigest: string, check?: () => void): void {
    // 0.1.0 has no Windows successful-write contract. Refuse before BEGIN,
    // including requests that would otherwise just acknowledge a replay.
    if (process.platform === 'win32') failure('STORAGE_UNAVAILABLE');
    let committed = false;
    try {
      const workspaceScope = scope();
      if (disk.workspaceScope !== workspaceScope) failure('SCOPE_MISMATCH');
      const next = validate(disk);
      if (next.version !== definition.version) failure('STORAGE_UNAVAILABLE');
      if (next.entries.some(row => Buffer.byteLength(JSON.stringify(row)) > definition.rowBytes)) failure('LIMIT');
      if (next.entries.length > 128 || Buffer.byteLength(JSON.stringify(next) + '\n') > definition.envelopeBytes) failure('CAPACITY');
      store.tx(() => {
        const before = read();
        if (localDraftDigest(before) !== expectedDigest) failure('CONFLICT');
        check?.();
        const oldRows = rawRows();
        const old = new Map(oldRows.map(row => {
          const data = JSON.parse(String(row.data)) as Record<string, unknown>;
          return [keyOf(data), {row, data}] as const;
        }));
        const wanted = new Map<string, Record<string, unknown>>();
        for (const row of next.entries) {
          if (!object(row) || row.projectId !== store.projectId) failure('STORAGE_UNAVAILABLE');
          const key = keyOf(row);
          if (wanted.has(key)) failure('STORAGE_UNAVAILABLE');
          wanted.set(key, row);
        }
        const expectedOrder = [...old.keys()].filter(key => wanted.has(key)).concat([...wanted.keys()].filter(key => !old.has(key)));
        if (JSON.stringify(expectedOrder) !== JSON.stringify([...wanted.keys()])) failure('CONFLICT');
        if (wanted.size && !store.db.prepare('SELECT 1 FROM main.local_draft_states WHERE kind=?').get(kind)) {
          store.db.prepare('INSERT INTO main.local_draft_states(kind,workspaceScope) VALUES(?,?)').run(kind, workspaceScope);
        }
        for (const [key, previous] of old) {
          if (!wanted.has(key)) {
            const removed = store.db.prepare(`DELETE FROM main.${definition.table} WHERE rowid=? AND data=?`).run(previous.row.rowid, previous.row.data);
            if (Number(removed.changes) !== 1) failure('CONFLICT');
          }
        }
        let ordinal = Math.max(0, ...oldRows.map(row => Number(row.ordinal)));
        for (const [key, row] of wanted) {
          const previous = old.get(key), projected = columns(row);
          if (previous) {
            if (JSON.stringify(row) === previous.row.data) continue;
            const names = projected.names.filter(name => !definition.keys.some(key => key === name));
            const values = names.map(name => projected.values[projected.names.indexOf(name)]);
            const changed = store.db.prepare(`UPDATE main.${definition.table} SET ${names.map(name => `${name}=?`).join(',')} WHERE rowid=? AND data=? AND ${definition.revisions.map(name => `${name}=?`).join(' AND ')}`)
              .run(...values, previous.row.rowid, previous.row.data, ...definition.revisions.map(name => previous.data[name] as SQLInputValue));
            if (Number(changed.changes) !== 1) failure('CONFLICT');
          } else {
            if (!Number.isSafeInteger(++ordinal)) failure('CAPACITY');
            store.db.prepare(`INSERT INTO main.${definition.table}(${projected.names.join(',')},ordinal) VALUES(${projected.names.map(() => '?').join(',')},?)`).run(...projected.values, ordinal);
          }
        }
        if (localDraftDigest(read()) !== localDraftDigest(next)) failure('CONFLICT');
        fault?.('beforeCommit');
        check?.();
        if (scope() !== workspaceScope) failure('SCOPE_MISMATCH');
      });
      committed = true;
      fault?.('afterCommit');
      if (scope() !== workspaceScope) failure('SCOPE_MISMATCH');
    } catch (error) {
      if (committed) failure('SAVE_UNCERTAIN', error);
      throw error;
    }
  }
  return {scope: () => safe(scope), read: () => safe(read), save: (disk: Disk, expectedDigest: string, check?: () => void) => safe(() => save(disk, expectedDigest, check)), confirm: () => safe(() => {scope();})};
}
