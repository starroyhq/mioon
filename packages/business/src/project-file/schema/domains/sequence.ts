import type {DatabaseSync} from 'node:sqlite';

/** Format 5 is admitted explicitly while released formats retain their DDL. */
export const FORMAT5_PROJECT_SCHEMA_VERSION = 5;
/** Format 6 keeps the same tables and admits timing in native clip data. */
export const FORMAT6_PROJECT_SCHEMA_VERSION = 6;
export function isSequenceProjectFormat(version: unknown): version is typeof FORMAT5_PROJECT_SCHEMA_VERSION | typeof FORMAT6_PROJECT_SCHEMA_VERSION {
  return version === FORMAT5_PROJECT_SCHEMA_VERSION || version === FORMAT6_PROJECT_SCHEMA_VERSION;
}
export const FORMAT5_HISTORY_SCHEMA_VERSION = 13;
export const FORMAT5_CONTENT_TABLES_ADDED = ['shot_version_adoptions', 'sequence_sync_state', 'timeline_clips', 'timeline_cues'] as const;
/** Entity rows advance the project content stamp once per write transaction from
 * the write service; a per-row trigger would stamp 1,500 times per batch. */
export const FORMAT5_SEQUENCED_TABLES_ADDED = ['shot_version_adoptions', 'sequence_sync_state'] as const;
export const FORMAT5_EDITOR_HISTORY_TABLES = ['editor_history_entries', 'editor_history_state', 'editor_requests', 'editor_receipt_window', 'editor_storage_counters'] as const;

const uuid = (column: string): string =>
  `typeof(${column})='text' AND length(${column})=36 AND ${column}=lower(${column}) AND substr(${column},9,1)='-' AND substr(${column},14,1)='-' AND substr(${column},19,1)='-' AND substr(${column},24,1)='-' AND length(replace(${column},'-',''))=32 AND replace(${column},'-','') NOT GLOB '*[^a-f0-9]*'`;
const revision = (column: string, first = 1): string => `typeof(${column})='integer' AND ${column} BETWEEN ${first} AND 9007199254740991`;
const object = (column: string, bytes: number): string =>
  `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 2 AND ${bytes} AND json_valid(${column}) THEN json_type(${column})='object' ELSE 0 END`;
const time = (column: string): string => `typeof(${column})='text' AND length(${column})=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',${column}) IS ${column}`;
const roles = "'first_frame','last_frame','reference_image','reference_video','reference_audio','composition','subject_reference','style_reference'";

export const FORMAT5_EDGE_CHECK = `CHECK(CASE WHEN json_valid(data) THEN archivedAt IS NOT NULL OR COALESCE((
 json_type(data)='object' AND json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId
 AND ${uuid("json_extract(data,'$.source')")} AND ${uuid("json_extract(data,'$.target')")}
 AND json_extract(data,'$.source') IS NOT json_extract(data,'$.target')
 AND (json_extract(data,'$.kind')='sequence' AND json_type(data,'$.role') IS NULL
      AND json_type(data,'$.sourceAssetId') IS NULL AND json_type(data,'$.subjectBindingId') IS NULL
   OR json_extract(data,'$.kind')='reference' AND json_extract(data,'$.role') IN (${roles})
      AND (json_type(data,'$.orderIndex') IS NULL OR typeof(json_extract(data,'$.orderIndex'))='integer' AND json_extract(data,'$.orderIndex') BETWEEN 0 AND 9007199254740991)
      AND (json_extract(data,'$.role') IN ('subject_reference','style_reference')
        AND ${uuid("json_extract(data,'$.subjectBindingId')")} AND json_type(data,'$.sourceAssetId') IS NULL
       OR json_extract(data,'$.role') NOT IN ('subject_reference','style_reference')
        AND ${uuid("json_extract(data,'$.sourceAssetId')")} AND json_type(data,'$.subjectBindingId') IS NULL))),0) ELSE 0 END)`;

