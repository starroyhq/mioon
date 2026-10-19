import type {DatabaseSync} from 'node:sqlite';

const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
function unsupported():never{throw Object.assign(new Error('Project lifecycle schema is unsupported.'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});}

/** Trusted schema construction only. A deletion grants each exact row for one
 * synchronous transaction; no authority may survive commit or a crash. */
export function installProjectLifecycleDefinitions(db:DatabaseSync):void{
  db.exec(`CREATE TABLE project_deletion_scope(tableName TEXT NOT NULL,rowId INTEGER NOT NULL CHECK(typeof(rowId)='integer'),PRIMARY KEY(tableName,rowId));
    CREATE TABLE project_mutation_requests(requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),digest TEXT NOT NULL CHECK(length(digest)=64),response TEXT NOT NULL CHECK(json_valid(response)));
    CREATE TRIGGER immutable_project_mutation_requests BEFORE UPDATE ON project_mutation_requests BEGIN SELECT RAISE(ABORT,'project responses are immutable');END;
    CREATE TRIGGER retain_project_mutation_requests BEFORE DELETE ON project_mutation_requests BEGIN SELECT RAISE(ABORT,'project responses must be retained');END;
    CREATE TABLE project_deletion_receipts(requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL CHECK(length(projectId)=36),digest TEXT NOT NULL CHECK(length(digest)=64),createdAt TEXT NOT NULL);
    CREATE TRIGGER immutable_project_deletion_receipts BEFORE UPDATE ON project_deletion_receipts BEGIN SELECT RAISE(ABORT,'project deletion receipts are immutable');END;
    CREATE TRIGGER retain_project_deletion_receipts BEFORE DELETE ON project_deletion_receipts BEGIN SELECT RAISE(ABORT,'project deletion receipts must be retained');END;
    CREATE TABLE project_deletion_cleanup(requestId TEXT PRIMARY KEY REFERENCES project_deletion_receipts(requestId),manifest TEXT NOT NULL CHECK(json_valid(manifest) AND length(CAST(manifest AS BLOB))<=1048576));`);
  const guards=db.prepare("SELECT name,tbl_name,sql FROM main.sqlite_schema WHERE type='trigger' AND name GLOB 'retain_*' ORDER BY name").all();
  for(const guard of guards){
    if(guard.name==='retain_project_deletion_receipts')continue;
    if(typeof guard.name!=='string'||typeof guard.tbl_name!=='string'||typeof guard.sql!=='string')unsupported();
    // The complete source44 classifier proves these application-owned guards.
    // Refuse a future conditional shape until its combination is reviewed.
    if(/\bWHEN\b/iu.test(guard.sql))unsupported();
    const predicate=`WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='${guard.tbl_name}' AND rowId=OLD.rowid) `;
    const sql=guard.sql.replace(/\bBEGIN\b/iu,predicate+'BEGIN');
    if(sql===guard.sql)unsupported();
    db.exec(`DROP TRIGGER ${quote(guard.name)}`);db.exec(sql);
  }
}

export function migrateProjectLifecycleSchema(db:DatabaseSync,classifySource:(db:DatabaseSync)=>unknown):void{
  if(db.isTransaction||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1||db.prepare('PRAGMA trusted_schema').get()?.trusted_schema!==0||db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get())unsupported();
  classifySource(db);
  db.exec('BEGIN IMMEDIATE');
  try{installProjectLifecycleDefinitions(db);db.exec('INSERT INTO schema_version VALUES(48)');if(db.prepare('PRAGMA foreign_key_check').get())unsupported();db.exec('COMMIT');}
  catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}

export function validateProjectLifecycleRows(db:DatabaseSync):void{
  if(db.prepare('SELECT 1 FROM project_deletion_scope LIMIT 1').get())unsupported();
  if(db.prepare('SELECT 1 FROM project_deletion_receipts WHERE length(CAST(requestId AS BLOB))!=36 OR length(CAST(projectId AS BLOB))!=36 OR length(CAST(digest AS BLOB))!=64 OR digest GLOB \'*[^a-f0-9]*\' LIMIT 1').get())unsupported();
  if(db.prepare('SELECT 1 FROM project_deletion_cleanup WHERE length(CAST(manifest AS BLOB))>1048576 OR NOT json_valid(manifest) LIMIT 1').get())unsupported();
}
