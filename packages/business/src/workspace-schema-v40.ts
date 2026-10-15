import {validateWorkspaceVolumeEnvelopeRows} from './workspace-volume-envelope-validation.ts';
import {validateWorkspaceAudioRoleRows} from './workspace-audio-role-validation.ts';
import {validateAssetAnnotationRows} from './asset-annotation-validation.ts';
import {DatabaseSync} from 'node:sqlite';
import {validateLutResourceRows} from './lut-resource-validation.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';
import {assertCompleteWorkspaceReceiptProtections} from './workspace-receipt-protections.ts';

// Dormant ordinary40 adds volume-envelope evidence with a marker-only migration.
// These schema definitions are copied and frozen independently; no historical
// constructor, dispatcher, live mutation or advertised capability is changed.
// Imported SQL is never executed or hidden behind a historical profile adapter.
const TABLE24 = "CREATE TABLE \"edit_tasks\"(\n position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),\n projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),\n operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','timeline.format.set','subject.create','subject.version.add','subject.binding.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove')),\n input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 8192),\n requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),\n digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),\n lane TEXT NOT NULL CHECK(lane IN ('timeline:mutation','reference:mutation','subject:mutation')),\n origin TEXT NOT NULL CHECK(origin IN ('new','legacy_session')),\n status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','unknown','applied','not_applied')),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),\n claim TEXT CHECK(claim IS NULL OR length(CAST(claim AS BLOB))=36),\n claimInstance TEXT CHECK(claimInstance IS NULL OR length(CAST(claimInstance AS BLOB))=36),\n receiptDigest TEXT CHECK(receiptDigest IS NULL OR length(CAST(receiptDigest AS BLOB))=64),\n errorCode TEXT CHECK(errorCode IS NULL OR length(CAST(errorCode AS BLOB)) BETWEEN 1 AND 80),\n createdAt TEXT NOT NULL CHECK(length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40),\n updatedAt TEXT NOT NULL CHECK(length(CAST(updatedAt AS BLOB)) BETWEEN 1 AND 40),\n bytes INTEGER NOT NULL CHECK(bytes=16384),UNIQUE(lane,requestId),\n CHECK(json_extract(input,'$.projectId')=projectId AND json_extract(input,'$.requestId')=requestId),\n CHECK((operation LIKE 'timeline.%' AND lane='timeline:mutation') OR (operation LIKE 'reference.%' AND lane='reference:mutation') OR (operation IN ('subject.create','subject.version.add','subject.binding.set') AND lane='subject:mutation')),\n CHECK((status='applied')=(receiptDigest IS NOT NULL)),CHECK((status='not_applied')=(errorCode IS NOT NULL)),\n CHECK((claim IS NULL)=(claimInstance IS NULL)),CHECK(status!='dispatching' OR claim IS NOT NULL),\n CHECK(status!='prepared' OR (origin='new' AND claim IS NULL)),CHECK(acknowledged=0 OR status IN ('applied','not_applied')))";
const TABLE26 = TABLE24.replace("\'timeline.subtitle.remove\'))", "\'timeline.subtitle.remove\',\'timeline.loudness.apply\'))");
const PROTECTIONS = [
  {
    "type": "index",
    "name": "edit_task_one_pending_lane",
    "tbl_name": "edit_tasks",
    "sql": "CREATE UNIQUE INDEX edit_task_one_pending_lane ON edit_tasks(projectId,lane) WHERE acknowledged=0"
  },
  {
    "type": "index",
    "name": "edit_tasks_project_page",
    "tbl_name": "edit_tasks",
    "sql": "CREATE INDEX edit_tasks_project_page ON edit_tasks(projectId,position DESC)"
  },
  {
    "type": "index",
    "name": "edit_tasks_project_pending_page",
    "tbl_name": "edit_tasks",
    "sql": "CREATE INDEX edit_tasks_project_pending_page ON edit_tasks(projectId,acknowledged,position DESC)"
  },
  {
    "type": "trigger",
    "name": "edit_task_state_transitions",
    "tbl_name": "edit_tasks",
    "sql": "CREATE TRIGGER edit_task_state_transitions BEFORE UPDATE ON edit_tasks\n WHEN NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR\n NOT ((OLD.status='prepared' AND NEW.status IN ('dispatching','applied')) OR\n      (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')) OR\n      (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','not_applied')) OR\n      (OLD.status IN ('applied','not_applied') AND NEW.status=OLD.status AND OLD.acknowledged=0 AND NEW.acknowledged=1)) OR\n (OLD.status NOT IN ('applied','not_applied') AND NEW.acknowledged!=0) OR\n (OLD.status IN ('applied','not_applied') AND (NEW.receiptDigest IS NOT OLD.receiptDigest OR NEW.errorCode IS NOT OLD.errorCode)) OR\n (NEW.status!='dispatching' AND (NEW.claim IS NOT OLD.claim OR NEW.claimInstance IS NOT OLD.claimInstance)) OR\n (NEW.status='dispatching' AND (NEW.claim IS NULL OR NEW.claim IS OLD.claim))\n BEGIN SELECT RAISE(ABORT,'invalid edit task transition');END"
  },
  {
    "type": "trigger",
    "name": "immutable_edit_task_identity",
    "tbl_name": "edit_tasks",
    "sql": "CREATE TRIGGER immutable_edit_task_identity BEFORE UPDATE ON edit_tasks\n WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR\n NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input OR NEW.requestId IS NOT OLD.requestId OR\n NEW.digest IS NOT OLD.digest OR NEW.lane IS NOT OLD.lane OR NEW.origin IS NOT OLD.origin OR\n NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes\n BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END"
  },
  {
    "type": "trigger",
    "name": "reject_edit_task_replacement",
    "tbl_name": "edit_tasks",
    "sql": "CREATE TRIGGER reject_edit_task_replacement BEFORE INSERT ON edit_tasks\n WHEN EXISTS(SELECT 1 FROM edit_tasks WHERE id=NEW.id OR position=NEW.position OR (lane=NEW.lane AND requestId=NEW.requestId))\n BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END"
  },
  {
    "type": "trigger",
    "name": "retain_edit_tasks",
    "tbl_name": "edit_tasks",
    "sql": "CREATE TRIGGER retain_edit_tasks BEFORE DELETE ON edit_tasks\n BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END"
  }
] as const;
const STAGING = 'edit_tasks_loudness_v26';
const MARKER_SQL = 'CREATE TABLE schema_version(version INTEGER PRIMARY KEY)';
const AUTO_INDEXES = new Set(['sqlite_autoindex_edit_tasks_1', 'sqlite_autoindex_edit_tasks_2']);
const fold = (name: string): string => name.replace(/[A-Z]/g, character => character.toLowerCase());
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