export const FORMAT5_EDGE_INDEXES = Object.freeze([
  "CREATE UNIQUE INDEX sequence_edges_source ON edges(projectId,json_extract(data,'$.source')) WHERE archivedAt IS NULL AND json_extract(data,'$.kind')='sequence'",
  "CREATE UNIQUE INDEX sequence_edges_target ON edges(projectId,json_extract(data,'$.target')) WHERE archivedAt IS NULL AND json_extract(data,'$.kind')='sequence'",
  "CREATE UNIQUE INDEX reference_edges_frame_role ON edges(projectId,json_extract(data,'$.target'),json_extract(data,'$.role')) WHERE archivedAt IS NULL AND json_extract(data,'$.kind')='reference' AND json_extract(data,'$.role') IN ('first_frame','last_frame')",
  "CREATE UNIQUE INDEX subject_cards_live_subject ON nodes(projectId,json_extract(data,'$.subjectId')) WHERE archivedAt IS NULL AND json_extract(data,'$.type')='subject_card'",
]);

/** Header-only guard: clips and cues are native rows, so the persisted
 * `timelines.data` value may never carry either array again. */
const headerTracksUnique = `NOT EXISTS(SELECT 1 FROM json_each(NEW.data,'$.tracks') GROUP BY json_extract(value,'$.id')
  HAVING typeof(json_extract(value,'$.id'))!='text' OR length(json_extract(value,'$.id'))!=36 OR count(*)!=1)`;
export const FORMAT5_TIMELINE_GUARDS = (['insert', 'update'] as const).map(operation =>
  `CREATE TRIGGER format5_timeline_ids_${operation} BEFORE ${operation.toUpperCase()} ON timelines WHEN COALESCE((CASE WHEN length(CAST(NEW.data AS BLOB)) BETWEEN 2 AND 8388608 AND json_valid(NEW.data) THEN
   json_type(NEW.data)='object' AND json_extract(NEW.data,'$.id') IS NEW.id AND json_extract(NEW.data,'$.projectId') IS NEW.projectId
   AND json_type(NEW.data,'$.tracks')='array' AND json_array_length(NEW.data,'$.tracks') BETWEEN 1 AND 12
   AND json_type(NEW.data,'$.mainTrack')='object'
   AND json_type(NEW.data,'$.clips') IS NULL AND json_type(NEW.data,'$.subtitles.cues') IS NULL
   AND ${headerTracksUnique}
   AND EXISTS(SELECT 1 FROM json_each(NEW.data,'$.tracks') track WHERE json_extract(track.value,'$.id')=json_extract(NEW.data,'$.mainTrack.trackId')
     AND json_extract(track.value,'$.kind')='video')
  ELSE 0 END),0)=0 BEGIN SELECT RAISE(ABORT,'FORMAT5_TIMELINE_INVALID');END`);

const jsonUuid = (expression: string): string =>
  `typeof(${expression})='text' AND length(${expression})=36 AND ${expression}=lower(${expression}) AND substr(${expression},9,1)='-'
   AND substr(${expression},14,1)='-' AND substr(${expression},19,1)='-' AND substr(${expression},24,1)='-'
   AND length(replace(${expression},'-',''))=32 AND replace(${expression},'-','') NOT GLOB '*[^a-f0-9]*'`;
const jsonInteger = (expression: string, first: number): string =>
  `typeof(${expression})='integer' AND ${expression} BETWEEN ${first} AND 9007199254740991`;

/** Native timeline rows. Grammar that needs subqueries (strict key sets and
 * cross-row rules) is enforced by the commit fence; these CHECKs keep every
 * single-row shape valid for any writer. */
/** Native timeline rows. Structural columns are the storage projection of the
 * same-named entity fields; `data` keeps the exact persisted JSON for byte
 * semantics and the assembled read projection. */
