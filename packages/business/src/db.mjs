import {DatabaseSync} from 'node:sqlite';
import {isAsyncFunction,isPromise} from 'node:util/types';
import path from 'node:path';
import {ensurePrivateDirectory,validatePrivateDirectory,validateManagedDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic,removePrivateFile} from '@mioon/contracts/private-storage';
import {INSPECTION_VERSION_ASSET_EXPRESSION} from './inspection-query.mjs';

/** Read-only preflight of every startup-owned entry, before any lock, token,
 * directory or SQLite write. Legacy 0755 media and 0644 SQLite remain protected
 * by the verified 0700 root, provided no other account can write them. */
export function validateWorkspaceStorage(root){
 root=path.resolve(root);
 if(!validatePrivateDirectory(root,{allowMissing:true}))return;
 validateManagedDirectory(path.join(root,'media'),{root,allowMissing:true});
 for(const name of ['workbench.sqlite','workbench.sqlite-wal','workbench.sqlite-shm','workbench.sqlite-journal']){
  validateManagedFile(path.join(root,name),{root,allowMissing:true});
 }
 validateManagedFile(path.join(root,'server.lock'),{root,allowMissing:true,maxBytes:64});
 validateManagedFile(path.join(root,'access-token'),{root,allowMissing:true,private:true,maxBytes:4098});
 const settings=path.join(root,'agent-settings');
 if(validateManagedDirectory(settings,{root,allowMissing:true,private:true})){
  validateManagedFile(path.join(settings,'settings.json'),{root,allowMissing:true,private:true,maxBytes:64*1024});
 }
}

