import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import {isProjectDatabase} from './project-file/held-files.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import type {CanvasArchiveTable} from './project-file/schema/domains/canvas.ts';

/** The held kernel has already validated the matching on-disk manifest. */
export function hasCanvasArchives(db: DatabaseSync): boolean {
  return isProjectDatabase(db) && db.prepare('PRAGMA project.user_version').get()?.user_version === FORMAT4_PROJECT_SCHEMA_VERSION;
}

/** Supply only the fixed alias from the calling SQL statement. Legacy
 * readers must not mention a column that does not exist in format 3. */
export function canvasActiveCondition(db: DatabaseSync, alias?: string): string {
  if (alias !== undefined && !/^[A-Za-z_]\w*$/u.test(alias)) throw new TypeError('Invalid canvas SQL alias');
  return hasCanvasArchives(db) ? `${alias ? alias + '.' : ''}archivedAt IS NULL` : '1';
}

/** A live edge may stay physically present while either endpoint is
 * archived. Its hidden state must also apply to paginated reads and counts. */
export function canvasActiveEdgeCondition(db: DatabaseSync, alias: string): string {
  const condition = canvasActiveCondition(db, alias);
  if (condition === '1') return condition;
  const data = `CASE WHEN typeof(${alias}.data)='text' AND length(CAST(${alias}.data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.edges}
    THEN CASE WHEN json_valid(${alias}.data) THEN ${alias}.data END END`;
  const endpoints = `(json_extract(${data},'$.source'),json_extract(${data},'$.target'))`;
  return `${condition} AND NOT EXISTS(SELECT 1 FROM project.shots s WHERE s.projectId=${alias}.projectId AND s.archivedAt IS NOT NULL AND s.id IN ${endpoints})
    AND NOT EXISTS(SELECT 1 FROM project.nodes n WHERE n.projectId=${alias}.projectId AND n.archivedAt IS NOT NULL AND n.id IN ${endpoints})`;
}

export function isCanvasArchived(db: DatabaseSync, table: CanvasArchiveTable, id: string): boolean {
  return hasCanvasArchives(db) && Boolean(db.prepare(`SELECT 1 FROM project.${table} WHERE id=? AND archivedAt IS NOT NULL`).get(id));
}

/** Call after validating the relational owner. This is new-effect admission,
 * independent from replaying or inspecting an already committed receipt. */
export function assertCanvasTargetActive(db: DatabaseSync, table: CanvasArchiveTable, id: string): void {
  if (isCanvasArchived(db, table, id)) throw new AppError('CANVAS_TARGET_ARCHIVED', '画布对象已删除，请先恢复。', 409, {id});
}

export function isCanvasEdgeHidden(db: DatabaseSync, edge: {id?: unknown; source?: unknown; target?: unknown}): boolean {
  if (!hasCanvasArchives(db)) return false;
  if (typeof edge.id === 'string' && isCanvasArchived(db, 'edges', edge.id)) return true;
  const endpoint = db.prepare('SELECT 1 FROM project.shots WHERE id=? AND archivedAt IS NOT NULL UNION ALL SELECT 1 FROM project.nodes WHERE id=? AND archivedAt IS NOT NULL LIMIT 1');
  return [edge.source, edge.target].some(id => typeof id === 'string' && endpoint.get(id, id) !== undefined);
}

/** Keep legacy materialization intact. On format 4 the SQL projection also
 * prevents inactive JSON from crossing into an active consumer. */
export function listActiveCanvasRecords<T>(db: DatabaseSync, table: CanvasArchiveTable, projectId: string, legacy: () => T[]): T[] {
  const predicate = table === 'edges' ? canvasActiveEdgeCondition(db, 'record') : canvasActiveCondition(db, 'record');
  if (predicate === '1') return legacy();
  return db.prepare(`SELECT data FROM project.${table} record WHERE projectId=? AND ${predicate} ORDER BY rowid`).all(projectId)
    .map(row => JSON.parse(String(row.data)) as T);
}
