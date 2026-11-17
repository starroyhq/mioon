import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {format5LegacySourceSchemas} from '../../../contracts/src/project-format5-upgrade-source.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isTimelineRecord} from '../../../contracts/src/timeline-replacement.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {isProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {readProjectContentStamp, classifyHistoryStamp, sameContentStamp} from './content-stamp.ts';
import {readSchemaManifest, compareManifest} from './schema/manifest-check.ts';
import {historyManifestForVersion, projectManifestForVersion} from './schema/format-manifests.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION, PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION} from './schema/databases.ts';
import {FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION} from './schema/domains/canvas.ts';
import {removeCrossFileTriggersInside, installCrossFileTriggers} from './cross-file/install.ts';
import {foreignKeyCheck} from './cross-file/inspect.ts';
import {addFormat5HistoryStructureInside, addFormat5ProjectStructureInside, writeFormat5HistoryVersionInside, writeFormat5ProjectVersionInside} from './schema/format5-upgrade.ts';
import {assertFormat5ProjectContent, readFormat5JsonRows} from './format5-content.ts';
import {planFormat5Conversion} from './format5-conversion.ts';
import type {Format5ConversionAllocation, Format5ConversionInput, Format5ConversionPlan, Format5LegacyTimeline, Format5ProvenVersion} from './format5-conversion.ts';

const {shotSchema,nodeSchema,edgeSchema,assetSchema,versionSchema,bindingSchema,timelineSchema} = format5LegacySourceSchemas;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function invalid(code = 'FORMAT5_CONVERSION_INVALID'): never {
  throw new AppError(code, '项目转换条件已变化，请重新检查升级预览。', 409);
}
function sourceProfile(store: ProjectStore): {project: 3 | 4; history: number} {
  if (!isProjectStore(store)) throw new TypeError('Conversion requires a live kernel project store');
  const {db} = store;
  const projectRows = db.prepare('SELECT version FROM project.schema_version LIMIT 2').all();
  const historyRows = db.prepare('SELECT version FROM main.schema_version LIMIT 2').all();
  if (projectRows.length !== 1 || historyRows.length !== 1 ||
      db.prepare('PRAGMA project.application_id').get()?.application_id !== PROJECT_FILE_APPLICATION_ID ||
      db.prepare('PRAGMA main.application_id').get()?.application_id !== HISTORY_APPLICATION_ID ||
      db.prepare('SELECT projectId FROM project.project_file WHERE singleton=1').get()?.projectId !== store.projectId ||
      db.prepare('SELECT projectId FROM main.history_state WHERE singleton=1').get()?.projectId !== store.projectId) invalid();
  const project = projectRows[0]!.version;
  const history = historyRows[0]!.version;
  if (project !== PROJECT_FILE_SCHEMA_VERSION && project !== FORMAT4_PROJECT_SCHEMA_VERSION ||
      typeof history !== 'number' || ![HISTORY_SCHEMA_VERSION, FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION].includes(history)) invalid();
  if (db.prepare('PRAGMA project.user_version').get()?.user_version !== project) invalid();
  for (const [schema, manifest] of [['project', projectManifestForVersion(project)], ['main', historyManifestForVersion(history)]] as const) {
    if (!manifest) invalid();
    const differences = compareManifest(readSchemaManifest(db, schema), manifest.entries);
    if (differences.missing.length || differences.changed.length || differences.unexpected.length) invalid();
  }
  if (classifyHistoryStamp(db, false).state !== 'current' || foreignKeyCheck(db).length) invalid();
  if (project === PROJECT_FILE_SCHEMA_VERSION && history !== HISTORY_SCHEMA_VERSION ||
      project === FORMAT4_PROJECT_SCHEMA_VERSION && history !== FORMAT4_HISTORY_SCHEMA_VERSION && history !== FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION) invalid();
  return {project, history};
}

export interface Format5ConversionReadOptions {
  /** The caller supplies the project's existing output geometry when no
   * timeline exists. A new project must not acquire a guessed frame size. */
  readonly emptyTimeline?: Format5LegacyTimeline;
}

/** Reads only the already-held connection. The ownership reader validates
 * selected/used versions, including a portable version without local jobs. */
export function readFormat5ConversionInput(store: ProjectStore, {emptyTimeline}: Format5ConversionReadOptions = {}): Format5ConversionInput {
  const profile = sourceProfile(store), {db, projectId} = store;
  const projects = db.prepare('SELECT id FROM project.projects LIMIT 2').all();
  if (projects.length > 1 || projects[0] && projects[0].id !== projectId) invalid();
  const shots = readFormat5JsonRows(db, 'project', 'shots').map(row => shotSchema.parse(row));
  const nodes = readFormat5JsonRows(db, 'project', 'nodes').map(row => nodeSchema.parse(row));
  const edges = readFormat5JsonRows(db, 'project', 'edges').map(row => edgeSchema.parse(row));
  const assets = readFormat5JsonRows(db, 'project', 'assets').map(row => assetSchema.parse(row));
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const versions = readFormat5JsonRows(db, 'project', 'versions').map(row => {
    const version = versionSchema.parse(row);
    return {...version, sha256: version.sha256 ?? assetById.get(version.assetId)?.sha256 ?? ''};
  });
  const timelines = readFormat5JsonRows(db, 'project', 'timelines');
  if (timelines.length > 1 || timelines[0] && !isTimelineRecord(timelines[0], {projectId})) invalid();
  const timeline = timelines[0] ? timelineSchema.parse(timelines[0]) : null;
  const subjectBindings = db.prepare('SELECT * FROM project.subject_bindings ORDER BY id').all().map(row => bindingSchema.parse(row));
  const archived = (table: 'shots' | 'nodes' | 'edges'): string[] => profile.project === PROJECT_FILE_SCHEMA_VERSION ? []
    : db.prepare(`SELECT id FROM project.${table} WHERE archivedAt IS NOT NULL ORDER BY id`).all().map(row => String(row.id));
  const archivedShotIds = archived('shots');
  const needed = new Set(shots.filter(shot => !archivedShotIds.includes(shot.id) && shot.selectedVersionId !== null).map(shot => shot.selectedVersionId!));
  const videoTrack = timeline?.tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))[0];
  for (const clip of timeline?.clips ?? []) {
    if (clip.trackId !== videoTrack?.id) continue;
    const candidates = versions.filter(version => version.assetId === clip.assetId &&
      (clip.versionId === undefined || clip.versionId === version.id) &&
      (clip.shotId === undefined || clip.shotId === version.shotId) &&
      (clip.jobId === undefined || clip.jobId === version.jobId));
    if (candidates.length === 1) needed.add(candidates[0]!.id);
  }
  const provenVersions: Format5ProvenVersion[] = [];
  if (needed.size) {
    const graph = createOwnedMediaGraphReader(db, projectId);
    for (const version of versions) if (needed.has(version.id)) {
      const proof = graph.version(version.id, version.shotId, version.assetId);
      if (proof.jobId !== version.jobId || assetById.get(version.assetId)?.sha256 !== version.sha256) invalid('FORMAT5_CONVERSION_SOURCE_UNAVAILABLE');
      provenVersions.push({versionId: version.id, projectId, shotId: version.shotId, assetId: version.assetId, sha256: version.sha256, jobId: version.jobId});
    }
  }
  return {sourceFormat: profile.project, projectId, hasProject: projects.length === 1, shots, nodes, edges, assets, versions,
    subjectBindings, timeline, emptyTimeline, archivedShotIds, archivedNodeIds: archived('nodes'), archivedEdgeIds: archived('edges'), provenVersions};
}