interface SchemaObject {type: string; name: string; table: string; sql: string | null}
interface Sequence {rowid: bigint; seq: bigint | number}

function unsupported(reason: string): never {
  throw Object.assign(new Error(`Ordinary schema40 migration is unsupported: ${reason}`), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
}

function connection(db: DatabaseSync): void {
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0) unsupported('unsafe connection settings');
}

function catalog(db: DatabaseSync, schema: 'main' | 'temp' = 'main'): SchemaObject[] {
  const result: SchemaObject[] = [];
  let bytes = 0;
  for (const value of db.prepare(`SELECT type,
    CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,
    CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,
    CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql,
    length(CAST(sql AS BLOB)) AS bytes FROM ${schema}.sqlite_schema ORDER BY type,name LIMIT 1025`).iterate()) {
    if (result.length >= 1024 || typeof value.type !== 'string' || typeof value.name !== 'string' ||
        typeof value.tbl_name !== 'string' || value.sql !== null && typeof value.sql !== 'string' ||
        value.bytes !== null && (typeof value.bytes !== 'number' || value.bytes > 131072 || (bytes += value.bytes) > 1048576)) {
      unsupported('schema catalog limit');
    }
    result.push({type: value.type, name: value.name, table: value.tbl_name, sql: value.sql});
  }
  return result;
}

