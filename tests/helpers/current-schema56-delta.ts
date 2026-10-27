import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
/** Independently reviewed A2/A3 additions. Fixed52/54 catalogs remain unchanged;
 * exclude these exact definitions only after checking their retained SQL. */
export const currentOrdinary56Delta=Object.freeze({
 schemaVersionRows:[['56','integer','3536']] as const,
 objects:[
  {
    "type": "trigger",
    "name": "agent_task_interaction_insert_v2",
    "tbl_name": "agent_task_runs_v2",
    "sql": "CREATE TRIGGER agent_task_interaction_insert_v2 BEFORE INSERT ON agent_task_runs_v2\n WHEN json_type(NEW.data,'$.notes') IS NOT 'array' OR json_type(NEW.data,'$.skippedTargets') IS NOT 'array'\n OR (SELECT count(*) FROM json_each(NEW.data,'$.notes') WHERE json_type(value,'$.modelStepId') IS NULL)>5\n BEGIN SELECT RAISE(ABORT,'Agent interaction arrays are required');END"
  },
  {
    "type": "trigger",
    "name": "agent_task_interaction_update_v2",
    "tbl_name": "agent_task_runs_v2",
    "sql": "CREATE TRIGGER agent_task_interaction_update_v2 BEFORE UPDATE OF data ON agent_task_runs_v2\n WHEN json_type(NEW.data,'$.notes') IS NOT 'array' OR json_type(NEW.data,'$.skippedTargets') IS NOT 'array'\n OR (SELECT count(*) FROM json_each(NEW.data,'$.notes') WHERE json_type(value,'$.modelStepId') IS NULL)>5\n OR json_array_length(NEW.data,'$.notes')<json_array_length(OLD.data,'$.notes')\n OR json_array_length(NEW.data,'$.skippedTargets')<json_array_length(OLD.data,'$.skippedTargets')\n OR EXISTS(SELECT 1 FROM json_each(OLD.data,'$.notes') previous WHERE json_extract(NEW.data,'$.notes['||previous.key||'].requestId') IS NOT json_extract(previous.value,'$.requestId') OR json_extract(NEW.data,'$.notes['||previous.key||'].text') IS NOT json_extract(previous.value,'$.text') OR json_extract(NEW.data,'$.notes['||previous.key||'].createdAt') IS NOT json_extract(previous.value,'$.createdAt')\n OR (json_type(previous.value,'$.modelStepId') IS NOT NULL AND json_extract(NEW.data,'$.notes['||previous.key||'].modelStepId') IS NOT json_extract(previous.value,'$.modelStepId')))\n OR EXISTS(SELECT 1 FROM json_each(OLD.data,'$.skippedTargets') previous WHERE json_extract(NEW.data,'$.skippedTargets['||previous.key||'].stepId') IS NOT json_extract(previous.value,'$.stepId') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].createdAt') IS NOT json_extract(previous.value,'$.createdAt') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].target.kind') IS NOT json_extract(previous.value,'$.target.kind') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].target.id') IS NOT json_extract(previous.value,'$.target.id') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].target.revision') IS NOT json_extract(previous.value,'$.target.revision') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].target.revisionBefore') IS NOT json_extract(previous.value,'$.target.revisionBefore') OR json_extract(NEW.data,'$.skippedTargets['||previous.key||'].target.revisionAfter') IS NOT json_extract(previous.value,'$.target.revisionAfter'))\n BEGIN SELECT RAISE(ABORT,'Agent interaction evidence is immutable');END"
  }
] as readonly SchemaObject[],
});
export function withoutReviewedInteractionObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
 const names=new Set(currentOrdinary56Delta.objects.map(object=>object.name));
 assert.deepEqual(objects.filter(object=>names.has(object.name)).map(object=>({...object})),currentOrdinary56Delta.objects,'independent reviewed56 interaction SQL');
 return objects.filter(object=>!names.has(object.name));
}
/** Build genuine54 fixture bytes only when no interaction evidence exists.
 * Newer layers go first; use downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema56(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=56').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>56').get(),undefined,'newer reviewed layers are removed first');
 const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'agent_task_interaction_*' ORDER BY type,name").all() as unknown as SchemaObject[];
 assert.deepEqual(withoutReviewedInteractionObjects(objects),[]);
 assert.equal(db.prepare("SELECT count(*) AS n FROM agent_task_runs_v2 WHERE json_array_length(data,'$.notes')!=0 OR json_array_length(data,'$.skippedTargets')!=0").get()!.n,0);
 for(const object of currentOrdinary56Delta.objects)db.exec(`DROP ${object.type} "${object.name}"`);
 db.exec("UPDATE agent_task_runs_v2 SET data=json_remove(data,'$.notes','$.skippedTargets');DELETE FROM schema_version WHERE version=56");
}
