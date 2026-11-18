import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {FORMAT5_LIMITS} from '../../../contracts/src/project-format5.ts';
import {INSPECTION_ROW_LIMITS} from '../inspection-query.ts';

type ProjectSchema = 'main' | 'project';
type JsonTable = 'shots' | 'nodes' | 'edges' | 'assets' | 'versions' | 'timelines';
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

export function invalidFormat5Content(): never {
  throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
}

/** The catalog is checked before these bounded JSON projections are read. */
export function readFormat5JsonRows(db: DatabaseSync, schema: ProjectSchema, table: JsonTable, activeOnly = false, selectedIds?: ReadonlySet<string>): Row[] {
  // Materialize native archive identities once per read. Looking up both
  // endpoint tables separately for every edge repeats the same archive work.
  // Keep filtering in SQL, before the bounded JSON/identity projection below.
  const archive = activeOnly && table === 'edges' ? `WITH archived_endpoints AS MATERIALIZED (
    SELECT id,projectId FROM ${schema}.shots WHERE archivedAt IS NOT NULL
    UNION ALL SELECT id,projectId FROM ${schema}.nodes WHERE archivedAt IS NOT NULL
  ) ` : '';
  const active = !activeOnly ? '' : table === 'edges'
    ? ` WHERE archivedAt IS NULL
        AND NOT EXISTS(SELECT 1 FROM archived_endpoints endpoint WHERE endpoint.projectId=${table}.projectId AND endpoint.id IN (json_extract(${table}.data,'$.source'),json_extract(${table}.data,'$.target')))`
    : ' WHERE archivedAt IS NULL';
  const selection = selectedIds ? `${active ? ' AND' : ' WHERE'} id IN (SELECT value FROM json_each(?))` : '';
  const versionIdentity = table === 'versions' ? ',jobId' : '';
  // Format 5 adds bounded dialogue to shots. Media/node/version rows keep the
  // existing row grammar; the editable timeline has its own aggregate budget.
  const maxBytes = table === 'timelines' || table === 'shots' ? FORMAT5_LIMITS.timelineBytes : INSPECTION_ROW_LIMITS[table];
  const rows = db.prepare(`${archive}SELECT id,projectId${versionIdentity},CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM ${schema}.${table}${active}${selection} ORDER BY id`)
    .all(maxBytes, ...(selectedIds ? [JSON.stringify([...selectedIds])] : []));
  return rows.map(row => {
    if (typeof row.data !== 'string') return invalidFormat5Content();
    let value: unknown;
    try { value = JSON.parse(row.data); } catch { return invalidFormat5Content(); }
    if (!object(value) || value.id !== row.id || value.projectId !== row.projectId) return invalidFormat5Content();
    if (table === 'versions' && value.jobId !== row.jobId) return invalidFormat5Content();
    return value;
  });
}
