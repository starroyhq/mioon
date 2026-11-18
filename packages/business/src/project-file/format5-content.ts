import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {FORMAT5_LIMITS, format5SyncBaselineSchema} from '../../../contracts/src/project-format5.ts';
import {validateFormat5SequenceGraph} from './format5-sequence-mapping.ts';
import {INSPECTION_ROW_LIMITS} from '../inspection-query.ts';

type ProjectSchema = 'main' | 'project';
type JsonTable = 'shots' | 'nodes' | 'edges' | 'assets' | 'versions' | 'timelines';
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(): never {
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
    if (typeof row.data !== 'string') return invalid();
    let value: unknown;
    try { value = JSON.parse(row.data); } catch { return invalid(); }
    if (!object(value) || value.id !== row.id || value.projectId !== row.projectId) return invalid();
    if (table === 'versions' && value.jobId !== row.jobId) return invalid();
    return value;
  });
}

/** Checks only the project file, including a read-only file without history.
 * The same full-state validator also fences the converted transaction. */
export function assertFormat5ProjectContent(db: DatabaseSync, schema: ProjectSchema): void {
  const identity = db.prepare(`SELECT projectId FROM ${schema}.project_file WHERE singleton=1`).get();
  if (typeof identity?.projectId !== 'string') invalid();
  const timelines = readFormat5JsonRows(db, schema, 'timelines');
  if (timelines.length > 1) invalid();
  try {
    const shots = readFormat5JsonRows(db, schema, 'shots', true);
    const nodes = readFormat5JsonRows(db, schema, 'nodes', true);
    const edges = readFormat5JsonRows(db, schema, 'edges', true);
    const ids = (values: readonly unknown[]): Set<string> => new Set(values.filter((value): value is string => typeof value === 'string'));
    const subjects = db.prepare(`SELECT * FROM ${schema}.subjects ORDER BY id`).all();
    const subjectBindings = db.prepare(`SELECT * FROM ${schema}.subject_bindings ORDER BY id`).all();
    const subjectVersionIds = ids([...subjects.map(value => value.headVersionId), ...subjectBindings.map(value => value.subjectVersionId)]);
    const subjectVersions = db.prepare(`SELECT * FROM ${schema}.subject_versions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify([...subjectVersionIds])).map(row => {
      if (typeof row.data !== 'string') return invalid();
      const value: unknown = JSON.parse(row.data);
      if (!object(value) || ['id', 'projectId', 'subjectId', 'number', 'assetId'].some(column => value[column] !== row[column])) return invalid();
      return value;
    });
    const adoptions = db.prepare(`SELECT * FROM ${schema}.shot_version_adoptions ORDER BY shotId,versionId`).all();
    const clips = timelines.flatMap(value => Array.isArray(value.clips) ? value.clips.filter(object) : []);
    const versions = readFormat5JsonRows(db, schema, 'versions', false, ids([
      ...shots.map(value => value.selectedVersionId), ...clips.map(value => value.versionId), ...adoptions.map(value => value.versionId),
    ]));
    const assetIds = ids([...nodes.map(value => value.assetId), ...edges.map(value => value.sourceAssetId),
      ...clips.map(value => value.assetId), ...versions.map(value => value.assetId), ...subjectVersions.map(value => value.assetId)]);
    validateFormat5SequenceGraph({
      projectId: identity.projectId,
      shots, nodes, edges, versions, subjects, subjectVersions, subjectBindings, adoptions,
      retainedShots: db.prepare(`SELECT id,projectId FROM ${schema}.shots ORDER BY id`).all(),
      assets: readFormat5JsonRows(db, schema, 'assets', false, assetIds),
      ...(timelines[0] ? {timeline: timelines[0]} : {}),
    });
    const states = db.prepare(`SELECT timelineId,projectId,sequenceNodeId,revision,baseline FROM ${schema}.sequence_sync_state ORDER BY timelineId`).all();
    if (states.length !== timelines.length) invalid();
    for (const state of states) {
      const timeline = timelines.find(value => value.id === state.timelineId);
      if (!timeline || !object(timeline.mainTrack) || timeline.mainTrack.sequenceNodeId !== state.sequenceNodeId ||
          state.projectId !== identity.projectId || !Number.isSafeInteger(state.revision) || Number(state.revision) < 1 ||
          typeof state.baseline !== 'string' || Buffer.byteLength(state.baseline) > FORMAT5_LIMITS.baselineBytes) invalid();
      format5SyncBaselineSchema.parse(JSON.parse(state.baseline));
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROJECT_INVALID') throw error;
    invalid();
  }
}