export const FORMAT5_TIMELINE_ENTITY_SCHEMA = Object.freeze([
  `CREATE TABLE timeline_clips(
 timelineId TEXT NOT NULL REFERENCES timelines(id),
 id TEXT PRIMARY KEY NOT NULL CHECK(${jsonUuid('id')}),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(${jsonUuid('projectId')}),
 trackId TEXT NOT NULL CHECK(${jsonUuid('trackId')}),
 startFrame INTEGER NOT NULL CHECK(startFrame BETWEEN 0 AND 300000),
 durationFrames INTEGER NOT NULL CHECK(durationFrames BETWEEN 1 AND 300000),
 sourceInFrame INTEGER NOT NULL CHECK(sourceInFrame BETWEEN 0 AND 9007199254740991),
 sourceState TEXT NOT NULL CHECK(sourceState IN ('ready','placeholder')),
 anchorPresent INTEGER NOT NULL CHECK(anchorPresent IN (0,1)),
 anchorClipId TEXT,anchorOffset INTEGER,
 sourceKind TEXT CHECK(sourceKind IS NULL OR sourceKind IN ('shot','media')),
 sourceNodeId TEXT,segmentGroupId TEXT,
 versionMode TEXT CHECK(versionMode IS NULL OR versionMode IN ('follow','locked')),
 versionId TEXT,assetId TEXT,shotId TEXT,jobId TEXT,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) BETWEEN 2 AND 1048576 AND json_valid(data) AND json_type(data)='object' AND json_extract(data,'$.id') IS id),
 CHECK((anchorPresent=0 AND anchorClipId IS NULL AND anchorOffset IS NULL)
   OR (anchorPresent=1 AND (anchorClipId IS NULL AND anchorOffset IS NULL OR anchorClipId IS NOT NULL AND anchorOffset IS NOT NULL))),
 CHECK(sourceKind IS NOT NULL OR (sourceNodeId IS NULL AND segmentGroupId IS NULL AND versionMode IS NULL)),
 CHECK(sourceKind IS NULL OR (${jsonUuid('sourceNodeId')} AND ${jsonUuid('segmentGroupId')})))`,
  'CREATE INDEX timeline_clips_project ON timeline_clips(projectId,timelineId,id)',
  'CREATE INDEX timeline_clips_track_start ON timeline_clips(timelineId,trackId,startFrame)',
  'CREATE INDEX timeline_clips_anchor ON timeline_clips(timelineId,anchorClipId)',
  'CREATE INDEX timeline_clips_source ON timeline_clips(timelineId,sourceKind,sourceNodeId)',
  'CREATE INDEX timeline_clips_version ON timeline_clips(timelineId,versionId)',
  `CREATE TRIGGER timeline_clips_owner_insert BEFORE INSERT ON timeline_clips
 WHEN NOT EXISTS(SELECT 1 FROM timelines WHERE id=NEW.timelineId AND projectId=NEW.projectId)
 BEGIN SELECT RAISE(ABORT,'FORMAT5_CLIP_INVALID');END`,
  `CREATE TRIGGER timeline_clips_identity_guard BEFORE UPDATE OF timelineId,id,projectId ON timeline_clips
 WHEN NEW.timelineId IS NOT OLD.timelineId OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'FORMAT5_CLIP_INVALID');END`,
  ...(['insert', 'update', 'delete'] as const).map(operation => {
    const row = operation === 'delete' ? 'OLD' : 'NEW';
    const when = operation === 'update' ? ' WHEN NEW.data IS NOT OLD.data' : '';
    return `CREATE TRIGGER timeline_clips_target_${operation} AFTER ${operation.toUpperCase()} ON timeline_clips${when} BEGIN
 INSERT INTO agent_task_target_revisions_v2(projectId,kind,targetId,revision) VALUES(${row}.projectId,'timeline_clip',${row}.id,1)
 ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END`;
  }),
  `CREATE TABLE timeline_cues(
 timelineId TEXT NOT NULL REFERENCES timelines(id),
 id TEXT PRIMARY KEY NOT NULL CHECK(${jsonUuid('id')}),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(${jsonUuid('projectId')}),
 startFrame INTEGER NOT NULL CHECK(startFrame BETWEEN 0 AND 300000),
 durationFrames INTEGER NOT NULL CHECK(durationFrames BETWEEN 1 AND 300000),
 anchorClipId TEXT,anchorOffset INTEGER,
 dialogueShotId TEXT,dialogueLineId TEXT,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) BETWEEN 2 AND 1048576 AND json_valid(data) AND json_type(data)='object' AND json_extract(data,'$.id') IS id),
 CHECK((anchorClipId IS NULL AND anchorOffset IS NULL) OR (anchorClipId IS NOT NULL AND anchorOffset IS NOT NULL AND ${jsonUuid('anchorClipId')})),
 CHECK((dialogueShotId IS NULL AND dialogueLineId IS NULL) OR (${jsonUuid('dialogueShotId')} AND ${jsonUuid('dialogueLineId')})))`,
  'CREATE INDEX timeline_cues_project ON timeline_cues(projectId,timelineId,id)',
  'CREATE INDEX timeline_cues_start ON timeline_cues(timelineId,startFrame)',
  'CREATE INDEX timeline_cues_anchor ON timeline_cues(timelineId,anchorClipId)',
  `CREATE TRIGGER timeline_cues_owner_insert BEFORE INSERT ON timeline_cues
 WHEN NOT EXISTS(SELECT 1 FROM timelines WHERE id=NEW.timelineId AND projectId=NEW.projectId)
 BEGIN SELECT RAISE(ABORT,'FORMAT5_SUBTITLES_INVALID');END`,
  `CREATE TRIGGER timeline_cues_identity_guard BEFORE UPDATE OF timelineId,id,projectId ON timeline_cues
 WHEN NEW.timelineId IS NOT OLD.timelineId OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'FORMAT5_SUBTITLES_INVALID');END`,
  ...(['insert', 'update', 'delete'] as const).map(operation => {
    const row = operation === 'delete' ? 'OLD' : 'NEW';
    const when = operation === 'update' ? ' WHEN NEW.data IS NOT OLD.data' : '';
    return `CREATE TRIGGER timeline_cues_target_${operation} AFTER ${operation.toUpperCase()} ON timeline_cues${when} BEGIN
 INSERT INTO agent_task_target_revisions_v2(projectId,kind,targetId,revision) VALUES(${row}.projectId,'timeline_subtitle',${row}.id,1)
 ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END`;
  }),
]);