function sequence(db: DatabaseSync): Sequence | null {
  // Historical task migrations rebind safe integer-valued Numbers as REAL in
  // affinity-less sqlite_sequence.seq. Keep that storage class on reconstruction.
  // Project only numeric payloads so an imported oversized TEXT/BLOB is
  // rejected without materializing it in JS.
  const read = db.prepare("SELECT rowid,CASE WHEN typeof(seq) IN ('integer','real') THEN seq END AS seq,typeof(seq) AS kind FROM main.sqlite_sequence WHERE name='edit_tasks' LIMIT 2");
  read.setReadBigInts(true);
  const rows = read.all();
  const maximumRead = db.prepare('SELECT MAX(position) AS maximum FROM main.edit_tasks');
  maximumRead.setReadBigInts(true);
  const maximum = maximumRead.get()?.maximum;
  if (rows.length > 1 || maximum !== null && typeof maximum !== 'bigint') unsupported('task sequence shape');
  if (rows.length === 0) {
    if (maximum !== null) unsupported('missing task sequence');
    return null;
  }
  const item = rows[0];
  const seq = item?.seq;
  if (!item || typeof item.rowid !== 'bigint' ||
      !(item.kind === 'integer' && typeof seq === 'bigint' ||
        item.kind === 'real' && typeof seq === 'number' && Number.isSafeInteger(seq))) unsupported('inconsistent task sequence');
  const highWater = BigInt(seq);
  if (highWater < 0n || typeof maximum === 'bigint' && highWater < maximum) unsupported('inconsistent task sequence');
  return {rowid: item.rowid, seq};
}

/** Validate before any DDL. Retain the ordinary26 safety boundary for task
 * dependencies; this additive migration never rebuilds or drops an old table.
 * Unrelated custom objects are neither executed nor modified. */
function preflight(db: DatabaseSync): {version: 38 | 40; sequence: Sequence | null} {
  connection(db);
  const objects = catalog(db);
  for (const object of catalog(db, 'temp')) {
    if (object.type === 'trigger' && ['edit_tasks', 'schema_version'].includes(fold(object.table)) ||
        (object.type === 'view' || object.type === 'trigger') && /edit_tasks/i.test(object.sql ?? '')) unsupported('temporary task dependency');
  }
  for (const object of objects) {
    const name = fold(object.name);
    if (name.startsWith('workspace_restor') || name.startsWith('restore_')) unsupported('restoration evidence');
    if (name === STAGING) unsupported('staging object already exists');
  }
  const marker = objects.find(object => fold(object.name) === 'schema_version');
  if (!marker || marker.name !== 'schema_version' || marker.type !== 'table' || marker.sql !== MARKER_SQL) unsupported('marker table shape');
  const markers = db.prepare('SELECT CAST(version AS TEXT) AS version FROM main.schema_version ORDER BY main.schema_version.version LIMIT 33').all();
  const prefix = markers[24]?.version === '26' && markers[25]?.version === '28' && markers[26]?.version === '30' && markers[27]?.version === '32' && markers[28]?.version === '34' && markers[29]?.version === '36' && markers[30]?.version === '38';
  const version = prefix && markers.length === 31 ? 38 : prefix && markers.length === 32 && markers[31]?.version === '40' ? 40 : null;
  if (version === null || markers.slice(0, 24).some((value, index) => value.version !== String(index + 1))) unsupported('markers must be exactly 1–24 plus 26, 28, 30, 32, 34, 36 and 38, optionally followed by 40');
  const expected = TABLE26;
  const tasks = objects.filter(object => fold(object.table) === 'edit_tasks');
  if (tasks.length !== PROTECTIONS.length + AUTO_INDEXES.size + 1) unsupported('unknown or missing task dependencies');
  for (const object of tasks) {
    if (object.type === 'table' && object.name === 'edit_tasks' && object.sql === expected) continue;
    if (object.type === 'index' && object.sql === null && AUTO_INDEXES.has(object.name)) continue;
    if (PROTECTIONS.some(known => known.type === object.type && known.name === object.name && known.sql === object.sql)) continue;
    unsupported('task table, index or trigger differs from fixed ordinary schema');
  }
  if (!tasks.some(object => object.type === 'table' && object.name === 'edit_tasks')) unsupported('missing task table');
  for (const object of objects) {
    if (fold(object.table) === 'edit_tasks') continue;
    if (object.type === 'trigger' && fold(object.table) === 'schema_version') unsupported('custom marker trigger');
    // Conservatively includes quoted names, comments and string literals. No
    // unknown trigger/view is run to decide whether it is safe to reconstruct.
    if ((object.type === 'trigger' || object.type === 'view') && /edit_tasks/i.test(object.sql ?? '')) unsupported('custom task dependency');
    if (object.type !== 'table') continue;
    for (const foreignKey of db.prepare(`PRAGMA main.foreign_key_list(${quote(object.name)})`).iterate()) {
      if (typeof foreignKey.table !== 'string' || fold(foreignKey.table) === 'edit_tasks') unsupported('inbound task foreign key');
    }
  }
  if (db.prepare("SELECT 1 FROM pragma_foreign_key_check('edit_tasks','main') LIMIT 1").get()) unsupported('task foreign key violation');
  validateLutObjects(db, objects, version);
  assertCompleteWorkspaceReceiptProtections(db);
  validateWorkspaceColourRows(db, {allowColour:true,allowMixedImages:true,allowJpegImages:true});
  validateAnnotationObjects(db, objects, version);
  validateWorkspaceAudioRoleRows(db, {allowAudioRoles:true});
  validateWorkspaceVolumeEnvelopeRows(db, {allowVolumeEnvelopes:version===40});
  return {version, sequence: sequence(db)};
}


