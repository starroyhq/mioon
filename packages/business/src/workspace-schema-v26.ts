import type {DatabaseSync} from 'node:sqlite';
import {repairWorkspaceReceiptProtectionsInTransaction, validateWorkspaceReceiptProtections} from './workspace-receipt-protections.ts';

// Ordinary26 is a separate migration from the immutable through24/restore25
// constructors. These trusted DDL literals are pinned to the independently
// retained ordinary24 catalog; imported database SQL is never executed.
// The operation CHECK is the only table-definition difference.
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
const COLUMNS = 'position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes';
const STAGING = 'edit_tasks_loudness_v26';
const MARKER_SQL = 'CREATE TABLE schema_version(version INTEGER PRIMARY KEY)';
const AUTO_INDEXES = new Set(['sqlite_autoindex_edit_tasks_1', 'sqlite_autoindex_edit_tasks_2']);
const fold = (name: string): string => name.replace(/[A-Z]/g, character => character.toLowerCase());
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

interface SchemaObject {type: string; name: string; table: string; sql: string | null}
interface Sequence {rowid: bigint; seq: bigint | number}

function unsupported(reason: string): never {
  throw Object.assign(new Error(`Ordinary schema26 migration is unsupported: ${reason}`), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
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

/** Validate before any DDL. Unknown dependencies are conservatively rejected;
 * unrelated custom objects are neither executed nor dropped. In particular an
 * inbound foreign key can turn DROP TABLE into a cascading data mutation. */
function preflight(db: DatabaseSync): {version: 24 | 26; sequence: Sequence | null} {
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
  const markers = db.prepare('SELECT CAST(version AS TEXT) AS version FROM main.schema_version ORDER BY main.schema_version.version LIMIT 26').all();
  const version = markers.length === 24 ? 24 : markers.length === 25 && markers[24]?.version === '26' ? 26 : null;
  if (version === null || markers.slice(0, 24).some((value, index) => value.version !== String(index + 1))) unsupported('markers must be exactly 1–24, or 1–24 plus 26');
  const expected = version === 24 ? TABLE24 : TABLE26;
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
  return {version, sequence: sequence(db)};
}

/** Read-only complete24 migration preflight. Run before the historical repair
 * constructor when all24 markers exist, so its marker writes cannot fire an
 * unknown imported trigger. This is not a full offline source24 classifier. */
export function validateWorkspaceSchema24For26Migration(db: DatabaseSync): void {
  if (preflight(db).version !== 24) unsupported('ordinary24 is required');
}

/** Read-only current26 gate. Never calls the historical ordinary initializer. */
export function validateWorkspaceSchema26(db: DatabaseSync): void {
  if (preflight(db).version !== 26) unsupported('ordinary26 is required');
}

/** Caller first resolves role and, only for historical ordinary workspaces,
 * completes the immutable through24 bootstrap/repair. Restore25/27 never enter
 * this initializer. All schema26 effects share one synchronous transaction.
 * Rollback guarantees logical catalog/raw records/receipts/constraints, not
 * physical SQLite or WAL byte identity. */
export function initializeWorkspaceSchema26(db: DatabaseSync): void {
  if (db.isTransaction) unsupported('nested migration transaction');
  connection(db);
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = preflight(db);
    validateWorkspaceReceiptProtections(db);
    if (current.version === 24) {
      db.exec(TABLE26.replace('CREATE TABLE "edit_tasks"', `CREATE TABLE main."${STAGING}"`));
      db.exec(`INSERT INTO main.${STAGING}(${COLUMNS}) SELECT ${COLUMNS} FROM main.edit_tasks`);
      db.exec('DROP TABLE main.edit_tasks');
      db.exec(`ALTER TABLE main.${STAGING} RENAME TO edit_tasks`);
      for (const object of PROTECTIONS) {
        db.exec(object.sql.replace(/^(CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) )/, '$1main.'));
      }
      const sequenceDelete=db.prepare("DELETE FROM main.sqlite_sequence WHERE name='edit_tasks'");sequenceDelete.setReadBigInts(true);sequenceDelete.run();
      if (current.sequence) {const sequenceInsert=db.prepare("INSERT INTO main.sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)");sequenceInsert.setReadBigInts(true);sequenceInsert.run(current.sequence.rowid, current.sequence.seq);}
      db.exec('INSERT INTO main.schema_version(version) VALUES(26)');
      // A postcondition catches a bad trusted migration edit before committing.
      validateWorkspaceSchema26(db);
    }
    repairWorkspaceReceiptProtectionsInTransaction(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
