export {migrateTimelineSubtitleEditTasks} from './timeline-subtitle-schema.ts';
// Fixed backend-owned schema definitions. No operation or table name comes from RPC input.
// The historical v14 bootstrap remains byte-equivalent for existing operation rows.
const tableDefinition = (subjects = false, staging = false, format = false) => {
 const table = format ? 'edit_tasks_formats' : staging ? 'edit_tasks_subjects' : 'edit_tasks';
 return ` CREATE TABLE IF NOT EXISTS ${table}(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE CHECK(length(CAST(id AS BLOB))=36),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 operation TEXT NOT NULL CHECK(operation IN ('timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach'${format ? ",'timeline.format.set'" : ''}${subjects ? ",'subject.create','subject.version.add','subject.binding.set'" : ''})),
 input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB)) BETWEEN 1 AND 8192),
 requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 digest TEXT NOT NULL CHECK(length(CAST(digest AS BLOB))=64),
 lane TEXT NOT NULL CHECK(lane IN ('timeline:mutation','reference:mutation'${subjects ? ",'subject:mutation'" : ''})),
 origin TEXT NOT NULL CHECK(origin IN ('new','legacy_session')),
 status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','unknown','applied','not_applied')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)),
 claim TEXT CHECK(claim IS NULL OR length(CAST(claim AS BLOB))=36),
 claimInstance TEXT CHECK(claimInstance IS NULL OR length(CAST(claimInstance AS BLOB))=36),
 receiptDigest TEXT CHECK(receiptDigest IS NULL OR length(CAST(receiptDigest AS BLOB))=64),
 errorCode TEXT CHECK(errorCode IS NULL OR length(CAST(errorCode AS BLOB)) BETWEEN 1 AND 80),
 createdAt TEXT NOT NULL CHECK(length(CAST(createdAt AS BLOB)) BETWEEN 1 AND 40),
 updatedAt TEXT NOT NULL CHECK(length(CAST(updatedAt AS BLOB)) BETWEEN 1 AND 40),
 bytes INTEGER NOT NULL CHECK(bytes=16384),UNIQUE(lane,requestId),
 CHECK(json_extract(input,'$.projectId')=projectId AND json_extract(input,'$.requestId')=requestId),
 CHECK((operation LIKE 'timeline.%' AND lane='timeline:mutation') OR (operation LIKE 'reference.%' AND lane='reference:mutation')${subjects ? " OR (operation IN ('subject.create','subject.version.add','subject.binding.set') AND lane='subject:mutation')" : ''}),
 CHECK((status='applied')=(receiptDigest IS NOT NULL)),CHECK((status='not_applied')=(errorCode IS NOT NULL)),
 CHECK((claim IS NULL)=(claimInstance IS NULL)),CHECK(status!='dispatching' OR claim IS NOT NULL),
 CHECK(status!='prepared' OR (origin='new' AND claim IS NULL)),CHECK(acknowledged=0 OR status IN ('applied','not_applied')));
`;
};
const protections = ` CREATE UNIQUE INDEX IF NOT EXISTS edit_task_one_pending_lane ON edit_tasks(projectId,lane) WHERE acknowledged=0;
 CREATE INDEX IF NOT EXISTS edit_tasks_project_page ON edit_tasks(projectId,position DESC);
 CREATE INDEX IF NOT EXISTS edit_tasks_project_pending_page ON edit_tasks(projectId,acknowledged,position DESC);
 CREATE TRIGGER IF NOT EXISTS reject_edit_task_replacement BEFORE INSERT ON edit_tasks
 WHEN EXISTS(SELECT 1 FROM edit_tasks WHERE id=NEW.id OR position=NEW.position OR (lane=NEW.lane AND requestId=NEW.requestId))
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_edit_task_identity BEFORE UPDATE ON edit_tasks
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input OR NEW.requestId IS NOT OLD.requestId OR
 NEW.digest IS NOT OLD.digest OR NEW.lane IS NOT OLD.lane OR NEW.origin IS NOT OLD.origin OR
 NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes
 BEGIN SELECT RAISE(ABORT,'edit task identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_edit_tasks BEFORE DELETE ON edit_tasks
 BEGIN SELECT RAISE(ABORT,'edit task identities must be retained');END;
 CREATE TRIGGER IF NOT EXISTS edit_task_state_transitions BEFORE UPDATE ON edit_tasks
 WHEN NEW.revision!=OLD.revision+1 OR OLD.revision>=9007199254740991 OR
 NOT ((OLD.status='prepared' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')) OR
      (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','not_applied')) OR
      (OLD.status IN ('applied','not_applied') AND NEW.status=OLD.status AND OLD.acknowledged=0 AND NEW.acknowledged=1)) OR
 (OLD.status NOT IN ('applied','not_applied') AND NEW.acknowledged!=0) OR
 (OLD.status IN ('applied','not_applied') AND (NEW.receiptDigest IS NOT OLD.receiptDigest OR NEW.errorCode IS NOT OLD.errorCode)) OR
 (NEW.status!='dispatching' AND (NEW.claim IS NOT OLD.claim OR NEW.claimInstance IS NOT OLD.claimInstance)) OR
 (NEW.status='dispatching' AND (NEW.claim IS NULL OR NEW.claim IS OLD.claim))
 BEGIN SELECT RAISE(ABORT,'invalid edit task transition');END;
`;

