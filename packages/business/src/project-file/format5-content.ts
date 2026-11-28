import type {DatabaseSync} from 'node:sqlite';
import {FORMAT5_LIMITS, format5SyncBaselineSchema} from '../../../contracts/src/project-format5.ts';
import type {Format5Timeline, Format5TimelineHeader} from '../../../contracts/src/project-format5.ts';
import {validateFormat5SequenceGraph} from './format5-sequence-mapping.ts';
import {INSPECTION_ROW_LIMITS} from '../inspection-query.ts';
import {readFormat5JsonRows} from './format5-rows.ts';
import {assertFormat5TimelineRows, fenceFormat5TimelineRows, invalidFormat5Timeline} from './format5-timeline.ts';

export {readFormat5JsonRows, invalidFormat5Content} from './format5-rows.ts';

type ProjectSchema = 'main' | 'project';
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = (values: readonly unknown[]): Set<string> => new Set(values.filter((value): value is string => typeof value === 'string'));

interface Format5GraphProjection {
  readonly shots: readonly Row[];
  readonly nodes: readonly Row[];
  readonly edges: readonly Row[];
  readonly versions: readonly Row[];
  readonly assets: readonly Row[];
  readonly subjects: readonly Row[];
  readonly subjectVersions: readonly Row[];
  readonly subjectBindings: readonly Row[];
  readonly adoptions: readonly Row[];
  readonly retainedShots: readonly Row[];
}

/** One bounded read of the graph/ownership projection. `timeline` optionally
 * extends the version and asset selection to the requested clips. */