export function openStore(root,{lock=true}={}){
 root=path.resolve(root);
 validateWorkspaceStorage(root);
 ensurePrivateDirectory(root,{create:true});
 validateWorkspaceStorage(root);
 const lockPath=path.join(root,'server.lock');
 let db,ownedLock;
 const releaseLock=()=>{
  if(!ownedLock)return;
  try{
   const current=validateManagedFile(lockPath,{root,allowMissing:true,maxBytes:64});
   if(current&&current.ino===ownedLock.ino&&current.dev===ownedLock.dev&&readPrivateFile(lockPath,{root,private:false,maxBytes:64,encoding:'utf8'})===String(process.pid)){
    removePrivateFile(lockPath,{root,private:false,maxBytes:64});
   }
  }catch{} // Never delete a changed, linked or otherwise unsafe lock in cleanup.
  ownedLock=undefined;
 };
 try{
  if(lock){
   const previous=readPrivateFile(lockPath,{root,allowMissing:true,private:false,maxBytes:64,encoding:'utf8'});
   if(previous!==null){
    const pid=Number(previous);let active=false;
    if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);active=true;}catch(error){if(error.code!=='ESRCH')active=true;}}
    if(active)throw Error('This data directory already has a running backend');
    removePrivateFile(lockPath,{root,private:false,maxBytes:64});
   }
   writePrivateFileAtomic(lockPath,String(process.pid),{root,maxBytes:64,replace:false});
   ownedLock=validateManagedFile(lockPath,{root,private:true,maxBytes:64});
  }
  // Recheck immediately before SQLite's pathname-only open. Node has no SQLite
  // fd/NOFOLLOW API; a concurrent same-uid/root adversary is outside this policy.
  validateWorkspaceStorage(root);
  db=new DatabaseSync(path.join(root,'workbench.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);INSERT OR IGNORE INTO schema_version VALUES(1);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS shots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS timelines(id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS timeline_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,resourceId TEXT NOT NULL,PRIMARY KEY(scope,requestId));
 CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,jobId TEXT NOT NULL,event TEXT NOT NULL,createdAt TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'versions are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_timeline_responses BEFORE UPDATE ON timeline_requests BEGIN SELECT RAISE(ABORT,'timeline request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_timeline_render_snapshot BEFORE UPDATE ON exports
 WHEN json_extract(OLD.data,'$.mode')='timeline' AND (
 json_extract(NEW.data,'$.mode') IS NOT 'timeline' OR
 json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot') OR
 json_extract(NEW.data,'$.timelineRevision') IS NOT json_extract(OLD.data,'$.timelineRevision') OR
 json_extract(NEW.data,'$.purpose') IS NOT json_extract(OLD.data,'$.purpose'))
 BEGIN SELECT RAISE(ABORT,'timeline render snapshots are immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(2);`);
 // Additive history migration: old timelines become the untouched baseline of
 // their first new edit. Never manufacture history or rewrite legacy responses.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS timeline_history(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 position INTEGER NOT NULL CHECK(position>0),operation TEXT NOT NULL,createdAt TEXT NOT NULL,
 beforeSnapshot TEXT NOT NULL,afterSnapshot TEXT NOT NULL,UNIQUE(projectId,position));
 CREATE TABLE IF NOT EXISTS timeline_history_cursors(
 projectId TEXT PRIMARY KEY REFERENCES projects(id),position INTEGER NOT NULL CHECK(position>=0));
 CREATE TRIGGER IF NOT EXISTS immutable_timeline_history BEFORE UPDATE ON timeline_history
 BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(3);
 COMMIT;`);
 // Reference edits store their exact response independently of mutable edges.
 // Additive only: all historical edges remain visual-only until explicitly bound.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS reference_requests(requestId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS immutable_reference_responses BEFORE UPDATE ON reference_requests
 BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(4);
 COMMIT;`);
 // Single-user project view preferences have an independent revision. This
 // additive table never changes business records, history or request journals.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS workspace_preferences(
 projectId TEXT PRIMARY KEY REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
 state TEXT NOT NULL CHECK(json_valid(state) AND length(CAST(state AS BLOB))<=16384));
 INSERT OR IGNORE INTO schema_version VALUES(5);
 COMMIT;`);
 // Additive chat-only journal. No project/business record or older journal is
 // rewritten. Accepted requests are immutable and are never silently evicted.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS agent_chat_threads(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL UNIQUE REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>=0),nextPosition INTEGER NOT NULL CHECK(nextPosition>0));
 CREATE TABLE IF NOT EXISTS agent_chat_requests(
 requestId TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),runId TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL,acceptance TEXT NOT NULL CHECK(json_valid(acceptance)),bytes INTEGER NOT NULL CHECK(bytes>=0));
 CREATE TABLE IF NOT EXISTS agent_chat_runs(
 id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),
 threadId TEXT NOT NULL REFERENCES agent_chat_threads(id),requestId TEXT NOT NULL UNIQUE REFERENCES agent_chat_requests(requestId),
 position INTEGER NOT NULL CHECK(position>0),status TEXT NOT NULL CHECK(status IN ('running','completed','failed','stopped','interrupted')),
 data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(threadId,position));
 CREATE UNIQUE INDEX IF NOT EXISTS agent_chat_one_active ON agent_chat_runs(projectId) WHERE status='running';
 CREATE INDEX IF NOT EXISTS agent_chat_history ON agent_chat_runs(projectId,position DESC);
 CREATE INDEX IF NOT EXISTS agent_chat_completed ON agent_chat_runs(projectId,status,position DESC);
 CREATE TABLE IF NOT EXISTS agent_chat_events(
 runId TEXT NOT NULL REFERENCES agent_chat_runs(id),seq INTEGER NOT NULL CHECK(seq>0),
 data TEXT NOT NULL CHECK(json_valid(data)),bytes INTEGER NOT NULL CHECK(bytes>=0),PRIMARY KEY(runId,seq));
 CREATE TABLE IF NOT EXISTS agent_chat_quota(
 id INTEGER PRIMARY KEY CHECK(id=1),runs INTEGER NOT NULL CHECK(runs>=0),
 bytes INTEGER NOT NULL CHECK(bytes>=0),reservedBytes INTEGER NOT NULL CHECK(reservedBytes>=0));
 INSERT OR IGNORE INTO agent_chat_quota VALUES(1,0,0,0);
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_requests BEFORE UPDATE ON agent_chat_requests
 BEGIN SELECT RAISE(ABORT,'accepted chat requests are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_agent_chat_requests BEFORE DELETE ON agent_chat_requests
 BEGIN SELECT RAISE(ABORT,'accepted chat requests must be retained');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_run_identity BEFORE UPDATE ON agent_chat_runs
 WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.threadId IS NOT OLD.threadId OR
 NEW.requestId IS NOT OLD.requestId OR NEW.position IS NOT OLD.position OR
 json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR
 json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR
 json_extract(NEW.data,'$.threadId') IS NOT json_extract(OLD.data,'$.threadId') OR
 json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR
 json_extract(NEW.data,'$.userText') IS NOT json_extract(OLD.data,'$.userText') OR
 json_extract(NEW.data,'$.configuration') IS NOT json_extract(OLD.data,'$.configuration') OR
 json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR
 json_extract(NEW.data,'$.modelRequestId') IS NOT json_extract(OLD.data,'$.modelRequestId')
 BEGIN SELECT RAISE(ABORT,'accepted chat identity and configuration are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_events BEFORE UPDATE ON agent_chat_events
 BEGIN SELECT RAISE(ABORT,'chat events are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_agent_chat_events BEFORE DELETE ON agent_chat_events
 BEGIN SELECT RAISE(ABORT,'chat events must be retained');END;
 INSERT OR IGNORE INTO schema_version VALUES(6);
 COMMIT;`);
 // Read-only inspection uses indexes rather than repeatedly scanning JSON.
 // Building these additive indexes scans existing rows once at first startup;
 // no record, historical response or journal is rewritten by this migration.
 db.exec(`BEGIN IMMEDIATE;
 CREATE INDEX IF NOT EXISTS inspection_versions_asset_id ON versions(${INSPECTION_VERSION_ASSET_EXPRESSION},id);
 ${['assets','shots','nodes','edges','jobs','versions','exports','timelines'].map(table=>`CREATE INDEX IF NOT EXISTS inspection_${table}_project_id ON ${table}(projectId,id);`).join('\n')}
 INSERT OR IGNORE INTO schema_version VALUES(7);
 COMMIT;`);
 // Bounded Agent inspection steps are additive; legacy chat rows remain intact.
 // Payloads are write-once and retained independently from their progress state.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS agent_chat_steps(
 id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES agent_chat_runs(id),
 projectId TEXT NOT NULL REFERENCES projects(id),position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 3),
 kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
 status TEXT NOT NULL CHECK(status IN ('not_started','intent','dispatch_started','completed','unknown')),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=1048576),
 bytes INTEGER NOT NULL CHECK(bytes>=0),UNIQUE(runId,position));
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_step_payload BEFORE UPDATE ON agent_chat_steps
 WHEN NEW.id IS NOT OLD.id OR NEW.runId IS NOT OLD.runId OR NEW.projectId IS NOT OLD.projectId OR
 NEW.position IS NOT OLD.position OR NEW.kind IS NOT OLD.kind OR
 json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR
 json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId') OR
 json_extract(NEW.data,'$.projectId') IS NOT json_extract(OLD.data,'$.projectId') OR
 json_extract(NEW.data,'$.position') IS NOT json_extract(OLD.data,'$.position') OR
 json_extract(NEW.data,'$.kind') IS NOT json_extract(OLD.data,'$.kind') OR
 json_extract(NEW.data,'$.ordinal') IS NOT json_extract(OLD.data,'$.ordinal') OR
 json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR
 json_extract(NEW.data,'$.requestId') IS NOT json_extract(OLD.data,'$.requestId') OR
 json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request') OR
 json_extract(NEW.data,'$.modelStepId') IS NOT json_extract(OLD.data,'$.modelStepId') OR
 json_extract(NEW.data,'$.intent') IS NOT json_extract(OLD.data,'$.intent') OR
 (json_type(OLD.data,'$.output') IS NOT NULL AND json_extract(NEW.data,'$.output') IS NOT json_extract(OLD.data,'$.output')) OR
 (json_type(OLD.data,'$.observation') IS NOT NULL AND json_extract(NEW.data,'$.observation') IS NOT json_extract(OLD.data,'$.observation'))
 BEGIN SELECT RAISE(ABORT,'agent step payloads are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_agent_chat_steps BEFORE DELETE ON agent_chat_steps
 BEGIN SELECT RAISE(ABORT,'agent steps must be retained');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_inspection_context BEFORE UPDATE ON agent_chat_runs
 WHEN json_extract(NEW.data,'$.contextMode') IS NOT json_extract(OLD.data,'$.contextMode') OR
 json_extract(NEW.data,'$.provenance') IS NOT json_extract(OLD.data,'$.provenance')
 BEGIN SELECT RAISE(ABORT,'accepted inspection context is immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(8);
 COMMIT;`);
 // Exact local mutation replies are additive, immutable and permanently retained.
 // Existing business records and every older request journal stay untouched.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS mutation_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('shot.create','shot.update','shot.reorder','node.create','node.update','version.select')),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));
 CREATE TRIGGER IF NOT EXISTS reject_mutation_request_replacement BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_mutation_requests BEFORE UPDATE ON mutation_requests
 BEGIN SELECT RAISE(ABORT,'mutation request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_mutation_requests BEFORE DELETE ON mutation_requests
 BEGIN SELECT RAISE(ABORT,'mutation request responses must be retained');END;
 INSERT OR IGNORE INTO schema_version VALUES(9);
 COMMIT;`);
 // Reviewed Agent edits are proposals, never domain writes. Immutable intent,
 // approval and exact mutation keys survive every restart and are never evicted.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS agent_edit_proposals(
 position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 projectId TEXT NOT NULL REFERENCES projects(id),runId TEXT NOT NULL UNIQUE REFERENCES agent_chat_runs(id),shotId TEXT NOT NULL,
 digest TEXT NOT NULL,definition TEXT NOT NULL CHECK(json_valid(definition) AND length(CAST(definition AS BLOB))<=131072),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','dispatching','unknown','applied','failed','rejected','cancelled')),
 approval TEXT CHECK(approval IS NULL OR (json_valid(approval) AND length(CAST(approval AS BLOB))<=32768)),
 outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB))<=1024)),
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 196608),
 CHECK((status IN ('pending','rejected','cancelled'))=(approval IS NULL)),
 CHECK((status IN ('applied','failed'))=(outcome IS NOT NULL)));
 CREATE INDEX IF NOT EXISTS agent_edit_project_page ON agent_edit_proposals(projectId,position DESC);
 CREATE TRIGGER IF NOT EXISTS reject_agent_edit_replacement BEFORE INSERT ON agent_edit_proposals
 WHEN EXISTS(SELECT 1 FROM agent_edit_proposals WHERE id=NEW.id OR runId=NEW.runId)
 BEGIN SELECT RAISE(ABORT,'agent edit identities are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_edit_intent BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.position IS NOT OLD.position OR NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR
 NEW.runId IS NOT OLD.runId OR NEW.shotId IS NOT OLD.shotId OR NEW.digest IS NOT OLD.digest OR
 NEW.definition IS NOT OLD.definition OR NEW.createdAt IS NOT OLD.createdAt OR NEW.bytes IS NOT OLD.bytes OR
 (OLD.approval IS NOT NULL AND NEW.approval IS NOT OLD.approval) OR
 (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
 BEGIN SELECT RAISE(ABORT,'agent edit intent and approval are immutable');END;
 CREATE TRIGGER IF NOT EXISTS guard_agent_edit_transition BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.status IS NOT OLD.status AND NOT (
 (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR
 (OLD.status='approved' AND NEW.status IN ('dispatching','unknown','applied')) OR
 (OLD.status='dispatching' AND NEW.status IN ('unknown','applied','failed')) OR
 (OLD.status='unknown' AND NEW.status IN ('dispatching','applied')))
 BEGIN SELECT RAISE(ABORT,'invalid agent edit transition');END;
 CREATE TRIGGER IF NOT EXISTS retain_agent_edit_proposals BEFORE DELETE ON agent_edit_proposals
 BEGIN SELECT RAISE(ABORT,'agent edit proposals must be retained');END;
 CREATE TRIGGER IF NOT EXISTS immutable_agent_chat_edit_target BEFORE UPDATE ON agent_chat_runs
 WHEN json_extract(NEW.data,'$.editTarget') IS NOT json_extract(OLD.data,'$.editTarget')
 BEGIN SELECT RAISE(ABORT,'accepted shot edit target is immutable');END;
 INSERT OR IGNORE INTO schema_version VALUES(10);
 COMMIT;`);
 // Source ranges are independent metadata. Keep the original six-operation
 // journal and every retained response byte intact; new receipts use a narrow
 // companion, with one global request-ID namespace enforced in both directions.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS asset_ranges(
 assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 inFrame INTEGER NOT NULL CHECK(typeof(inFrame)='integer' AND inFrame BETWEEN 0 AND 9007199254740991),
 outFrame INTEGER NOT NULL CHECK(typeof(outFrame)='integer' AND outFrame>inFrame AND outFrame<=9007199254740991));
 CREATE INDEX IF NOT EXISTS asset_ranges_project ON asset_ranges(projectId,assetId);
 CREATE TRIGGER IF NOT EXISTS immutable_asset_range_identity BEFORE UPDATE ON asset_ranges
 WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'source range identity is immutable');END;
 CREATE TABLE IF NOT EXISTS asset_range_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.range.set'),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput)),
 response TEXT NOT NULL CHECK(json_valid(response)));
 CREATE TRIGGER IF NOT EXISTS reject_asset_range_request_replacement BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_asset_range_requests BEFORE UPDATE ON asset_range_requests
 BEGIN SELECT RAISE(ABORT,'source range request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_asset_range_requests BEFORE DELETE ON asset_range_requests
 BEGIN SELECT RAISE(ABORT,'source range request responses must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_asset_range_cross_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_mutation_cross_range_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 INSERT OR IGNORE INTO schema_version VALUES(11);
 COMMIT;`);
 // Shared asset disposition is independent of the asset, source range and
 // timeline. Preserve all earlier schema/receipt bytes; extend their global
 // request namespace additively in all directions under the same write lock.
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS asset_dispositions(
 assetId TEXT PRIMARY KEY REFERENCES assets(id),projectId TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 disposition TEXT NOT NULL CHECK(disposition IN ('neutral','favorite','rejected')));
 CREATE INDEX IF NOT EXISTS asset_dispositions_project ON asset_dispositions(projectId,assetId);
 CREATE TRIGGER IF NOT EXISTS immutable_asset_disposition_identity BEFORE UPDATE ON asset_dispositions
 WHEN NEW.assetId IS NOT OLD.assetId OR NEW.projectId IS NOT OLD.projectId
 BEGIN SELECT RAISE(ABORT,'asset disposition identity is immutable');END;
 CREATE TABLE IF NOT EXISTS asset_disposition_requests(
 requestId TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation='asset.disposition.set'),
 projectId TEXT NOT NULL REFERENCES projects(id),
 canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND length(CAST(canonicalInput AS BLOB))<=4096),
 response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB))<=4096));
 CREATE TRIGGER IF NOT EXISTS reject_asset_disposition_request_replacement BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS immutable_asset_disposition_requests BEFORE UPDATE ON asset_disposition_requests
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses are immutable');END;
 CREATE TRIGGER IF NOT EXISTS retain_asset_disposition_requests BEFORE DELETE ON asset_disposition_requests
 BEGIN SELECT RAISE(ABORT,'asset disposition request responses must be retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_asset_disposition_cross_request BEFORE INSERT ON asset_disposition_requests
 WHEN EXISTS(SELECT 1 FROM mutation_requests WHERE requestId=NEW.requestId) OR
 EXISTS(SELECT 1 FROM asset_range_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_mutation_cross_disposition_request BEFORE INSERT ON mutation_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 CREATE TRIGGER IF NOT EXISTS reject_asset_range_cross_disposition_request BEFORE INSERT ON asset_range_requests
 WHEN EXISTS(SELECT 1 FROM asset_disposition_requests WHERE requestId=NEW.requestId)
 BEGIN SELECT RAISE(ABORT,'mutation request ID is already retained');END;
 INSERT OR IGNORE INTO schema_version VALUES(12);
 COMMIT;`);
 const tables=new Set(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines']);
 const table=t=>{if(!tables.has(t))throw Error('Unknown table');return t;};
 const get=(t,id)=>{const r=db.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);return r?JSON.parse(r.data):null;};
 const list=(t,p)=>db.prepare(`SELECT data FROM ${table(t)}${p?' WHERE projectId=?':''}`).all(...p?[p]:[]).map(r=>JSON.parse(r.data));
 const put=(t,obj)=>{table(t);const cols=t==='projects'?['id','data']:t==='versions'?['id','projectId','jobId','data']:['id','projectId','data'];const values=cols.map(k=>k==='data'?JSON.stringify(obj):obj[k]);db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);return obj;};
 // A transaction owns its complete synchronous callback. Never commit before
 // asynchronous work, or let a nested caller roll back an outer transaction.
 const tx=fn=>{
  if(typeof fn!=='function'||isAsyncFunction(fn))throw new TypeError('Transactions require a synchronous callback');
  if(db.isTransaction)throw new Error('Nested transactions are not supported');
  db.exec('BEGIN IMMEDIATE');
  try{
   const result=fn();
   if(result&&typeof result.then==='function'){
    if(isPromise(result))result.catch(()=>{});
    throw new TypeError('Transactions require a synchronous result');
   }
   db.exec('COMMIT');return result;
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 };
 // Do not create media until the complete preflight and schema initialization
 // succeed. Existing safe legacy media permissions are deliberately preserved.
 if(!validateManagedDirectory(path.join(root,'media'),{root,allowMissing:true}))ensurePrivateDirectory(path.join(root,'media'),{create:true});
 let closed=false;
 const close=()=>{if(closed)return;db.close();closed=true;releaseLock();};
 return {db,root,get,list,put,tx,close};
 }catch(error){
  try{db?.close();}catch{}
  releaseLock();
  throw error;
 }
}