// No source path is retained, no playable-media row is created, and exact bytes
// remain inside the same transaction/durable database as their receipt.
const WORKSPACE_LUT_SCHEMA_SQL = `
 CREATE TABLE project_lut_resources(
 id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id)='text' AND length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),
 name TEXT NOT NULL CHECK(typeof(name)='text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 800),
 sha256 TEXT NOT NULL CHECK(typeof(sha256)='text' AND length(CAST(sha256 AS BLOB))=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 sizeBytes INTEGER NOT NULL CHECK(typeof(sizeBytes)='integer' AND sizeBytes BETWEEN 1 AND 7340032),
 profile TEXT NOT NULL CHECK(profile='mioon-cube3d-normalized-tetrahedral-v1'),
 metadata TEXT NOT NULL CHECK(typeof(metadata)='text' AND length(CAST(metadata AS BLOB)) BETWEEN 1 AND 4096 AND json_valid(metadata) AND json_type(metadata)='object'),
 content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content)=sizeBytes),
 createdAt TEXT NOT NULL CHECK(typeof(createdAt)='text' AND length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40),
 UNIQUE(id,projectId));
 CREATE INDEX project_lut_resources_project ON project_lut_resources(projectId,id);
 CREATE TABLE lut_import_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(typeof(requestId)='text' AND length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),
 inputHash TEXT NOT NULL CHECK(typeof(inputHash)='text' AND length(CAST(inputHash AS BLOB))=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 resourceId TEXT NOT NULL UNIQUE CHECK(typeof(resourceId)='text' AND length(CAST(resourceId AS BLOB))=36),
 FOREIGN KEY(resourceId,projectId) REFERENCES project_lut_resources(id,projectId));
 CREATE TRIGGER immutable_project_lut_resources BEFORE UPDATE ON project_lut_resources
 BEGIN SELECT RAISE(ABORT,'LUT_RESOURCE_IMMUTABLE');END;
 CREATE TRIGGER retain_project_lut_resources BEFORE DELETE ON project_lut_resources
 BEGIN SELECT RAISE(ABORT,'LUT_RESOURCE_IMMUTABLE');END;
 CREATE TRIGGER reject_project_lut_resource_replacement BEFORE INSERT ON project_lut_resources
 WHEN EXISTS(SELECT 1 FROM project_lut_resources WHERE id=NEW.id OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'LUT_RESOURCE_IMMUTABLE');END;
 CREATE TRIGGER immutable_lut_import_requests BEFORE UPDATE ON lut_import_requests
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;
 CREATE TRIGGER retain_lut_import_requests BEFORE DELETE ON lut_import_requests
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;
 CREATE TRIGGER reject_lut_import_request_replacement BEFORE INSERT ON lut_import_requests
 WHEN EXISTS(SELECT 1 FROM lut_import_requests WHERE requestId=NEW.requestId OR resourceId=NEW.resourceId OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_IMMUTABLE');END;
 CREATE TRIGGER bound_project_lut_resources BEFORE INSERT ON project_lut_resources
 WHEN (SELECT count(*) FROM project_lut_resources)>=512
 OR (SELECT count(*) FROM project_lut_resources WHERE projectId=NEW.projectId)>=128
 OR COALESCE((SELECT SUM(sizeBytes) FROM project_lut_resources),0)+NEW.sizeBytes>134217728
 OR COALESCE((SELECT SUM(sizeBytes) FROM project_lut_resources WHERE projectId=NEW.projectId),0)+NEW.sizeBytes>67108864
 BEGIN SELECT RAISE(ABORT,'LUT_RESOURCE_LIMIT');END;
 CREATE TRIGGER bound_lut_import_requests BEFORE INSERT ON lut_import_requests
 WHEN (SELECT count(*) FROM lut_import_requests)>=4096
 BEGIN SELECT RAISE(ABORT,'LUT_IMPORT_RECEIPT_LIMIT');END;
`;
let lutObjects: SchemaObject[] | undefined;
function fixedLutObjects(): SchemaObject[] {
  if (lutObjects) return lutObjects;
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    reference.exec(WORKSPACE_LUT_SCHEMA_SQL);
    lutObjects = catalog(reference);
    return lutObjects;
  } finally {reference.close();}
}
function validateLutObjects(db: DatabaseSync, objects: SchemaObject[], version: 38 | 40): void {
  const expected = fixedLutObjects(), names = new Set(expected.map(object => fold(object.name)));
  const tables = new Set(['project_lut_resources', 'lut_import_requests']);
  const relevant = (object: SchemaObject) => names.has(fold(object.name)) || tables.has(fold(object.table));
  // Do not allow a TEMP table/view/trigger to shadow resource integrity checks.
  if (catalog(db, 'temp').some(relevant)) unsupported('temporary LUT object or shadow');
  const actual = objects.filter(relevant);
  if (actual.length !== expected.length || expected.some(known => !actual.some(object =>
    object.type === known.type && object.name === known.name && object.table === known.table && object.sql === known.sql))) {
    unsupported('LUT table, index or protection differs from fixed schema28');
  }
  for (const object of objects) {
    if (relevant(object)) continue;
    if ((object.type === 'trigger' || object.type === 'view') && /project_lut_resources|lut_import_requests/i.test(object.sql ?? '')) unsupported('unknown LUT dependency');
  }
}

