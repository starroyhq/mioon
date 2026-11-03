import {isAsyncFunction} from 'node:util/types';
import {isProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';
import {canonicalJson, validateProjectDocument} from '../project-versions/document.ts';
import type {ProjectDocument, SnapshotRow} from '../project-versions/document.ts';
import {restoreAdmissionKey,withRestoreAdmissionRowsInside} from './cross-file/restore-admission.ts';

export interface RestoreAdmissionRow {readonly table: 'scene_results' | 'subject_versions'; readonly row: SnapshotRow}
const identity = (table: string, row: SnapshotRow): string => restoreAdmissionKey(table,canonicalJson(row));

/** Only missing, exact rows from the validated final plan may bypass the
 * publication-time condition of two guards. No task or batch is fabricated.
 * The permission never survives its synchronous call, including a throw. */
export function withProjectRestoreScopeInside<T>(store: ProjectStore, document: ProjectDocument, rows: readonly RestoreAdmissionRow[], run: () => T): T {
  if (!isProjectStore(store) || !store.db.isTransaction || isAsyncFunction(run)) throw new TypeError('Restore admission requires the original live store and one synchronous transaction');
  validateProjectDocument(document);
  if (document.projectId !== store.projectId) throw new TypeError('Restore admission belongs to another project');
  const allowed = new Set<string>();
  for (const {table, row} of rows) {
    if (table !== 'scene_results' && table !== 'subject_versions') throw new TypeError('Unsupported restore admission table');
    const key = identity(table, row);
    if (!document.tables[table].some(candidate => identity(table, candidate) === key)
      || store.db.prepare(`SELECT 1 FROM project.${table} WHERE id=?`).get(String(row.id))) throw new TypeError('Restore admission must name an exact missing row in the plan');
    allowed.add(key);
  }
  return withRestoreAdmissionRowsInside(store.db,allowed,()=>isProjectStore(store),()=>{
    const result = run();
    if (result && typeof (result as {then?: unknown}).then === 'function') throw new TypeError('Restore admission cannot cross an asynchronous boundary');
    return result;
  });
}
