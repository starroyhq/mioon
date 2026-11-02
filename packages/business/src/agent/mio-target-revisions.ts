import type {DatabaseSync} from 'node:sqlite';
import type {AgentTaskTarget} from '../../../contracts/src/agent-tasks-v2.ts';
import {isProjectDatabase} from '../project-file/connection.ts';

const processKinds = new Set(['job', 'export', 'image_task', 'frame_task']);
const contentTable = 'project.agent_task_target_revisions_v2';
const processTable = 'main.mio_process_target_revisions';
const legacyTable = 'agent_task_target_revisions_v2';

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error('Target revision evidence is invalid'), {code: 'AGENT_TASK_STORAGE_CORRUPT'});
  }
  return value;
}

/** The kernel owns the connection identity. Legacy callers keep their existing
 * single-table layout until S0 switches the production opener. No table probes
 * or caller-supplied flags decide which revision ledger is authoritative. */
export function readMioTargetRevision(db: DatabaseSync, projectId: string, kind: string, targetId: string): number | undefined {
  const table = isProjectDatabase(db) ? processKinds.has(kind) ? processTable : contentTable : legacyTable;
  const row = db.prepare(`SELECT revision FROM ${table} WHERE projectId=? AND kind=? AND targetId=?`).get(projectId, kind, targetId);
  return row === undefined ? undefined : revision(row.revision);
}

/** Freeze both ledgers in the same connection/read transaction and keep the
 * original stable order used by conflict detection and request assembly. */
export function readMioTargetRevisions(db: DatabaseSync, projectId: string): AgentTaskTarget[] {
  const rows = isProjectDatabase(db)
    ? db.prepare(`SELECT kind,targetId,revision FROM ${contentTable} WHERE projectId=?
        UNION ALL SELECT kind,targetId,revision FROM ${processTable} WHERE projectId=? ORDER BY kind,targetId`).all(projectId, projectId)
    : db.prepare(`SELECT kind,targetId,revision FROM ${legacyTable} WHERE projectId=? ORDER BY kind,targetId`).all(projectId);
  return rows.map(row => ({kind: String(row.kind), id: String(row.targetId), revision: revision(row.revision)}));
}