export const FORMAT5_PROJECT_SCHEMA = Object.freeze([
  `CREATE TABLE shot_version_adoptions(
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(${uuid('projectId')}),
 shotId TEXT NOT NULL REFERENCES shots(id) CHECK(${uuid('shotId')}),
 versionId TEXT NOT NULL REFERENCES versions(id) CHECK(${uuid('versionId')}),
 createdAt TEXT NOT NULL CHECK(${time('createdAt')}),PRIMARY KEY(shotId,versionId))`,
  'CREATE INDEX shot_version_adoptions_project ON shot_version_adoptions(projectId,shotId,versionId)',
  `CREATE TRIGGER shot_version_adoptions_project_insert BEFORE INSERT ON shot_version_adoptions
 WHEN NOT EXISTS(SELECT 1 FROM shots WHERE id=NEW.shotId AND projectId=NEW.projectId)
 OR NOT EXISTS(SELECT 1 FROM versions WHERE id=NEW.versionId AND projectId=NEW.projectId)
 BEGIN SELECT RAISE(ABORT,'FORMAT5_ADOPTION_INVALID');END`,
  `CREATE TRIGGER immutable_shot_version_adoptions BEFORE UPDATE ON shot_version_adoptions BEGIN SELECT RAISE(ABORT,'FORMAT5_ADOPTION_IMMUTABLE');END`,
  `CREATE TABLE sequence_sync_state(
 timelineId TEXT PRIMARY KEY NOT NULL REFERENCES timelines(id) CHECK(${uuid('timelineId')}),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(${uuid('projectId')}),
 sequenceNodeId TEXT NOT NULL REFERENCES nodes(id) CHECK(${uuid('sequenceNodeId')}),
 revision INTEGER NOT NULL CHECK(${revision('revision')}),
 baseline TEXT NOT NULL CHECK(${object('baseline', 524288)}))`,
  'CREATE INDEX sequence_sync_state_project ON sequence_sync_state(projectId,timelineId)',
  ...(['insert', 'update'] as const).map(operation => `CREATE TRIGGER sequence_sync_state_project_${operation} BEFORE ${operation.toUpperCase()} ON sequence_sync_state
 WHEN NOT EXISTS(SELECT 1 FROM timelines WHERE id=NEW.timelineId AND projectId=NEW.projectId)
 OR NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.sequenceNodeId AND projectId=NEW.projectId AND archivedAt IS NULL AND json_extract(data,'$.type')='sequence_root')
 BEGIN SELECT RAISE(ABORT,'FORMAT5_SYNC_STATE_INVALID');END`),
  `CREATE TRIGGER sequence_sync_state_revision BEFORE UPDATE ON sequence_sync_state
 WHEN NEW.timelineId IS NOT OLD.timelineId OR NEW.projectId IS NOT OLD.projectId OR NEW.revision IS NOT OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'FORMAT5_SYNC_REVISION_CONFLICT');END`,
]);