function readGraphProjection(db: DatabaseSync, schema: ProjectSchema, timeline: Format5Timeline | null): Format5GraphProjection {
  const shots = readFormat5JsonRows(db, schema, 'shots', true);
  const nodes = readFormat5JsonRows(db, schema, 'nodes', true);
  const edges = readFormat5JsonRows(db, schema, 'edges', true);
  const subjects = db.prepare(`SELECT * FROM ${schema}.subjects ORDER BY id`).all() as Row[];
  const subjectBindings = db.prepare(`SELECT * FROM ${schema}.subject_bindings ORDER BY id`).all() as Row[];
  const subjectVersionIds = ids([...subjects.map(value => value.headVersionId), ...subjectBindings.map(value => value.subjectVersionId)]);
  const subjectVersions = (db.prepare(`SELECT * FROM ${schema}.subject_versions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify([...subjectVersionIds])) as Row[]).map(row => {
      if (typeof row.data !== 'string') return invalidFormat5Timeline();
      let value: unknown;
      try { value = JSON.parse(row.data); } catch { return invalidFormat5Timeline(); }
      if (!object(value) || ['id', 'projectId', 'subjectId', 'number', 'assetId'].some(column => value[column] !== row[column])) return invalidFormat5Timeline();
      return value;
    });
  const adoptions = db.prepare(`SELECT * FROM ${schema}.shot_version_adoptions ORDER BY shotId,versionId`).all() as Row[];
  const clips = timeline?.clips ?? [];
  const versions = readFormat5JsonRows(db, schema, 'versions', false, ids([
    ...shots.map(value => value.selectedVersionId), ...clips.map(value => value.versionId), ...adoptions.map(value => value.versionId),
  ]));
  const assetIds = ids([...nodes.map(value => value.assetId), ...edges.map(value => value.sourceAssetId),
    ...clips.map(value => value.assetId), ...versions.map(value => value.assetId), ...subjectVersions.map(value => value.assetId)]);
  const assets = readFormat5JsonRows(db, schema, 'assets', false, assetIds);
  return {
    shots, nodes, edges, versions, assets, subjects, subjectVersions, subjectBindings, adoptions,
    retainedShots: db.prepare(`SELECT id,projectId FROM ${schema}.shots ORDER BY id`).all() as Row[],
  };
}

function readProjectIdentity(db: DatabaseSync, schema: ProjectSchema): string {
  const identity = db.prepare(`SELECT projectId FROM ${schema}.project_file WHERE singleton=1`).get();
  if (typeof identity?.projectId !== 'string') return invalidFormat5Timeline();
  return identity.projectId;
}

function assertSyncStates(db: DatabaseSync, schema: ProjectSchema, header: {readonly id: string; readonly sequenceNodeId: string} | null,
  projectId: string, deep: boolean): void {
  const states = db.prepare(`SELECT timelineId,projectId,sequenceNodeId,revision,baseline FROM ${schema}.sequence_sync_state ORDER BY timelineId`).all() as Row[];
  if (states.length !== (header ? 1 : 0)) return invalidFormat5Timeline();
  for (const state of states) {
    if (!header || state.timelineId !== header.id || state.projectId !== projectId ||
        header.sequenceNodeId !== state.sequenceNodeId || !Number.isSafeInteger(state.revision) || Number(state.revision) < 1 ||
        typeof state.baseline !== 'string' || Buffer.byteLength(state.baseline) > FORMAT5_LIMITS.baselineBytes) invalidFormat5Timeline();
    if (deep) {
      try { format5SyncBaselineSchema.parse(JSON.parse(state.baseline as string)); } catch { invalidFormat5Timeline(); }
    } else {
      // The cheap shape check keeps a commit fence linear; the full zod schema
      // (unique identities and ordered groups) runs when a project is opened.
      const shape = db.prepare(`SELECT CASE WHEN json_valid(?) THEN
          json_type(?)= 'object' AND json_extract(?,'$.version') IS 1
          AND json_type(?,'$.board')='array' AND json_array_length(?,'$.board')<=${FORMAT5_LIMITS.mainTrackClips}
          AND json_type(?,'$.track')='array' AND json_array_length(?,'$.track')<=${FORMAT5_LIMITS.mainTrackClips}
        ELSE 0 END AS ok`).get(...Array.from({length: 7}, () => state.baseline as string)) as Row;
      if (!shape.ok) invalidFormat5Timeline();
    }
  }
}

/** Checks only the project file, including a read-only file without history.
 * The same full-state validator also fences the converted transaction. */
export function assertFormat5ProjectContent(db: DatabaseSync, schema: ProjectSchema): void {
  const projectId = readProjectIdentity(db, schema);
  const timeline = assertFormat5TimelineRows(db, schema);
  const formatVersion = Number(db.prepare(`PRAGMA ${schema}.user_version`).get()?.user_version);
  const graph = readGraphProjection(db, schema, timeline);
  try {
    validateFormat5SequenceGraph({
      projectId, shots: graph.shots, nodes: graph.nodes, edges: graph.edges, versions: graph.versions,
      assets: graph.assets, subjects: graph.subjects, subjectVersions: graph.subjectVersions,
      subjectBindings: graph.subjectBindings, adoptions: graph.adoptions, retainedShots: graph.retainedShots,
      ...(timeline ? {timeline, formatVersion} : {}),
    });
  } catch { invalidFormat5Timeline(); }
  assertSyncStates(db, schema, timeline ? {id: timeline.id, sequenceNodeId: timeline.mainTrack.sequenceNodeId} : null, projectId, true);
}

/** Terminal commit fence for a format-5 content change. The timeline domain is
 * checked by indexed SQL invariants; the board/edge domain keeps the SA graph
 * validation (those rows are compact and unchanged by timeline edits). */
export function fenceFormat5ProjectContent(db: DatabaseSync, schema: ProjectSchema): void {
  const projectId = readProjectIdentity(db, schema);
  const {header} = fenceFormat5TimelineRows(db, schema);
  const graph = readGraphProjection(db, schema, null);
  let derived!: ReturnType<typeof validateFormat5SequenceGraph>;
  try {
    derived = validateFormat5SequenceGraph({
      projectId, shots: graph.shots, nodes: graph.nodes, edges: graph.edges, versions: graph.versions,
      assets: graph.assets, subjects: graph.subjects, subjectVersions: graph.subjectVersions,
      subjectBindings: graph.subjectBindings, adoptions: graph.adoptions, retainedShots: graph.retainedShots,
    });
  } catch { invalidFormat5Timeline(); }
  assertSyncStates(db, schema, header ? {id: header.id, sequenceNodeId: header.mainTrack.sequenceNodeId} : null, projectId, false);
  if (!header) return;
  // The main track order must be the derived chain order for the bound root.
  const chain = derived.derived.chains.find(item => item.filmId === header.mainTrack.sequenceNodeId);
  if (!chain) invalidFormat5Timeline();
  const rows = db.prepare(`SELECT sourceNodeId FROM ${schema}.timeline_clips WHERE trackId=? ORDER BY startFrame,id`)
    .all(header.mainTrack.trackId) as Row[];
  const groups: string[] = [];
  for (const row of rows) if (typeof row.sourceNodeId === 'string' && groups.at(-1) !== row.sourceNodeId) groups.push(row.sourceNodeId);
  if (groups.length !== chain!.nodeIds.length || groups.some((nodeId, index) => nodeId !== chain!.nodeIds[index])) invalidFormat5Timeline();
}
