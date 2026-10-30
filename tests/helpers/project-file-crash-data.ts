// The rows of the SIGKILL tests (tests/project-file-crash.test.ts and the crash
// modes of project-file-child.ts): a counter k written in one transaction to a
// content row in the project file and to two local records in history.db.
import type {DatabaseSync} from 'node:sqlite';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';

export const MIB = 1024 * 1024;
export const CRASH_SHOT_ID = '5d0c6c4e-8f3b-4d36-9a52-1b7e3f0a9c21';

/** `bytes` of a letter that changes with k, so a commit rewrites every page of
 * the previous payload. */
export const crashPad = (k: number, bytes: number): string => String.fromCharCode(97 + k % 26).repeat(bytes);

export function addCrashProject(store: ProjectStore): void {
  const now = new Date().toISOString();
  store.put('projects', {id: store.projectId, name: 'K1 crash', description: '', revision: 1, createdAt: now, updatedAt: now});
}

/** Writes k: shots (project file) and timeline_history_cursors and idempotency
 * (history.db), each an upsert of the same row. */
export function writeCrashRows(store: ProjectStore, k: number, pad: string): void {
  const {db, projectId} = store;
  db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
    .run(CRASH_SHOT_ID, projectId, JSON.stringify({k, pad}));
  db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET position=excluded.position')
    .run(projectId, k);
  db.prepare("INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES('k1-crash','current',?,?) ON CONFLICT(scope,requestId) DO UPDATE SET requestHash=excluded.requestHash,resourceId=excluded.resourceId")
    .run(pad, String(k));
}

export interface CrashRows {
  /** k of the shot in the project file. */
  readonly content: number;
  /** k of the timeline cursor in history.db. */
  readonly records: number;
  /** k of the receipt in history.db. */
  readonly receipt: number;
  /** The shot and the receipt carry the same payload. */
  readonly samePad: boolean;
}

export function readCrashRows(db: DatabaseSync, projectId: string): CrashRows {
  const receipt = "FROM main.idempotency WHERE scope='k1-crash' AND requestId='current'";
  const row = db.prepare(`SELECT
    (SELECT json_extract(data,'$.k') FROM project.shots WHERE id=?) AS content,
    (SELECT position FROM main.timeline_history_cursors WHERE projectId=?) AS records,
    (SELECT CAST(resourceId AS INTEGER) ${receipt}) AS receipt,
    (SELECT json_extract(data,'$.pad') FROM project.shots WHERE id=?) IS (SELECT requestHash ${receipt}) AS samePad`)
    .get(CRASH_SHOT_ID, projectId, CRASH_SHOT_ID);
  return {content: Number(row?.content), records: Number(row?.records), receipt: Number(row?.receipt), samePad: row?.samePad === 1};
}