export const EDITOR_STORAGE_COLUMNS = ['historyEntries', 'historyBytes', 'receiptRows', 'receiptBytes'] as const;
export interface EditorStorageInventory {
  historyEntries: number; historyBytes: number; receiptRows: number; receiptBytes: number;
}
const historyPatchBytes = (row: string): string => `length(CAST(${row}.beforePatch AS BLOB))+length(CAST(${row}.afterPatch AS BLOB))`;
const receiptBytes = (row: string): string => `length(CAST(${row}.response AS BLOB))`;
const counterRequired = "SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM editor_storage_counters WHERE singleton=1) THEN RAISE(ABORT,'EDITOR_STORAGE_CORRUPT') END;";
const EDITOR_STORAGE_SCHEMA = Object.freeze([
  `CREATE TABLE editor_storage_counters(singleton INTEGER PRIMARY KEY CHECK(singleton=1),${EDITOR_STORAGE_COLUMNS.map(column => `${column} INTEGER NOT NULL CHECK(${revision(column, 0)})`).join(',')})`,
  `CREATE TRIGGER editor_storage_counters_insert BEFORE INSERT ON editor_storage_counters WHEN EXISTS(SELECT 1 FROM editor_storage_counters) BEGIN SELECT RAISE(ABORT,'EDITOR_STORAGE_CORRUPT');END`,
  `CREATE TRIGGER editor_storage_counters_delete BEFORE DELETE ON editor_storage_counters BEGIN SELECT RAISE(ABORT,'EDITOR_STORAGE_CORRUPT');END`,
  `CREATE TRIGGER editor_storage_counters_identity BEFORE UPDATE OF singleton ON editor_storage_counters WHEN NEW.singleton IS NOT OLD.singleton BEGIN SELECT RAISE(ABORT,'EDITOR_STORAGE_CORRUPT');END`,
]);
const EDITOR_STORAGE_DELTA_TRIGGERS = Object.freeze(([
  ['editor_history_entries', 'historyEntries', 'historyBytes', historyPatchBytes],
  ['editor_requests', 'receiptRows', 'receiptBytes', receiptBytes],
] as const).flatMap(([table, rows, bytes, countBytes]) => (['insert', 'delete'] as const).map(operation => {
  const inserted = operation === 'insert', count = inserted ? 1 : -1;
  const delta = `${inserted ? '' : '-'}(${countBytes(inserted ? 'NEW' : 'OLD')})`;
  return `CREATE TRIGGER editor_storage_${table}_${operation} AFTER ${operation.toUpperCase()} ON ${table} BEGIN
 ${counterRequired}
 SELECT CASE WHEN ${rows}+(${count}) NOT BETWEEN 0 AND 9007199254740991 OR ${bytes}+(${delta}) NOT BETWEEN 0 AND 9007199254740991 THEN RAISE(ABORT,'EDITOR_STORAGE_CORRUPT') END FROM editor_storage_counters WHERE singleton=1;
 UPDATE editor_storage_counters SET ${rows}=${rows}+(${count}),${bytes}=${bytes}+(${delta}) WHERE singleton=1;END`;
})));

