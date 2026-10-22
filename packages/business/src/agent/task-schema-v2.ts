import {agentTaskRunSchema,agentTaskStepSchema,agentTaskChangeSchema,agentTaskEventSchema,agentTaskReceiptSchema,agentTaskPolicySchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {DatabaseSync} from 'node:sqlite';

export const AGENT_TASK_TABLES=Object.freeze(['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_target_revisions_v2','agent_task_edit_claims_v2','agent_task_edit_owners_v2','agent_task_edit_receipts_v2','agent_task_job_origins_v2','agent_task_imports_v2'] as const);
const revisions='agent_task_target_revisions_v2';
function bump(project:string,kind:string,id:string):string{return `INSERT INTO ${revisions}(projectId,kind,targetId,revision) VALUES(${project},'${kind}',${id},1) ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;`;}
export function installAgentTaskDefinitionsV2(db:DatabaseSync):void{
 db.exec(`CREATE TABLE agent_task_runs_v2(id TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL UNIQUE,digest TEXT NOT NULL CHECK(length(digest)=64),status TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152));
 CREATE INDEX agent_task_runs_project_v2 ON agent_task_runs_v2(projectId);
 CREATE TABLE agent_task_steps_v2(id TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),projectId TEXT NOT NULL REFERENCES projects(id),position INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152),UNIQUE(runId,position));
 CREATE TABLE agent_task_changes_v2(id TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),stepId TEXT NOT NULL REFERENCES agent_task_steps_v2(id),projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152));
 CREATE TABLE agent_task_events_v2(runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),projectId TEXT REFERENCES projects(id),sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),type TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152),PRIMARY KEY(runId,sequence));
 CREATE TABLE agent_task_controls_v2(requestId TEXT PRIMARY KEY NOT NULL,runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),projectId TEXT NOT NULL REFERENCES projects(id),digest TEXT NOT NULL CHECK(length(digest)=64),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152));
 CREATE TABLE agent_task_control_states_v2(requestId TEXT PRIMARY KEY NOT NULL REFERENCES agent_task_controls_v2(requestId),runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),projectId TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=2097152));
 CREATE TABLE agent_task_policy_v2(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=65536));
 CREATE TABLE agent_task_policy_requests_v2(requestId TEXT PRIMARY KEY NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=65536));
 CREATE TABLE agent_task_target_revisions_v2(projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,targetId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),PRIMARY KEY(projectId,kind,targetId));
 CREATE TABLE agent_task_edit_claims_v2(id TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),ownerId TEXT NOT NULL,kind TEXT NOT NULL,targetId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN ('active','uncertain')),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(projectId,ownerId,kind,targetId));
 CREATE TABLE agent_task_edit_owners_v2(ownerId TEXT NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),generation INTEGER NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(projectId,ownerId));
 CREATE TABLE agent_task_edit_receipts_v2(requestId TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),ownerId TEXT NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=65536));
 CREATE TABLE agent_task_job_origins_v2(kind TEXT NOT NULL,jobId TEXT NOT NULL,runId TEXT NOT NULL REFERENCES agent_task_runs_v2(id),stepId TEXT NOT NULL REFERENCES agent_task_steps_v2(id),projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(kind,jobId));
 CREATE TABLE agent_task_imports_v2(id TEXT PRIMARY KEY NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL UNIQUE,name TEXT NOT NULL CHECK(length(CAST(name AS BLOB))<=800),mimeType TEXT NOT NULL,relativePath TEXT NOT NULL CHECK(length(CAST(relativePath AS BLOB))<=512),sha256 TEXT NOT NULL CHECK(length(sha256)=64),status TEXT NOT NULL,assetId TEXT REFERENCES assets(id),resourceId TEXT,createdAt TEXT NOT NULL);`);
 for(const table of ['agent_task_events_v2','agent_task_controls_v2','agent_task_edit_receipts_v2','agent_task_job_origins_v2','agent_task_policy_requests_v2'])db.exec(`CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Agent task evidence is immutable');END;
 CREATE TRIGGER retain_${table} BEFORE DELETE ON ${table} WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='${table}' AND rowId=OLD.rowid) BEGIN SELECT RAISE(ABORT,'Agent task evidence must be retained');END;`);
 const entities=[['projects','project','id'],['shots','shot','id'],['nodes','node','id'],['edges','edge','id'],['jobs','job','id'],['assets','asset','id'],['versions','version','id'],['exports','export','id'],['asset_ranges','asset_range','assetId'],['asset_dispositions','asset_disposition','assetId'],['asset_annotations','asset_annotation','assetId'],['subjects','subject','id'],['subject_versions','subject_version','id'],['subject_bindings','subject_binding','id'],['image_tasks','image_task','id'],['image_groups','image_group','id'],['image_versions','image_version','id'],['frame_tasks','frame_task','id'],['project_lut_resources','lut','id']] as const;
 for(const [table,kind,key] of entities){const project=(prefix:string)=>`${prefix}.${table==='projects'?'id':'projectId'}`;
  for(const event of ['INSERT','UPDATE','DELETE'] as const){const prefix=event==='DELETE'?'OLD':'NEW',columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name));const difference=table==='projects'?"json_remove(NEW.data,'$.revision','$.updatedAt') IS NOT json_remove(OLD.data,'$.revision','$.updatedAt')":columns.map(column=>`NEW."${column}" IS NOT OLD."${column}"`).join(' OR ');const changed=`WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects')${event==='UPDATE'?` AND (${difference})`:''}`;const alive=event==='DELETE'?`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=${project(prefix)}) THEN RAISE(IGNORE) END;`:'';
   db.exec(`CREATE TRIGGER agent_target_${table}_${event.toLowerCase()}_v2 AFTER ${event} ON ${table} ${changed} BEGIN ${alive}${bump(project(prefix),kind,`${prefix}.${key}`)}END;`);
  }
  db.exec(`INSERT INTO ${revisions}(projectId,kind,targetId,revision) SELECT ${table==='projects'?'id':'projectId'},'${kind}',${key},1 FROM ${table};`);
 }
 // JSON child identity is the conflict unit. Aggregate revision, duration and
 // timestamps must not turn an unrelated clip edit into a whole timeline lock.
 for(const [field,kind] of [['clips','timeline_clip'],['tracks','timeline_track'],['subtitles.cues','timeline_subtitle']] as const){const sqlPath=`$.${field}`;
  db.exec(`INSERT INTO ${revisions}(projectId,kind,targetId,revision) SELECT t.projectId,'${kind}',json_extract(j.value,'$.id'),1 FROM timelines t,json_each(t.data,'${sqlPath}') j WHERE json_extract(j.value,'$.id') IS NOT NULL;`);
  for(const event of ['INSERT','UPDATE','DELETE'] as const){const entries=event==='INSERT'?`SELECT n.value AS value FROM json_each(NEW.data,'${sqlPath}') n`:event==='DELETE'?`SELECT o.value AS value FROM json_each(OLD.data,'${sqlPath}') o`:`SELECT n.value FROM json_each(NEW.data,'${sqlPath}') n LEFT JOIN json_each(OLD.data,'${sqlPath}') o ON json_extract(n.value,'$.id')=json_extract(o.value,'$.id') WHERE o.value IS NULL OR n.value IS NOT o.value UNION ALL SELECT o.value FROM json_each(OLD.data,'${sqlPath}') o WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.data,'${sqlPath}') n WHERE json_extract(n.value,'$.id')=json_extract(o.value,'$.id'))`;
   db.exec(`CREATE TRIGGER agent_target_timeline_${kind}_${event.toLowerCase()}_v2 AFTER ${event} ON timelines WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects') BEGIN INSERT INTO ${revisions}(projectId,kind,targetId,revision) SELECT ${event==='DELETE'?'OLD':'NEW'}.projectId,'${kind}',json_extract(changed.value,'$.id'),1 FROM (${entries}) changed WHERE json_extract(changed.value,'$.id') IS NOT NULL ON CONFLICT(projectId,kind,targetId) DO UPDATE SET revision=revision+1;END;`);
  }
 }
 const format=(prefix:string)=>`json_array(json_extract(${prefix}.data,'$.width'),json_extract(${prefix}.data,'$.height'),json_extract(${prefix}.data,'$.fps'))`;
 db.exec(`INSERT INTO ${revisions}(projectId,kind,targetId,revision) SELECT projectId,'timeline',projectId,1 FROM timelines;
 CREATE TRIGGER agent_target_timeline_insert_v2 AFTER INSERT ON timelines WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects') BEGIN ${bump('NEW.projectId','timeline','NEW.projectId')}END;
 CREATE TRIGGER agent_target_timeline_update_v2 AFTER UPDATE ON timelines WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects') AND ${format('NEW')} IS NOT ${format('OLD')} BEGIN ${bump('NEW.projectId','timeline','NEW.projectId')}END;`);
 // Existing manual edits must not consume the assistant execution quota merely
 // because their target revision is recorded. Editing claims have their own
 // bounded request shape and remain available when execution history is full.
 const quotaTables=AGENT_TASK_TABLES.filter(table=>!['agent_task_target_revisions_v2','agent_task_edit_claims_v2','agent_task_edit_owners_v2','agent_task_edit_receipts_v2'].includes(table));
 const counts=quotaTables.map(table=>`(SELECT count(*) FROM ${table})`).join('+');
 const bytes=['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2'].map(table=>`(SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM ${table})`).join('+');
 for(const table of quotaTables)for(const event of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER agent_quota_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN SELECT CASE WHEN ${counts}>20000 OR ${bytes}>67108864 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END;END;`);
}/* installAgentTaskDefinitionsV2 */
export function validateAgentTaskRowsV2(db:DatabaseSync,{allowConversations=false,allowInteractions=false}:{allowConversations?:boolean;allowInteractions?:boolean}={}):void{
 for(const table of ['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2'])if(db.prepare(`SELECT 1 FROM ${table} WHERE NOT json_valid(data) OR length(CAST(data AS BLOB))>2097152 LIMIT 1`).get())throw Object.assign(new Error('Invalid Agent task record'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const invalid=():never=>{throw Object.assign(new Error('Invalid Agent task record'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
 const families=[['agent_task_runs_v2',agentTaskRunSchema],['agent_task_steps_v2',agentTaskStepSchema],['agent_task_changes_v2',agentTaskChangeSchema],['agent_task_events_v2',agentTaskEventSchema],['agent_task_controls_v2',agentTaskReceiptSchema],['agent_task_control_states_v2',agentTaskReceiptSchema],['agent_task_policy_v2',agentTaskPolicySchema]] as const;
 let records=0,bytes=0;
 for(const [table,schema] of families)for(const row of db.prepare(`SELECT *,length(CAST(data AS BLOB)) AS bytes FROM ${table} LIMIT 20001`).iterate()){
  if(++records>20000||(bytes+=Number(row.bytes))>67108864||typeof row.data!=='string')invalid();
  const parsed=schema.safeParse(JSON.parse(String(row.data)));if(!parsed.success)invalid();const value=parsed.data as unknown as Record<string,unknown>;if(table==='agent_task_runs_v2'&&(!allowConversations&&Object.hasOwn(value,'conversationId')||!allowInteractions&&(Object.hasOwn(value,'notes')||Object.hasOwn(value,'skippedTargets'))))invalid();
  for(const key of ['id','projectId','runId','stepId','status','position','sequence','type','requestId'])if(Object.hasOwn(row,key)&&Object.hasOwn(value,key)&&row[key]!==value[key])invalid();
 }
 if(db.prepare('PRAGMA foreign_key_check').get())invalid();
 for(const table of ['agent_task_steps_v2','agent_task_changes_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_events_v2','agent_task_job_origins_v2'])if(db.prepare(`SELECT 1 FROM ${table} t JOIN agent_task_runs_v2 r ON r.id=t.runId WHERE t.projectId IS NOT r.projectId LIMIT 1`).get())invalid();
 for(const table of ['agent_task_changes_v2','agent_task_job_origins_v2'])if(db.prepare(`SELECT 1 FROM ${table} t JOIN agent_task_steps_v2 s ON s.id=t.stepId WHERE t.runId IS NOT s.runId OR t.projectId IS NOT s.projectId LIMIT 1`).get())invalid();
 if(db.prepare("SELECT 1 FROM agent_task_edit_claims_v2 WHERE typeof(revision)!='integer' OR revision NOT BETWEEN 0 AND 9007199254740991 LIMIT 1").get())invalid();
 if(db.prepare("SELECT 1 FROM agent_task_target_revisions_v2 WHERE typeof(revision)!='integer' OR revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get())throw Object.assign(new Error('Invalid Agent target revision'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}

/** Restoration freezes captured revision evidence while its legacy local
 * editing capability continues independently of the disabled v2 harness. */
export function dropAgentTaskTargetTriggersV2(db:DatabaseSync):void{
 for(const row of db.prepare("SELECT name FROM main.sqlite_schema WHERE type='trigger' AND name GLOB 'agent_target_*_v2'").all()){
  if(typeof row.name!=='string'||!/^agent_target_[a-z_]+_v2$/u.test(row.name))throw new Error('Invalid target trigger identity');
  db.exec(`DROP TRIGGER "${row.name}"`);
 }
}