export interface PreparedFormat5Conversion {
  readonly projectId: string;
  readonly sourceFormat: 3 | 4;
  readonly historyVersion: number;
  readonly content: ContentStamp;
  readonly inputDigest: string;
  readonly planDigest: string;
  readonly allocation: Format5ConversionAllocation;
  readonly plan: Format5ConversionPlan;
  readonly emptyTimeline?: Format5LegacyTimeline;
}
export function prepareFormat5Conversion(store: ProjectStore, allocation: Format5ConversionAllocation, options: Format5ConversionReadOptions = {}): PreparedFormat5Conversion {
  const input = readFormat5ConversionInput(store, options), plan = planFormat5Conversion(input, allocation);
  return Object.freeze({projectId: store.projectId, sourceFormat: input.sourceFormat,
    historyVersion: sourceProfile(store).history, content: readProjectContentStamp(store.db),
    inputDigest: digest(input), planDigest: digest(plan), allocation: structuredClone(allocation), plan,
    ...(options.emptyTimeline ? {emptyTimeline: structuredClone(options.emptyTimeline)} : {}),
  });
}

export type Format5ConversionBoundary = 'after-content' | 'after-structure' | 'before-version-write' | 'after-version-write';
/** K5b owns user confirmation and the verified original-format backup. This
 * shared primitive is called only inside that caller's one locked transaction. */
