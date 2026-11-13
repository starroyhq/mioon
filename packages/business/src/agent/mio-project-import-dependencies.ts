import type {DatabaseSync} from 'node:sqlite';
import {schemas} from '../../../contracts/src/index.ts';
import {assetMediaRecordSchema} from '../../../contracts/src/asset-media.ts';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import {isLocalMutationResponse} from '../../../contracts/src/local-mutations.ts';
import {isSubjectReference} from '../../../contracts/src/subject-generation.ts';
import {subjectVersionResponseSchema, isSubjectMutationResponse} from '../../../contracts/src/subjects.ts';
import {isAssetAnnotationResponse} from '../../../contracts/src/asset-annotations.ts';
import {isAssetDispositionResponse} from '../../../contracts/src/asset-disposition.ts';
import {isSourceRangeResponse} from '../../../contracts/src/source-range.ts';
import {isTimelineRecord} from '../../../contracts/src/timeline-replacement.ts';
import type {TimelineRecord} from '../timeline-inputs.ts';
import {isClipLayoutRect} from '../../../contracts/src/timeline-clip-layout.ts';
import {timelineFrameSetSchema} from '../../../contracts/src/timeline-format.ts';
import {isTimelineRenderRecord} from '../../../contracts/src/timeline-acknowledgement.ts';
import {timelineRenderDeliveryFields} from '../../../contracts/src/timeline-delivery.ts';
import {isReferenceShotRecord, isReferenceEdgeRecord} from '../../../contracts/src/reference-acknowledgement.ts';
import {isPrevisNodeRecord} from '../../../contracts/src/previs.ts';
import {imageSnapshotSchema, imageReceiptSchema, imageVersionResponseSchema, isImageMutationResponse} from '../../../contracts/src/images.ts';
import {imageReviewIntentSchema} from '../../../contracts/src/image-reviews.ts';
import {frameSnapshotSchema, frameReceiptSchema, isFrameMutationResponse} from '../../../contracts/src/frame-extraction.ts';
import {sceneSnapshotSchema, sceneShotsSnapshotSchema, sceneShotsReceiptSchema, sceneShotsOutcomeSchema, isSceneMutationResponse} from '../../../contracts/src/scene-tasks.ts';
import {subjectVariantSnapshotSchema, isSubjectVariantMutationResponse} from '../../../contracts/src/subject-variants.ts';
import {wanVideoInputSchema} from '../../../contracts/src/wan-video.ts';
import {agentTaskChangeSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import {MIO_PROJECT_FILE_IMPORT_OPERATION} from '../../../contracts/src/mio-project-import.ts';
import {CROSS_FILE_RELATIONS} from '../project-file/cross-file/relations.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION} from '../project-file/schema/databases.ts';
import {CANVAS_HISTORY_TABLES} from '../project-file/schema/tables.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {assertProjectStore} from '../store-runtime.ts';
import {INSPECTION_ROW_LIMITS} from '../inspection-query.ts';
import {projectRetainedTimelineReceipt,readWrappedTimelineReceipt,TIMELINE_RECEIPT_WRAPPER_OPERATIONS} from '../timeline-retained-receipts.ts';
import {walkTimelineFormatHistory} from '../timeline-format.ts';
import {restoreTimelineEditableSnapshot} from '../timeline-recovery.ts';
import {usesTimelineFrameTransaction} from '../store-capabilities.ts';
import {decodeProjectDocument} from '../project-versions/codec.ts';
import {clipDraftSlotSchema, LOCAL_DRAFT_LIMITS} from '../../../contracts/src/local-drafts.ts';

export type MioProjectImportDependencyResult = {readonly status: 'clear'}
  | {readonly status: 'referenced'; readonly source: string}
  | {readonly status: 'unproven'; readonly reason: 'invalid' | 'limit' | 'unsupported'};
/** An undo proof has its own bounded read budget. Hitting it refuses the
 * compensation; it never truncates evidence and calls the remainder empty. */
export const MIO_PROJECT_IMPORT_DEPENDENCY_LIMITS = Object.freeze({rows: 8192, cells: 32768,
  cellBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, depth: 64, nodes: 200000,
  versionBlobs: 64, compressedVersionBytes: 8 * 1024 * 1024});
type Value = Record<string, unknown>;
type Schema = {safeParse(value: unknown): {success: boolean}};
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const fields = (value: Value, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const clear = Object.freeze({status: 'clear'} as const);
class Refusal extends Error {
  readonly result: Exclude<MioProjectImportDependencyResult, {status: 'clear'}>;
  constructor(result: Exclude<MioProjectImportDependencyResult, {status: 'clear'}>) {super(result.status); this.result = result;}
}
function deny(reason: 'invalid' | 'limit' | 'unsupported'): never {throw new Refusal({status: 'unproven', reason});}

// This ledger classifies every kernel table. A newly added table cannot silently
// become a hole in an old deletion proof, even when it has no SQL foreign key.
// Revision tombstones, Mio transcripts and S1 idempotency are retained audit,
// not media consumers. mio_imports is still checked through its actual FK.
// V5's project_history_resolution is the fixed completed-switch ACK (project
// content stamp and archive name), not a retained media/restore input.
// S8 scope state, delivery names/render intents and shot text/patches contain
// no asset identities. Clip drafts retain an explicit source even when their
// current timeline clip has gone, so their typed data is a consumer below.
const ignored = {
  project: ['schema_version', 'project_file', 'agent_task_target_revisions_v2', 'asset_annotations', 'asset_dispositions', 'asset_ranges',
    'subjects', 'subject_bindings', 'image_groups', 'scene_results', 'project_lut_resources'],
  main: ['schema_version', 'history_state', 'project_history_resolution', 'idempotency', 'project_mutation_requests', 'timeline_format_requests',
    'lut_import_requests', 'task_disposition_requests', 'job_events', 'image_remote_runs', 'image_remote_observations',
    'subject_variant_items', 'task_dispositions', 'mock_provider_submissions', 'timeline_history_cursors',
    'mio_storage_counters', 'mio_blobs', 'mio_conversations', 'mio_runs', 'mio_entries', 'mio_steps', 'mio_requests',
    'mio_controls', 'mio_control_states', 'mio_imports', 'mio_job_origins', 'mio_edit_claims', 'mio_edit_owners', 'mio_edit_receipts',
    'mio_conversation_policies', 'mio_conversation_policy_requests', 'mio_events', 'mio_process_target_revisions', 'mio_rule_writes',
    'project_version_blobs', 'project_versions', 'project_version_requests', 'project_version_capture_marks',
    'local_draft_states', 'local_delivery_drafts', 'local_shot_text_drafts'],
  cache: ['schema_version', 'waveform_cache', 'previs_thumbnails'],
} as const;
const dataFields = {
  projects: ['id', 'name', 'description', 'notes', 'revision', 'createdAt', 'updatedAt'],
  assets: ['id', 'projectId', 'name', 'mimeType', 'sizeBytes', 'width', 'height', 'duration', 'hasAudio', 'hasVideo', 'provenance',
    'createdAt', 'reference', 'referenceRevision', 'sha256', 'url', 'producer', 'publication', 'frameResult', 'sceneResult', 'previsOutput'],
  nodes: ['id', 'projectId', 'type', 'label', 'text', 'position', 'revision', 'sceneRevision', 'scene', 'createdAt', 'updatedAt', 'assetId', 'shotId'],
  edges: ['id', 'projectId', 'source', 'target', 'from', 'to', 'kind', 'role', 'sourceAssetId', 'createdAt'],
  versions: ['id', 'projectId', 'shotId', 'jobId', 'number', 'providerId', 'model', 'isMock', 'snapshot', 'assetId', 'url', 'sha256', 'createdAt'],
  jobs: ['id', 'projectId', 'shotId', 'requestId', 'requestHash', 'providerId', 'model', 'revision', 'status', 'phase', 'progress', 'snapshot',
    'providerJobId', 'submissionCount', 'error', 'createdAt', 'updatedAt', 'versionId', 'cancelScope', 'retryOfJobId', 'assetId'],
  exports: ['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'snapshot', 'status', 'assetId', 'url', 'error', 'createdAt',
    'updatedAt', 'orderedVersionIds', 'outputGeometry', 'audioCheck', 'revision', 'phase', 'progress'],
} as const;
const snapshotFields = ['shotId', 'shotRevision', 'title', 'prompt', 'referenceAssetIds', 'lastFrameAssetId', 'referenceAssets', 'referenceAudios',
  'referenceConnections', 'referenceBindings', 'aspectRatio', 'duration', 'providerId', 'model', 'parameters', 'capabilities', 'inputProfileVersion',
  'inputProfileId', 'providerRegion', 'subjectReference', 'projectId', 'executionBinding', 'executionConnectionName', 'videoInput'];
const consumerCells = {
  project: {projects: ['data'], assets: ['data'], shots: ['data'], nodes: ['data'], edges: ['data'], versions: ['data'], timelines: ['data'],
    subject_versions: ['data'], image_versions: ['data']},
  main: {mutation_requests: ['canonicalInput', 'response'], asset_annotation_requests: ['canonicalInput', 'response'],
    asset_disposition_requests: ['canonicalInput', 'response'], asset_range_requests: ['canonicalInput', 'response'],
    timeline_requests: ['response'], reference_requests: ['response'], image_requests: ['canonicalInput', 'response'],
    frame_requests: ['canonicalInput', 'response'], scene_requests: ['canonicalInput', 'response'], subject_requests: ['canonicalInput', 'response'],
    subject_variant_requests: ['canonicalInput', 'response'], previs_requests: ['response'], jobs: ['data'], exports: ['data'],
    edit_tasks: ['input'], image_tasks: ['input', 'snapshot', 'stagedReceipt'], image_reviews: ['canonicalInput', 'canonicalIntent'],
    frame_tasks: ['input', 'snapshot', 'stagedReceipt'], scene_tasks: ['input', 'snapshot', 'stagedReceipt', 'outcome'],
    subject_variant_batches: ['input', 'snapshot'], mock_provider_tasks: ['snapshot_json'], timeline_history: ['beforeSnapshot', 'afterSnapshot'], mio_changes: ['data'],
    local_clip_drafts: ['data']},
  cache: {},
} as const;
const singleAssetKeys = new Set(['assetId', 'sourceAssetId', 'lastFrameAssetId']);
const manyAssetKeys = new Set(['referenceAssetIds', 'assetIds', 'exports']);
const frozenAssetKeys = new Set(['referenceAssets', 'referenceAudios', 'assets']);
const parameterKeys = ['scenario', 'delayMs', 'seed', 'durationSeconds', 'aspectRatio', 'promptExtend', 'watermark', 'resolution', 'generateAudio'];

/** Read the exact live owner's complete bounded evidence, inside the caller's
 * transaction. This grants no deletion authority, never reads media or private
 * receipts, and never changes a row. The caller separately checks creation
 * attribution, unchanged asset/revision/claims, then removes exactly that row. */
export function readMioProjectImportDependenciesInside(store: ProjectStore, assetId: string): MioProjectImportDependencyResult {
  assertProjectStore(store);
  if (!store.db.isTransaction) throw new TypeError('Import dependency proof requires the live project transaction');
  if (!uuid(assetId)) throw new TypeError('Import dependency proof requires an asset identity');
  const db = store.db, limits = MIO_PROJECT_IMPORT_DEPENDENCY_LIMITS, frameTransaction=usesTimelineFrameTransaction(db);
  let rows = 0, cells = 0, bytes = 0, nodes = 0;
  const referenced = (source: string): never => {throw new Refusal({status: 'referenced', source});};
  const countRow = (): void => {if (++rows > limits.rows) deny('limit');};
  function tree(value: unknown, source: string, depth = 0): void {
    if (++nodes > limits.nodes || depth > limits.depth) deny('limit');
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {for (const item of value) tree(item, source, depth + 1); return;}
    for (const [key, item] of Object.entries(value)) {
      if (singleAssetKeys.has(key)) {
        if (item !== null && !uuid(item)) deny('invalid');
        if (item === assetId) referenced(source);
      } else if (manyAssetKeys.has(key)) {
        if (!Array.isArray(item) || !item.every(uuid)) deny('invalid');
        if (item.includes(assetId)) referenced(source);
      } else if (frozenAssetKeys.has(key)) {
        if (!Array.isArray(item) || item.some(entry => !object(entry) || !uuid(entry.id))) deny('invalid');
        if (item.some(entry => object(entry) && entry.id === assetId)) referenced(source);
        for (const entry of item) {
          if (!object(entry) || !fields(entry, [...dataFields.assets, 'role', 'durationSeconds', 'relativePath', 'path', 'fingerprint',
            'hashState', 'videoStreamIndex', 'audioStreamIndex', 'colourProbe', 'colourImageEvidence', 'colourSourceIdentity'])) deny('unsupported');
          if (Object.hasOwn(entry, 'projectId') && entry.projectId !== store.projectId) deny('invalid');
        }
      } else if (/asset/iu.test(key)) {
        // No inference from arbitrary UUID-valued user text. A new semantic
        // asset field, however, needs an explicit classification before undo.
        deny('unsupported');
      }
      if (key === 'schemaVersion' && ![1, 2, 3, 4, 5].includes(Number(item)) &&
        !(item === 6 && depth === 0 && source === 'main.image_reviews.canonicalIntent')) deny('unsupported');
      if (key === 'parameters' && (!object(item) || !fields(item, parameterKeys)
        || Object.values(item).some(entry => entry !== null && typeof entry === 'object'))) deny('unsupported');
      if (key === 'videoInput' && !wanVideoInputSchema.safeParse(item).success) deny('invalid');
      if (key === 'subjectReference' && !isSubjectReference(item)) deny('invalid');
      if (key === 'reference' && !mediaReferenceSchema.safeParse(item).success) deny('invalid');
      if (key === 'referenceBindings' && (!Array.isArray(item) || item.some(entry => !object(entry)
        || !fields(entry, ['role', 'assetId', 'sha256'])))) deny('unsupported');
      if (key === 'referenceConnections' && (!Array.isArray(item) || item.some(entry => !object(entry)
        || !fields(entry, ['role', 'assetId', 'sourceAssetId', 'sourceNodeId', 'targetShotId', 'edgeId', 'projectId'])))) deny('unsupported');
      tree(item, source, depth + 1);
    }
  }
  function decode(raw: unknown, source: string, maximum = limits.cellBytes): unknown {
    if (typeof raw !== 'string') deny('invalid');
    if (++cells > limits.cells || Buffer.byteLength(raw) > maximum || (bytes += Buffer.byteLength(raw)) > limits.totalBytes) deny('limit');
    // SQL checks duplicates before JSON.parse can erase a conflicting key.
    const duplicate = db.prepare("SELECT 1 FROM json_tree(?) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1 LIMIT 1").get(raw);
    if (duplicate) deny('invalid');
    let value: unknown; try {value = JSON.parse(raw);} catch {deny('invalid');}
    // The bound is checked before downstream recursive schema validators run.
    const pending = [{value, depth: 0}]; let count = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++count + nodes > limits.nodes || item.depth > limits.depth) deny('limit');
      if (item.value && typeof item.value === 'object') for (const child of Object.values(item.value)) pending.push({value: child, depth: item.depth + 1});
    }
    return value;
  }
  function parseWith(schema: Schema, value: unknown): void {if (!schema.safeParse(value).success) deny('invalid');}
  function owner(value: unknown): asserts value is Value {
    if (!object(value) || value.projectId !== store.projectId) deny('invalid');
  }
  function timeline(value: unknown, source: string): void {
    if (!isTimelineRecord(value, {projectId: store.projectId})) deny('invalid');
    tree(value, source);
  }
  function generationSnapshot(value: unknown): void {
    if (!object(value) || !fields(value, snapshotFields)) deny('unsupported');
    if (Object.hasOwn(value, 'projectId') && value.projectId !== store.projectId) deny('invalid');
    if (!Array.isArray(value.referenceAssetIds) || !Array.isArray(value.referenceAssets) || !uuid(value.shotId)) deny('invalid');
  }
  function content(table: string, value: unknown, source: string, rowId?: unknown): void {
    if (table === 'projects') {
      if (!object(value) || value.id !== store.projectId || !fields(value, dataFields.projects)) deny('invalid');
    } else {owner(value); if (!uuid(value.id) || rowId !== undefined && value.id !== rowId) deny('invalid');}
    if (!object(value)) deny('invalid');
    if (table === 'shots') {if (!isReferenceShotRecord(value, {projectId: store.projectId})) deny('invalid');}
    else if (table === 'timelines') {timeline(value, source); return;}
    else if (table === 'nodes') {
      if (!fields(value, dataFields.nodes) || !['text', 'image', 'video', 'audio', 'asset', 'shot', 'previs'].includes(String(value.type))) deny('unsupported');
      if (value.type === 'previs' && !isPrevisNodeRecord(value)) deny('invalid');
    } else if (table === 'edges') {
      if (!fields(value, dataFields.edges)) deny('unsupported');
      if (value.kind === 'reference' && !isReferenceEdgeRecord(value, {projectId: store.projectId})) deny('invalid');
      if (!['reference', 'decorative'].includes(String(value.kind))) deny('unsupported');
    } else if (table === 'assets') {
      if (!fields(value, dataFields.assets)) deny('unsupported');
      const {url: _url, ...record} = value;
      parseWith(assetMediaRecordSchema, record);
      // The creation row's own identity/publication is not its consumer.
      if (value.id === assetId) return;
    } else if (table === 'versions' || table === 'jobs') {
      if (!fields(value, dataFields[table])) deny('unsupported');
      if (table === 'jobs' && !['queued', 'submitting', 'running', 'downloading', 'submission_unknown', 'failed', 'cancelled', 'succeeded'].includes(String(value.status))) deny('unsupported');
      generationSnapshot(value.snapshot);
      if (table === 'versions' && !uuid(value.assetId)) deny('invalid');
    } else if (table === 'exports') {
      if (!fields(value, dataFields.exports)) deny('unsupported');
      if (value.mode === 'timeline') {
        if (!isTimelineRenderRecord(value, {projectId: store.projectId, requestId: value.requestId, expectedRevision: value.timelineRevision,
          purpose: value.purpose, ...timelineRenderDeliveryFields(value.snapshot)})) deny('invalid');
      } else if (!Array.isArray(value.snapshot) || value.snapshot.some(entry => !object(entry) || !uuid(entry.assetId)
        || !fields(entry, ['versionId', 'assetId', 'sha256', 'shotId']))) deny('invalid');
    } else if (table === 'image_versions') parseWith(imageVersionResponseSchema, value);
    else if (table === 'subject_versions') parseWith(subjectVersionResponseSchema, value);
    else if (!['projects', 'shots', 'nodes', 'edges', 'assets', 'versions', 'jobs', 'exports'].includes(table)) deny('unsupported');
    tree(value, source);
  }
  function receipt(value: unknown, source: string, identity: unknown): void {
    if (frameTransaction && object(value) && TIMELINE_RECEIPT_WRAPPER_OPERATIONS.includes(value.operation as string)) {
      if (typeof identity !== 'string' || !readWrappedTimelineReceipt(value, store.projectId, identity)) deny('invalid');
      tree(value, source);
      return;
    }
    const projected = projectRetainedTimelineReceipt(value, identity);
    if (object(projected) && object(projected.snapshot)) {
      if (!isTimelineRenderRecord(projected, {projectId: store.projectId, requestId: identity,
        expectedRevision: projected.timelineRevision, purpose: projected.purpose, ...timelineRenderDeliveryFields(projected.snapshot)})) deny('invalid');
      tree(projected, source);
    } else timeline(projected, source);
  }
  function recoverableChange(value: unknown, source: string, row: Value): void {
    const parsed = agentTaskChangeSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== store.projectId || parsed.data.id !== row.id
      || parsed.data.runId !== row.runId || parsed.data.stepId !== row.stepId) deny('invalid');
    const change = parsed.data;
    if (!change.reversible || change.status !== 'applied') return;
    if (change.operation === MIO_PROJECT_FILE_IMPORT_OPERATION) {
      // Its creation-only after snapshot is an attribution fact, not a future
      // restoration of a removed reference. The actual compensator separately
      // validates the full S1 creation proof, row digest and target revision.
      if (!Array.isArray(change.undo) || change.undo.length !== 1 || !object(change.undo[0]) || change.undo[0].before !== undefined
        || !object(change.undo[0].after) || change.undo[0].after.kind !== 'asset' || change.undo[0].after.table !== 'assets'
        || !Array.isArray(change.before) || change.before.length !== 1 || change.before[0] !== null) deny('invalid');
      return;
    }
    if (!Object.hasOwn(schemas, change.operation)) deny('unsupported');
    if (!Array.isArray(change.undo) || !change.undo.length) deny('invalid');
    for (const entry of change.undo) {
      if (!object(entry) || !fields(entry, ['before', 'after'])) deny('invalid');
      const identity = entry.after ?? entry.before;
      if (!object(identity) || !change.targets.some(target => target.kind === identity.kind && target.id === identity.id)) deny('invalid');
      for (const side of [entry.before, entry.after]) {
        if (side === undefined) continue;
        if (!object(side) || !fields(side, ['kind', 'id', 'table', 'value', 'revision']) || side.id !== identity.id || side.kind !== identity.kind
          || side.table !== identity.table || !object(side.value) || !Number.isSafeInteger(side.revision) || Number(side.revision) < 1) deny('invalid');
      }
      if (!object(entry.before)) continue;
      const before = entry.before;
      if (typeof before.table !== 'string' || !object(before.value)) deny('invalid');
      if (['projects', 'assets', 'shots', 'nodes', 'edges', 'versions', 'timelines', 'subject_versions', 'image_versions'].includes(before.table))
        content(before.table, before.value, source, before.id);
      else if (['asset_ranges', 'asset_dispositions', 'asset_annotations', 'subject_bindings', 'tracks', 'subtitles', 'timeline_format'].includes(before.table))
        tree(before.value, source);
      else if (before.table === 'clips') {
        if (!fields(before.value, ['id', 'trackId', 'assetId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain',
          'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope', 'transform', 'transitionIn', 'hidden', 'muted', 'versionId', 'shotId', 'jobId','layout'])) deny('unsupported');
        if(Object.hasOwn(before.value,'layout')&&!isClipLayoutRect(before.value,null))deny('invalid');
        tree(before.value, source);
      } else deny('unsupported');
    }
  }
  try {
    const target = db.prepare('SELECT id,projectId FROM project.assets WHERE id=?').get(assetId);
    if (!target || target.projectId !== store.projectId) deny('invalid');
    const tables: {schema: 'main' | 'project' | 'cache'; table: string}[] = [];
    const historyVersion = db.prepare('SELECT version FROM main.schema_version').get()?.version;
    for (const schema of ['project', 'main', 'cache'] as const) {
      const expected = new Set<string>([...ignored[schema], ...Object.keys(consumerCells[schema])]);
      if (schema === 'main' && historyVersion === FORMAT4_HISTORY_SCHEMA_VERSION) {
        // CB will own the meaning of the retained canvas patches. Until that
        // decoder ships, an empty ledger is the only proof of no consumers.
        for (const table of CANVAS_HISTORY_TABLES) {
          expected.add(table);
          if (db.prepare(`SELECT 1 FROM main.${quote(table)} LIMIT 1`).get()) deny('unsupported');
        }
      }
      for (const row of db.prepare(`SELECT name,type FROM ${schema}.sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' LIMIT 257`).iterate()) {
        if (typeof row.name !== 'string' || row.type !== 'table' || !expected.delete(row.name)) deny('unsupported');
        tables.push({schema, table: row.name});
        if (tables.length > 256) deny('limit');
      }
      if (expected.size) deny('invalid');
    }
    // Native FKs are discovered from the real catalog, never copied from a
    // convenient content-only list. Cross-file guards use the kernel's ledger.
    for (const {schema, table} of tables) for (const fk of db.prepare(`PRAGMA ${schema}.foreign_key_list(${quote(table)})`).all()) {
      if (fk.table !== 'assets') continue;
      if (schema !== 'project' || fk.to !== 'id' || typeof fk.from !== 'string' || fk.seq !== 0) deny('unsupported');
      if (db.prepare(`SELECT 1 FROM ${schema}.${quote(table)} WHERE ${quote(fk.from)} IS ? LIMIT 1`).get(assetId)) referenced(`${schema}.${table}.${fk.from}`);
    }
    for (const relation of CROSS_FILE_RELATIONS) {
      if (relation.parent.table !== 'assets') continue;
      const column = relation.child.columns[0];
      if (relation.parent.columns.length !== 1 || relation.parent.columns[0] !== 'id' || relation.child.columns.length !== 1 || typeof column !== 'string') deny('unsupported');
      if (db.prepare(`SELECT 1 FROM ${relation.child.schema}.${quote(relation.child.table)} WHERE ${quote(column)} IS ? LIMIT 1`).get(assetId))
        referenced(`${relation.child.schema}.${relation.child.table}.${column}`);
    }
    let currentTimeline: TimelineRecord|null=null;
    for (const schema of ['project', 'main'] as const) for (const [table, columns] of Object.entries(consumerCells[schema])) {
      const info = db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all(), columnNames = new Set(info.map(row => row.name));
      const metadata = ['id', 'projectId', 'operation', 'requestId', 'kind', 'runId', 'stepId',
        ...(table === 'local_clip_drafts' ? ['timelineId', 'clipId', 'revision'] : [])].filter(key => columnNames.has(key));
      const maximum = table === 'local_clip_drafts' ? LOCAL_DRAFT_LIMITS.rowBytes
        : (INSPECTION_ROW_LIMITS as Readonly<Record<string, number>>)[table] ?? limits.cellBytes;
      const select = columns.flatMap(column => [`CASE WHEN ${quote(column)} IS NULL THEN NULL WHEN typeof(${quote(column)})='text'
        AND length(CAST(${quote(column)} AS BLOB)) BETWEEN 1 AND ${maximum} THEN ${quote(column)} ELSE 0 END AS ${quote(column)}`]);
      for (const row of db.prepare(`SELECT ${[...metadata.map(quote), ...select].join(',')} FROM ${schema}.${quote(table)} LIMIT ${limits.rows + 1}`).iterate()) {
        countRow();
        if (columnNames.has('projectId') && row.projectId !== store.projectId) deny('invalid');
        let originalInput: unknown;
        for (const column of columns) {
          const source = `${schema}.${table}.${column}`;
          if (row[column] === null && ['stagedReceipt', 'outcome'].includes(column)) continue;
          if (row[column] === 0) deny('limit');
          const value = decode(row[column], source, maximum);
          if (schema === 'project' && ['projects', 'assets', 'shots', 'nodes', 'edges', 'versions', 'timelines', 'subject_versions', 'image_versions'].includes(table)) {
            content(table, value, source, row.id);
            // content() has already validated the full timeline here.
            if (table === 'timelines') currentTimeline = value as TimelineRecord;
          } else if (table === 'local_clip_drafts') {
            const slot = clipDraftSlotSchema.safeParse(value);
            if (!slot.success || slot.data.projectId !== store.projectId
              || slot.data.timelineId !== row.timelineId || slot.data.clipId !== row.clipId || slot.data.revision !== row.revision) deny('invalid');
            // Scan only the validated semantic source: raw UI strings are not
            // references and assetSha256 is a fingerprint, not another ID.
            if (slot.data.draft?.source.assetId === assetId) referenced(source);
          } else if (table === 'jobs' || table === 'exports') content(table, value, source, row.id);
          else if (table === 'mio_changes') recoverableChange(value, source, row);
          else if (table === 'timeline_requests') receipt(value, source, row.requestId);
          else if (table === 'timeline_history') {
            if (!currentTimeline) deny('invalid');
            if (!frameTransaction) timeline(restoreTimelineEditableSnapshot(currentTimeline,value),source);
            // For format 4, decode above still enforces the proof budget and detects duplicate keys.
            // Read both sides together below, using the frame at the saved cursor.
          } else if (column === 'canonicalInput' || column === 'input') {
            const operation = table === 'image_tasks' || table === 'image_reviews' ? 'image.generate' : table === 'frame_tasks' ? 'frame.extract'
              : table === 'scene_tasks' ? row.kind === 'detect' ? 'scene.detect' : 'scene.shots.create'
                : table === 'subject_variant_batches' ? 'subject.variants.create' : row.operation;
            if (typeof operation !== 'string' || !Object.hasOwn(schemas, operation)) deny('unsupported');
            const schema = frameTransaction && operation === 'timeline.format.set' ? timelineFrameSetSchema : (schemas as Readonly<Record<string, Schema>>)[operation];
            if (!schema) deny('unsupported');
            parseWith(schema, value);
            originalInput = value;
            if (object(value) && Object.hasOwn(value, 'projectId') && value.projectId !== store.projectId) deny('invalid');
            tree(value, source);
          } else if (column === 'snapshot') {
            const validator = table === 'image_tasks' ? imageSnapshotSchema : table === 'frame_tasks' ? frameSnapshotSchema
              : table === 'scene_tasks' ? row.kind === 'detect' ? sceneSnapshotSchema : sceneShotsSnapshotSchema : subjectVariantSnapshotSchema;
            parseWith(validator, value); owner(value); tree(value, source);
          } else if (column === 'stagedReceipt') {
            parseWith(table === 'image_tasks' ? imageReceiptSchema : table === 'frame_tasks' ? frameReceiptSchema : sceneShotsReceiptSchema, value);
            owner(value); tree(value, source);
          } else if (column === 'canonicalIntent') {parseWith(imageReviewIntentSchema, value); tree(value, source);}
          else if (table === 'mock_provider_tasks') {generationSnapshot(value); tree(value, source);}
          else {
            if (!object(value)) deny('invalid');
            // A known operation owns a structured immutable response. These
            // receipts are checked for semantic links, not arbitrary strings.
            if (columnNames.has('operation') && (typeof row.operation !== 'string' || !Object.hasOwn(schemas, row.operation))) deny('unsupported');
            if (Object.hasOwn(value, 'projectId') && value.projectId !== store.projectId) deny('invalid');
            if (table === 'reference_requests') {
              if (!fields(value, ['edge', 'shot', 'detached']) || !isReferenceShotRecord(value.shot, {projectId: store.projectId})
                || !isReferenceEdgeRecord(value.edge, {projectId: store.projectId}) || Object.hasOwn(value, 'detached') && value.detached !== true) deny('invalid');
            } else if (table === 'previs_requests') {if (!isPrevisNodeRecord(value)) deny('invalid');}
            else if (table === 'mutation_requests') {
              if (!isLocalMutationResponse(row.operation, originalInput, value, {projectId: store.projectId})) deny('invalid');
              const kind = String(row.operation).startsWith('node.') ? 'nodes' : row.operation === 'shot.reorder' ? 'projects' : 'shots';
              content(kind, value, source);
            } else if (table === 'asset_annotation_requests') {if (!isAssetAnnotationResponse(value)) deny('invalid');}
            else if (table === 'asset_disposition_requests') {if (!isAssetDispositionResponse(value)) deny('invalid');}
            else if (table === 'asset_range_requests') {if (!isSourceRangeResponse(value)) deny('invalid');}
            else if (table === 'image_requests') {if (!isImageMutationResponse(row.operation, originalInput, value)) deny('invalid');}
            else if (table === 'frame_requests') {if (!isFrameMutationResponse(row.operation, originalInput, value)) deny('invalid');}
            else if (table === 'scene_requests') {if (!isSceneMutationResponse(row.operation, originalInput, value)) deny('invalid');}
            else if (table === 'subject_requests') {if (!isSubjectMutationResponse(row.operation, originalInput, value)) deny('invalid');}
            else if (table === 'subject_variant_requests') {if (!isSubjectVariantMutationResponse(row.operation, originalInput, value)) deny('invalid');}
            else if (table === 'scene_tasks' && column === 'outcome') parseWith(sceneShotsOutcomeSchema, value);
            else deny('unsupported');
            tree(value, source);
          }
        }
      }
    }
    if (frameTransaction) walkTimelineFormatHistory(db, store.projectId, currentTimeline, (value, _position, side) => timeline(value, `main.timeline_history.${side}Snapshot`));
    const blobs = new Map<string, number>(); let compressedBytes = 0;
    for (const row of db.prepare(`SELECT v.projectId,v.contentSequence,v.blobHash,b.profile,b.codec,b.rawBytes,b.compressedBytes,
      typeof(b.payload) AS payloadType,length(b.payload) AS payloadBytes
      FROM main.project_versions v LEFT JOIN main.project_version_blobs b ON b.hash=v.blobHash LIMIT ${limits.rows + 1}`).iterate()) {
      countRow();
      if (row.projectId !== store.projectId || typeof row.blobHash !== 'string') deny('invalid');
      if (blobs.has(row.blobHash)) {if (blobs.get(row.blobHash) !== row.contentSequence) deny('invalid'); continue;}
      if (blobs.size >= limits.versionBlobs || typeof row.rawBytes !== 'number' || row.rawBytes < 1 || typeof row.compressedBytes !== 'number' || row.compressedBytes < 1
        || (bytes += row.rawBytes) > limits.totalBytes || (compressedBytes += row.compressedBytes) > limits.compressedVersionBytes) deny('limit');
      if (row.payloadType !== 'blob' || row.payloadBytes !== row.compressedBytes) deny('invalid');
      if (row.profile !== 1 || row.codec !== 'gzip') deny('unsupported');
      const payload = db.prepare('SELECT payload FROM main.project_version_blobs WHERE hash=? AND length(payload)=?').get(row.blobHash, row.compressedBytes)?.payload;
      if (!(payload instanceof Uint8Array)) deny('invalid');
      const document = decodeProjectDocument({hash: row.blobHash, profile: row.profile, codec: row.codec, rawBytes: row.rawBytes,
        compressedBytes: row.compressedBytes, payload});
      if (document.projectId !== store.projectId || document.evidence.contentSequence !== row.contentSequence) deny('invalid');
      blobs.set(row.blobHash, document.evidence.contentSequence);
      // A recoverable content version retains the asset identity itself, even
      // when no currently visible clip or canvas node refers to it.
      if (document.tables.assets.some(asset => asset.id === assetId)) referenced('main.project_versions.assets');
      for (const [table, saved] of Object.entries(document.tables)) for (const item of saved) {
        countRow();
        if (typeof item.data === 'string') content(table, decode(item.data, `main.project_versions.${table}`), `main.project_versions.${table}`, item.id);
      }
    }
    return clear;
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    // V5 preserves format-1 blobs byte-for-byte but deliberately offers no
    // business restore decoder for them. Preservation is not proof that their
    // old business rows can be safely inspected as today's media semantics.
    if (object(error) && error.code === 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED') return {status: 'unproven', reason: 'unsupported'};
    // SQL corruption, malformed JSON and unsupported retained contracts never
    // become evidence of absence. No repair or observer runs on this path.
    return {status: 'unproven', reason: 'invalid'};
  }
}

/** Read-only preview uses the same snapshot as transactional compensation.
 * Never commit or roll back a transaction that belongs to the caller. */
export function readMioProjectImportDependencies(store: ProjectStore, assetId: string): MioProjectImportDependencyResult {
  assertProjectStore(store);
  const db: DatabaseSync = store.db, outer = db.isTransaction;
  if (!outer) db.exec('BEGIN DEFERRED');
  try {
    const result = readMioProjectImportDependenciesInside(store, assetId);
    if (!outer) db.exec(result.status === 'unproven' ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {if (!outer && db.isTransaction) db.exec('ROLLBACK'); throw error;}
}