function editorSchema(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new TypeError('Invalid editor storage schema');
  return schema;
}
function corruptEditorStorage(): never {throw Object.assign(new Error('Editor storage counters do not match their retained records.'), {code: 'EDITOR_STORAGE_CORRUPT'});}
function readEditorStorageCounters(db: DatabaseSync, schema: string): EditorStorageInventory {
  editorSchema(schema);
  const rows = db.prepare(`SELECT singleton,${EDITOR_STORAGE_COLUMNS.join(',')} FROM ${schema}.editor_storage_counters LIMIT 2`).all();
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1 || EDITOR_STORAGE_COLUMNS.some(column => typeof row[column] !== 'number' || !Number.isSafeInteger(row[column]) || Number(row[column]) < 0)) corruptEditorStorage();
  return {historyEntries: Number(row!.historyEntries), historyBytes: Number(row!.historyBytes), receiptRows: Number(row!.receiptRows), receiptBytes: Number(row!.receiptBytes)};
}
/** Opening and ordinary transactions only need this fixed-size shape check. */
export function assertEditorStorageCounters(db: DatabaseSync, schema = 'main'): void {readEditorStorageCounters(db, schema);}
/** Full logical inventory is reserved for initialization, doctor and tests. */
export function editorStorageInventory(db: DatabaseSync, schema = 'main'): EditorStorageInventory {
  editorSchema(schema);
  const history = db.prepare(`SELECT count(*) AS rows,COALESCE(sum(${historyPatchBytes('entry')}),0) AS bytes FROM ${schema}.editor_history_entries entry`).get()!;
  const receipts = db.prepare(`SELECT count(*) AS rows,COALESCE(sum(${receiptBytes('receipt')}),0) AS bytes FROM ${schema}.editor_requests receipt`).get()!;
  return {historyEntries: Number(history.rows), historyBytes: Number(history.bytes), receiptRows: Number(receipts.rows), receiptBytes: Number(receipts.bytes)};
}
export function assertEditorStorageInventory(db: DatabaseSync, schema = 'main'): void {
  const retained = editorStorageInventory(db, schema), counters = readEditorStorageCounters(db, schema);
  if (EDITOR_STORAGE_COLUMNS.some(column => retained[column] !== counters[column])) corruptEditorStorage();
}
export function initializeEditorStorageCounters(db: DatabaseSync, schema: string): void {
  if (!db.isTransaction) throw new TypeError('Editor counter initialization requires an opening transaction');
  editorSchema(schema);
  db.exec('PRAGMA recursive_triggers=ON');
  const retained = editorStorageInventory(db, schema);
  db.prepare(`INSERT INTO ${schema}.editor_storage_counters(singleton,${EDITOR_STORAGE_COLUMNS.join(',')}) VALUES(1,?,?,?,?)`)
    .run(retained.historyEntries, retained.historyBytes, retained.receiptRows, retained.receiptBytes);
}

/** Old canvas/timeline records remain readable. New user actions start at a
 * fresh epoch and use this single cross-domain history and receipt window. */