export function applyFormat5ConversionInside(store: ProjectStore, prepared: PreparedFormat5Conversion,
  {onBoundary}: {readonly onBoundary?: (phase: Format5ConversionBoundary) => void} = {}): Format5ConversionPlan {
  if (!isProjectStore(store) || !store.db.isTransaction) throw new TypeError('Conversion requires an active kernel transaction');
  const profile = sourceProfile(store), {db} = store;
  if (store.projectId !== prepared.projectId || profile.project !== prepared.sourceFormat || profile.history !== prepared.historyVersion ||
      !sameContentStamp(readProjectContentStamp(db), prepared.content)) invalid('FORMAT5_CONVERSION_STALE');
  const input = readFormat5ConversionInput(store, {emptyTimeline: prepared.emptyTimeline});
  const plan = planFormat5Conversion(input, prepared.allocation);
  if (digest(input) !== prepared.inputDigest || digest(plan) !== prepared.planDigest) invalid('FORMAT5_CONVERSION_STALE');
  removeCrossFileTriggersInside(db, profile.project);
  const save = (table: 'nodes' | 'edges' | 'timelines', rows: readonly {id: string; projectId: string}[]): void => {
    const statement = db.prepare(`INSERT INTO project.${table}(id,projectId,data) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE projectId=excluded.projectId AND data IS NOT excluded.data`);
    for (const value of rows) statement.run(value.id, value.projectId, JSON.stringify(value));
  };
  for (const edgeId of plan.removedEdgeIds) db.prepare('DELETE FROM project.edges WHERE id=? AND projectId=?').run(edgeId, store.projectId);
  save('nodes', plan.nodes);
  save('edges', plan.edges);
  if (plan.timeline) save('timelines', [plan.timeline]);
  onBoundary?.('after-content');
  addFormat5ProjectStructureInside(db, 'project', profile.project);
  addFormat5HistoryStructureInside(db, profile.history);
  if (plan.syncState) db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
    .run(plan.syncState.timelineId, store.projectId, plan.syncState.sequenceNodeId, plan.syncState.revision, JSON.stringify(plan.syncState.baseline));
  installCrossFileTriggers(db, FORMAT5_PROJECT_SCHEMA_VERSION);
  onBoundary?.('after-structure');
  if (!db.prepare('SELECT 1 FROM main.canvas_receipt_window WHERE singleton=1').get()) db.prepare('INSERT INTO main.canvas_receipt_window VALUES(1,?,0)').run(randomBytes(16).toString('hex'));
  db.prepare('INSERT INTO main.editor_receipt_window VALUES(1,?,0)').run(randomBytes(16).toString('hex'));
  if (input.hasProject) db.prepare('INSERT INTO main.editor_history_state(projectId,epoch,position,revision,evidence) VALUES(?,?,0,1,?)')
    .run(store.projectId, randomUUID(), JSON.stringify({formatVersion: FORMAT5_PROJECT_SCHEMA_VERSION, content: readProjectContentStamp(db)}));
  assertFormat5ProjectContent(db, 'project');
  const content = readProjectContentStamp(db);
  db.prepare('UPDATE main.history_state SET seenContentSequence=?,seenContentToken=? WHERE singleton=1 AND projectId=?')
    .run(content.contentSequence, content.contentToken, store.projectId);
  onBoundary?.('before-version-write');
  writeFormat5ProjectVersionInside(db, 'project', profile.project);
  writeFormat5HistoryVersionInside(db, profile.history);
  onBoundary?.('after-version-write');
  for (const [schema, manifest] of [['project', projectManifestForVersion(FORMAT5_PROJECT_SCHEMA_VERSION)], ['main', historyManifestForVersion(FORMAT5_HISTORY_SCHEMA_VERSION)]] as const) {
    if (!manifest) invalid();
    const differences = compareManifest(readSchemaManifest(db, schema), manifest.entries);
    if (differences.missing.length || differences.changed.length || differences.unexpected.length) invalid();
  }
  if (classifyHistoryStamp(db, false).state !== 'current' || foreignKeyCheck(db).length) invalid();
  return plan;
}
