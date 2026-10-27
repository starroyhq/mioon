import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
// These twenty historical definitions are frozen in the independent52 fixture.
// The only reviewed quota edit is 67108864 -> 268435456; all remaining bytes,
// counted tables and the separate 20,000-record bound must still match exactly.
const previous=JSON.parse(readFileSync(new URL('../fixtures/workspace-schema-profiles/current-ordinary-52-delta.json',import.meta.url),'utf8')) as {objects:SchemaObject[]};
const oldQuotaObjects=previous.objects.filter(object=>object.name.startsWith('agent_quota_'));
assert.equal(oldQuotaObjects.length,20);
const quotaObjects=oldQuotaObjects.map(object=>{assert.equal(object.sql?.split('>67108864').length,2);return {...object,sql:object.sql!.replace('>67108864','>268435456')};});
/** Independently reviewed request immutability and the bounded256MiB quota.
 * Historical definitions and hashes remain the same after this exact inverse. */
export const currentOrdinary60Delta=Object.freeze({
 schemaVersionRows:[['60','integer','3630']] as const,
 objects:[
  {
    "type": "trigger",
    "name": "agent_task_model_request_delete_v60",
    "tbl_name": "agent_task_steps_v2",
    "sql": "CREATE TRIGGER agent_task_model_request_delete_v60 BEFORE DELETE ON agent_task_steps_v2\n WHEN json_extract(OLD.data,'$.kind')='model' AND NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='agent_task_steps_v2' AND rowId=OLD.rowid)\n BEGIN SELECT RAISE(ABORT,'Agent model request evidence must be retained');END"
  },
  {
    "type": "trigger",
    "name": "agent_task_model_request_replace_v60",
    "tbl_name": "agent_task_steps_v2",
    "sql": "CREATE TRIGGER agent_task_model_request_replace_v60 BEFORE INSERT ON agent_task_steps_v2\n WHEN EXISTS(SELECT 1 FROM agent_task_steps_v2 previous WHERE (previous.id=NEW.id OR previous.rowid=NEW.rowid OR previous.runId=NEW.runId AND previous.position=NEW.position) AND json_extract(previous.data,'$.kind')='model')\n BEGIN SELECT RAISE(ABORT,'Agent model request evidence must not be replaced');END"
  },
  {
    "type": "trigger",
    "name": "agent_task_model_request_update_v60",
    "tbl_name": "agent_task_steps_v2",
    "sql": "CREATE TRIGGER agent_task_model_request_update_v60 BEFORE UPDATE ON agent_task_steps_v2\n WHEN json_extract(OLD.data,'$.kind')='model' AND (NEW.id IS NOT OLD.id OR NEW.runId IS NOT OLD.runId OR NEW.projectId IS NOT OLD.projectId\n OR json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId')\n OR json_extract(NEW.data,'$.kind') IS NOT 'model' OR json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request'))\n BEGIN SELECT RAISE(ABORT,'Agent model request evidence is immutable');END"
  }
] as readonly SchemaObject[],
 quotaObjects,
});
const names=new Set(currentOrdinary60Delta.objects.map(object=>object.name));
const quotaNames=new Set(quotaObjects.map(object=>object.name));
export function withoutReviewedStorageObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const additions=objects.filter(object=>names.has(object.name));
 if(!additions.length)return [...objects];
 assert.deepEqual(additions.map(object=>({...object})),currentOrdinary60Delta.objects,'independent reviewed60 immutable request SQL');
 assert.deepEqual(objects.filter(object=>quotaNames.has(object.name)).map(object=>({...object})),quotaObjects,'independent reviewed60 quota SQL');
 const old=new Map(oldQuotaObjects.map(object=>[object.name,object]));
 return objects.filter(object=>!names.has(object.name)).map(object=>old.has(object.name)?{...object,...old.get(object.name)} as T:object);
}
export function withReviewedStorageObjects(objects:readonly SchemaObject[]):SchemaObject[] {
 assert.deepEqual(objects.filter(object=>quotaNames.has(object.name)).map(object=>({...object})),oldQuotaObjects,'unchanged historical quota catalogue');
 assert.equal(objects.some(object=>names.has(object.name)),false);
 const current=new Map(quotaObjects.map(object=>[object.name,object]));
 return [...objects.map(object=>current.get(object.name)??object),...currentOrdinary60Delta.objects].sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
}
/** A test-only downgrade requires genuine58 evidence: no reference events and
 * no excess data. It never rewrites, drops or compacts retained history. */
export function removeReviewedSchema60(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=60').get())return;
 // Newer layers go first; use downgradeReviewedWorkspace from reviewed-schema-layers.ts.
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>60').get(),undefined,'newer reviewed layers are removed first');
 const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'agent_task_model_request_*_v60' OR name GLOB 'agent_quota_*' ORDER BY type,name").all() as unknown as SchemaObject[];
 assert.deepEqual(withoutReviewedStorageObjects(objects),oldQuotaObjects);
 assert.equal(db.prepare("SELECT 1 FROM agent_task_events_v2 WHERE type='step' AND json_extract(data,'$.data.kind')='model' AND json_extract(data,'$.data.request.format') LIKE 'mioon-model-request-ref/%' LIMIT 1").get(),undefined,'new request references cannot be disguised as historical58');
 const byteTables=['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2'];
 const bytes=byteTables.reduce((total,table)=>total+Number(db.prepare(`SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM ${table}`).get()!.bytes),0);
 assert.ok(bytes<=64*1024*1024,'historical58 quota must remain valid');
 const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
 try{
  for(const object of [...currentOrdinary60Delta.objects,...quotaObjects])db.exec(`DROP ${object.type} "${object.name}"`);
  for(const object of oldQuotaObjects)db.exec(object.sql!);
  db.exec('DELETE FROM schema_version WHERE version=60');
  if(ownsTransaction)db.exec('COMMIT');
 }catch(error){if(ownsTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