export function bootstrapEditTaskSchema(db) {
 db.exec(`BEGIN IMMEDIATE;${tableDefinition()}${protections}
 INSERT OR IGNORE INTO schema_version VALUES(14);COMMIT;`);
}

// Called inside schema15's transaction, before its final version marker. SQLite
// cannot extend CHECK lists in place. Copy raw columns, never parse/rewrite inputs.
export function migrateSubjectEditTasks(db) {
 if (!db.isTransaction) throw new Error('Subject task migration requires a transaction');
 if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_tasks_subjects'").get())
  throw new Error('Subject task migration staging table already exists');
 const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='edit_tasks'").get();
 const maximum = db.prepare('SELECT MAX(position) AS value FROM edit_tasks').get().value;
 if (sequence && (!Number.isSafeInteger(sequence.seq) || sequence.seq < 0 || (maximum !== null && sequence.seq < maximum)) || !sequence && maximum !== null)
  throw new Error('Edit task sequence is inconsistent');
 db.exec(tableDefinition(true, true));
 const columns = 'position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes';
 db.exec(`INSERT INTO edit_tasks_subjects(${columns}) SELECT ${columns} FROM edit_tasks;
 DROP TABLE edit_tasks;
 ALTER TABLE edit_tasks_subjects RENAME TO edit_tasks;${protections}`);
 // Renaming transfers SQLite's staging sequence. Preserve the original high-water
 // mark exactly, including absence for an empty never-used historical table.
 db.prepare("DELETE FROM sqlite_sequence WHERE name='edit_tasks'").run();
 if (sequence) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('edit_tasks',?)").run(sequence.seq);
}

// Schema21 changes only the operation CHECK whitelist. Preserve raw task bytes,
// state, claims, indexes/triggers and the exact AUTOINCREMENT high-water mark.
export function migrateTimelineFormatEditTasks(db) {
 if(!db.isTransaction)throw new Error('Timeline format task migration requires a transaction');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_tasks_formats'").get())
  throw new Error('Timeline format task migration staging table already exists');
 const sequence=db.prepare("SELECT rowid AS rowid,seq FROM sqlite_sequence WHERE name='edit_tasks'").get();
 const maximum=db.prepare('SELECT MAX(position) AS value FROM edit_tasks').get().value;
 if(sequence&&(!Number.isSafeInteger(sequence.seq)||sequence.seq<0||(maximum!==null&&sequence.seq<maximum))||!sequence&&maximum!==null)
  throw new Error('Edit task sequence is inconsistent');
 db.exec(tableDefinition(true,true,true));
 const columns='position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes';
 db.exec(`INSERT INTO edit_tasks_formats(${columns}) SELECT ${columns} FROM edit_tasks;
 DROP TABLE edit_tasks;
 ALTER TABLE edit_tasks_formats RENAME TO edit_tasks;${protections}`);
 db.prepare("DELETE FROM sqlite_sequence WHERE name='edit_tasks'").run();
 if(sequence)db.prepare("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)").run(sequence.rowid,sequence.seq);
}