export const EDITOR_HISTORY_SCHEMA = Object.freeze([
  ...EDITOR_STORAGE_SCHEMA,
  `CREATE TABLE editor_history_entries(
 actionId TEXT PRIMARY KEY NOT NULL CHECK(${uuid('actionId')}),
 projectId TEXT NOT NULL CHECK(${uuid('projectId')}),epoch TEXT NOT NULL CHECK(${uuid('epoch')}),
 position INTEGER NOT NULL CHECK(${revision('position')}),
 operation TEXT NOT NULL CHECK(typeof(operation)='text' AND length(CAST(operation AS BLOB)) BETWEEN 1 AND 200),
 origin TEXT NOT NULL CHECK(origin IN ('user','mio')),
 beforePatch TEXT NOT NULL CHECK(${object('beforePatch', 4194304)}),
 afterPatch TEXT NOT NULL CHECK(${object('afterPatch', 4194304)}),
 createdAt TEXT NOT NULL CHECK(${time('createdAt')}),
 CHECK(length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB))<=4194304),UNIQUE(projectId,epoch,position))`,
  'CREATE INDEX editor_history_entries_project ON editor_history_entries(projectId,epoch,position)',
  `CREATE TRIGGER immutable_editor_history_entries BEFORE UPDATE ON editor_history_entries BEGIN SELECT RAISE(ABORT,'EDITOR_HISTORY_IMMUTABLE');END`,
  `CREATE TRIGGER reject_editor_history_replacement BEFORE INSERT ON editor_history_entries WHEN EXISTS(SELECT 1 FROM editor_history_entries WHERE actionId=NEW.actionId OR (projectId=NEW.projectId AND epoch=NEW.epoch AND position=NEW.position)) BEGIN SELECT RAISE(ABORT,'EDITOR_HISTORY_IMMUTABLE');END`,
  `CREATE TRIGGER bound_editor_history_entries BEFORE INSERT ON editor_history_entries BEGIN ${counterRequired}
 SELECT CASE WHEN historyEntries>=200 OR historyBytes+(${historyPatchBytes('NEW')})>134217728 THEN RAISE(ABORT,'EDITOR_HISTORY_LIMIT') END FROM editor_storage_counters WHERE singleton=1;END`,
  `CREATE TABLE editor_history_state(
 projectId TEXT PRIMARY KEY NOT NULL CHECK(${uuid('projectId')}),epoch TEXT NOT NULL CHECK(${uuid('epoch')}),
 position INTEGER NOT NULL CHECK(${revision('position', 0)}),revision INTEGER NOT NULL CHECK(${revision('revision')}),
 evidence TEXT NOT NULL CHECK(${object('evidence', 8388608)}))`,
  `CREATE TABLE editor_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(typeof(requestId)='text' AND length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 projectId TEXT NOT NULL CHECK(${uuid('projectId')}),
 operation TEXT NOT NULL CHECK(typeof(operation)='text' AND length(CAST(operation AS BLOB)) BETWEEN 1 AND 200),
 inputDigest TEXT NOT NULL CHECK(length(inputDigest)=64 AND inputDigest NOT GLOB '*[^a-f0-9]*'),
 response TEXT NOT NULL CHECK(${object('response', 65536)}),
 issuedAt INTEGER NOT NULL CHECK(${revision('issuedAt', 0)}),createdAt TEXT NOT NULL CHECK(${time('createdAt')}))`,
  'CREATE INDEX editor_requests_expiry ON editor_requests(issuedAt,requestId)',
  `CREATE TRIGGER immutable_editor_requests BEFORE UPDATE ON editor_requests BEGIN SELECT RAISE(ABORT,'EDITOR_REQUEST_IMMUTABLE');END`,
  `CREATE TRIGGER reject_editor_request_replacement BEFORE INSERT ON editor_requests WHEN EXISTS(SELECT 1 FROM editor_requests WHERE requestId=NEW.requestId) BEGIN SELECT RAISE(ABORT,'EDITOR_REQUEST_IMMUTABLE');END`,
  `CREATE TRIGGER bound_editor_requests BEFORE INSERT ON editor_requests BEGIN ${counterRequired}
 SELECT CASE WHEN receiptRows>=65536 OR receiptBytes+(${receiptBytes('NEW')})>33554432 THEN RAISE(ABORT,'EDITOR_RECEIPT_LIMIT') END FROM editor_storage_counters WHERE singleton=1;END`,
  `CREATE TABLE editor_receipt_window(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL CHECK(length(epoch)=32 AND epoch NOT GLOB '*[^0-9a-f]*'),
 floor INTEGER NOT NULL CHECK(${revision('floor', 0)}))`,
  ...EDITOR_STORAGE_DELTA_TRIGGERS,
]);

export function format5ContentStatements(format4: readonly string[]): readonly string[] {
  return [...format4.map(sql => {
    if (sql.startsWith('CREATE TABLE edges(')) return `${sql.slice(0, -1)}, ${FORMAT5_EDGE_CHECK})`;
    if (sql.startsWith('CREATE TABLE subject_bindings(')) return `${sql.replace('reviewedHeadVersionId TEXT NOT NULL', 'reviewedHeadVersionId TEXT').replace('createdAt TEXT', "bindingMode TEXT NOT NULL CHECK(bindingMode IN ('follow','locked','detached')),createdAt TEXT").slice(0, -1)}, CHECK((bindingMode='locked' AND subjectVersionId IS NOT NULL) OR (bindingMode IN ('follow','detached') AND subjectVersionId IS NULL)))`;
    if (sql.startsWith('CREATE INDEX subject_bindings_active_shot ')) return sql.replace('subjectVersionId IS NOT NULL', "bindingMode IN ('follow','locked')");
    if (sql.startsWith('CREATE TRIGGER agent_target_subject_bindings_update_v2 ')) return sql.replace(') BEGIN INSERT', ' OR NEW.bindingMode IS NOT OLD.bindingMode) BEGIN INSERT');
    return sql;
  }), ...FORMAT5_EDGE_INDEXES, ...FORMAT5_TIMELINE_GUARDS, ...FORMAT5_PROJECT_SCHEMA, ...FORMAT5_TIMELINE_ENTITY_SCHEMA];
}