/** Read-only explicit dormant ordinary40 gate. Offline callers verify owned bytes by
 * default. Ordinary startup explicitly chooses bounded metadata/receipt checks
 * without reparsing every retained LUT; inspect still verifies requested bytes. */
export function validateWorkspaceSchema40(db: DatabaseSync, {verifyBytes=true}: {verifyBytes?: boolean} = {}): void {
  if (preflight(db).version !== 40) unsupported('ordinary40 is required');
  validateLutResourceRows(db, {verifyBytes});
  validateAssetAnnotationRows(db);
}

/** Dormant marker-only, all-or-nothing38→40 migration; existing rows/DDL/rowids stay exact.
 * Restored25/27/29/31/33/35/37/39/41 never enter this initializer. No filesystem effects occur. */
export function initializeWorkspaceSchema40(db: DatabaseSync): void {
  if (db.isTransaction) unsupported('nested migration transaction');
  connection(db);
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = preflight(db);
    if (current.version === 38) db.exec('INSERT INTO main.schema_version(version) VALUES(40)');
    validateWorkspaceSchema40(db, {verifyBytes:false});
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const ANNOTATION_SCHEMA_SQL = `
 CREATE TABLE asset_annotations(
 assetId TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) CHECK(typeof(assetId)='text' AND length(CAST(assetId AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 tags TEXT NOT NULL CHECK(typeof(tags)='text' AND length(CAST(tags AS BLOB)) BETWEEN 2 AND 16384 AND json_valid(tags) AND json_type(tags)='array'),
 note TEXT NOT NULL CHECK(typeof(note)='text' AND length(CAST(note AS BLOB))<=16384));
 CREATE INDEX asset_annotations_project ON asset_annotations(projectId,assetId);
 CREATE TRIGGER immutable_asset_annotation_identity BEFORE UPDATE ON asset_annotations
 WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'asset annotation identity is immutable');END;
 CREATE TRIGGER advance_asset_annotation_revision BEFORE UPDATE ON asset_annotations
 WHEN NEW.revision IS NOT OLD.revision+1 OR OLD.revision>=9007199254740991
 BEGIN SELECT RAISE(ABORT,'asset annotation revision must advance');END;
 CREATE TRIGGER reject_asset_annotation_replacement BEFORE INSERT ON asset_annotations
 WHEN EXISTS(SELECT 1 FROM asset_annotations WHERE assetId=NEW.assetId OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'asset annotation replacement is forbidden');END;
 CREATE TRIGGER retain_asset_annotations BEFORE DELETE ON asset_annotations
 BEGIN SELECT RAISE(ABORT,'asset annotation revisions must be retained');END;
 CREATE TABLE asset_annotation_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(typeof(requestId)='text' AND length(CAST(requestId AS BLOB)) BETWEEN 8 AND 800),
 operation TEXT NOT NULL CHECK(operation='asset.annotation.set'),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(typeof(canonicalInput)='text' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576 AND json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND json_extract(canonicalInput,'$.projectId') IS projectId),
 response TEXT NOT NULL CHECK(typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 24576 AND json_valid(response) AND json_type(response)='object' AND json_extract(response,'$.projectId') IS projectId));
 CREATE TRIGGER reject_asset_annotation_request_replacement BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId OR rowid=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'asset annotation request responses are immutable');END;
 CREATE TRIGGER immutable_asset_annotation_requests BEFORE UPDATE ON asset_annotation_requests
 BEGIN SELECT RAISE(ABORT,'asset annotation request responses are immutable');END;
 CREATE TRIGGER retain_asset_annotation_requests BEFORE DELETE ON asset_annotation_requests
 BEGIN SELECT RAISE(ABORT,'asset annotation request responses must be retained');END;
 ${['mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests'].map(table=>`
 CREATE TRIGGER reject_annotation_cross_${table} BEFORE INSERT ON asset_annotation_requests
 WHEN EXISTS(SELECT 1 FROM ${table} WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER reject_${table}_cross_annotation BEFORE INSERT ON ${table}
 WHEN EXISTS(SELECT 1 FROM asset_annotation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;`).join('')}
`;
let annotationObjects:SchemaObject[]|undefined;
function fixedAnnotationObjects():SchemaObject[]{
 if(annotationObjects)return annotationObjects;
 const reference=new DatabaseSync(':memory:');
 try{reference.exec(`CREATE TABLE assets(id TEXT PRIMARY KEY);CREATE TABLE projects(id TEXT PRIMARY KEY);${['mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests'].map(table=>`CREATE TABLE ${table}(requestId TEXT PRIMARY KEY);`).join('')}`);
 const before=new Set(catalog(reference).map(value=>value.name));reference.exec(ANNOTATION_SCHEMA_SQL);
 annotationObjects=catalog(reference).filter(value=>!before.has(value.name));return annotationObjects;
 }finally{reference.close();}
}
function validateAnnotationObjects(db:DatabaseSync,objects:SchemaObject[],version:38|40):void{
 const expected=fixedAnnotationObjects(),names=new Set(expected.map(value=>fold(value.name)));
 const relevant=(value:SchemaObject)=>names.has(fold(value.name))||['asset_annotations','asset_annotation_requests'].includes(fold(value.table));
 if(catalog(db,'temp').some(value=>relevant(value)||/asset_annotations|asset_annotation_requests/i.test(value.sql??'')))unsupported('temporary annotation object or shadow');
 const actual=objects.filter(relevant);
 if(actual.length!==expected.length||expected.some(known=>!actual.some(value=>JSON.stringify(value)===JSON.stringify(known))))unsupported('annotation definitions differ from fixed schema36');
 for(const value of objects){
  if(relevant(value))continue;
  if((value.type==='trigger'||value.type==='view')&&/asset_annotations|asset_annotation_requests/i.test(value.sql??''))unsupported('unknown annotation dependency');
  if(value.type==='table')for(const foreign of db.prepare(`PRAGMA main.foreign_key_list(${quote(value.name)})`).iterate())if(typeof foreign.table!=='string'||['asset_annotations','asset_annotation_requests'].includes(fold(foreign.table)))unsupported('unknown annotation foreign key');
 }
}
