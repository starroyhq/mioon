import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';

interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
/** Independently reviewed A1 additions. The ordinary52 JSON fixture and its
 * catalog hashes stay frozen; these three definitions are checked separately
 * before a historical view may exclude them. No table is added in schema54. */
export const currentOrdinary54Delta=Object.freeze({
  schemaVersionRows:[['54','integer','3534']] as const,
  objects:[
    {type:'index',name:'agent_task_conversation_v2',tbl_name:'agent_task_runs_v2',sql:"CREATE INDEX agent_task_conversation_v2 ON agent_task_runs_v2(projectId,json_extract(data,'$.conversationId'),json_extract(data,'$.createdAt'),id)"},
    {type:'trigger',name:'agent_task_conversation_identity_v2',tbl_name:'agent_task_runs_v2',sql:"CREATE TRIGGER agent_task_conversation_identity_v2 BEFORE UPDATE OF data ON agent_task_runs_v2\n WHEN json_extract(NEW.data,'$.conversationId') IS NOT json_extract(OLD.data,'$.conversationId')\n BEGIN SELECT RAISE(ABORT,'Agent conversation identity is immutable');END"},
    {type:'trigger',name:'agent_task_conversation_required_v2',tbl_name:'agent_task_runs_v2',sql:"CREATE TRIGGER agent_task_conversation_required_v2 BEFORE INSERT ON agent_task_runs_v2\n WHEN json_type(NEW.data,'$.conversationId') IS NOT 'text' OR length(json_extract(NEW.data,'$.conversationId'))!=36\n OR json_extract(NEW.data,'$.conversationId') NOT GLOB '????????-????-????-????-????????????'\n OR json_extract(NEW.data,'$.conversationId') GLOB '*[^a-fA-F0-9-]*'\n BEGIN SELECT RAISE(ABORT,'Agent conversation identity is required');END"},
  ] as readonly SchemaObject[],
});
export function withoutReviewedConversationObjects<T extends SchemaObject>(objects:readonly T[]):T[] {
  const names=new Set(currentOrdinary54Delta.objects.map(object=>object.name));
  assert.deepEqual(objects.filter(object=>names.has(object.name)).map(object=>({...object})),currentOrdinary54Delta.objects,'independent reviewed54 conversation SQL');
  return objects.filter(object=>!names.has(object.name));
}
/** A test-only downgrade requires genuine52 evidence: newer layers are gone and
 * no Agent run carries a conversation. Retained rows are never rewritten. Use
 * downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema54(db:DatabaseSync):void {
  if(!db.prepare('SELECT 1 FROM schema_version WHERE version=54').get())return;
  assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>54').get(),undefined,'newer reviewed layers are removed first');
  const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${currentOrdinary54Delta.objects.map(object=>`'${object.name}'`).join(',')}) ORDER BY type,name`).all() as unknown as SchemaObject[];
  assert.deepEqual(withoutReviewedConversationObjects(objects),[]);
  assert.equal(db.prepare("SELECT 1 FROM agent_task_runs_v2 WHERE json_type(data,'$.conversationId') IS NOT NULL LIMIT 1").get(),undefined,'conversations cannot be disguised as historical52');
  const ownsTransaction=!db.isTransaction;if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
  try{
    for(const object of currentOrdinary54Delta.objects)db.exec(`DROP ${object.type} "${object.name}"`);
    db.exec('DELETE FROM schema_version WHERE version=54');
    if(ownsTransaction)db.exec('COMMIT');
  }catch(error){if(ownsTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
