import type {DatabaseSync} from 'node:sqlite';
import {agentTaskNoteSchema,agentTaskSkippedTargetSchema,agentTaskTargetSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskRun,AgentTaskStep,AgentTaskTarget} from '../../../contracts/src/agent-tasks-v2.ts';
import {validateAgentTaskRowsV2} from './task-schema-v2.ts';
import type {AgentTaskRowValidationOptions} from './task-schema-v2.ts';

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
function invalid():never{throw Object.assign(new Error('Invalid Agent interaction evidence'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});}
const notePath=(name:string)=>`json_extract(NEW.data,'$.notes['||previous.key||'].${name}')`;
const skippedPath=(name:string)=>`json_extract(NEW.data,'$.skippedTargets['||previous.key||'].${name}')`;

/** Schema56 adds append-only interaction evidence to existing runs. Old source
 * and restored profiles never execute this installer or accept these fields. */
export function installAgentInteractionDefinitionsV2(db:DatabaseSync):void {
 db.exec("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.notes',json('[]'),'$.skippedTargets',json('[]'))");
 const required=`json_type(NEW.data,'$.notes') IS NOT 'array' OR json_type(NEW.data,'$.skippedTargets') IS NOT 'array'
 OR (SELECT count(*) FROM json_each(NEW.data,'$.notes') WHERE json_type(value,'$.modelStepId') IS NULL)>5`;
 const noteFields=['requestId','text','createdAt'].map(name=>`${notePath(name)} IS NOT json_extract(previous.value,'$.${name}')`).join(' OR ');
 const skippedFields=['stepId','createdAt','target.kind','target.id','target.revision','target.revisionBefore','target.revisionAfter'].map(name=>`${skippedPath(name)} IS NOT json_extract(previous.value,'$.${name}')`).join(' OR ');
 db.exec(`CREATE TRIGGER agent_task_interaction_insert_v2 BEFORE INSERT ON agent_task_runs_v2
 WHEN ${required}
 BEGIN SELECT RAISE(ABORT,'Agent interaction arrays are required');END;
 CREATE TRIGGER agent_task_interaction_update_v2 BEFORE UPDATE OF data ON agent_task_runs_v2
 WHEN ${required}
 OR json_array_length(NEW.data,'$.notes')<json_array_length(OLD.data,'$.notes')
 OR json_array_length(NEW.data,'$.skippedTargets')<json_array_length(OLD.data,'$.skippedTargets')
 OR EXISTS(SELECT 1 FROM json_each(OLD.data,'$.notes') previous WHERE ${noteFields}
 OR (json_type(previous.value,'$.modelStepId') IS NOT NULL AND ${notePath('modelStepId')} IS NOT json_extract(previous.value,'$.modelStepId')))
 OR EXISTS(SELECT 1 FROM json_each(OLD.data,'$.skippedTargets') previous WHERE ${skippedFields})
 BEGIN SELECT RAISE(ABORT,'Agent interaction evidence is immutable');END;`);
}

/** Preserve the old generic receipt.action format. Only actual new metadata is
 * interpreted here, including its links to the exact originating model/tool
 * steps; an old receipt merely named note/skip does not manufacture metadata. */
export function validateAgentInteractionRowsV2(db:DatabaseSync,options:Pick<AgentTaskRowValidationOptions,'allowRequestReferences'|'allowAnswers'|'maxBytes'>={}):void {
 validateAgentTaskRowsV2(db,{...options,allowConversations:true,allowInteractions:true});
 const getStep=db.prepare('SELECT data FROM agent_task_steps_v2 WHERE id=? AND runId=?');
 const step=(id:string,runId:string):AgentTaskStep=>{const row=getStep.get(id,runId);if(!row)invalid();return JSON.parse(String(row.data)) as AgentTaskStep;};
 for(const row of db.prepare('SELECT data FROM agent_task_runs_v2 LIMIT 20001').iterate()){
  const run=JSON.parse(String(row.data)) as AgentTaskRun;
  if(typeof run.conversationId!=='string'||!uuid.test(run.conversationId)||!Array.isArray(run.notes)||!Array.isArray(run.skippedTargets))invalid();
  const requests=new Set<string>(),targets=new Set<string>();let pending=0,notePosition=0;
  for(const value of run.notes){
   const parsed=agentTaskNoteSchema.safeParse(value);if(!parsed.success)invalid();const note=parsed.data;
   if(requests.has(note.requestId)||!Number.isFinite(Date.parse(note.createdAt)))invalid();requests.add(note.requestId);
   if(note.modelStepId===undefined){if(++pending>5)invalid();continue;}
   if(pending)invalid();const model=step(note.modelStepId,run.id);
   if(model.kind!=='model'||model.position<notePosition)invalid();notePosition=model.position;
  }
  for(const value of run.skippedTargets){
   const parsed=agentTaskSkippedTargetSchema.safeParse(value);if(!parsed.success)invalid();const skipped=parsed.data;
   const identity=JSON.stringify([skipped.target.kind,skipped.target.id]);if(targets.has(identity)||!Number.isFinite(Date.parse(skipped.createdAt)))invalid();targets.add(identity);
   const tool=step(skipped.stepId,run.id),data=tool.data&&typeof tool.data==='object'&&!Array.isArray(tool.data)?tool.data:{};
   const conflicts=Array.isArray(data.conflictTargets)?data.conflictTargets:[];
   const contains=(target:unknown):boolean=>Boolean(target&&typeof target==='object'&&!Array.isArray(target)&&(target as AgentTaskTarget).kind===skipped.target.kind&&(target as AgentTaskTarget).id===skipped.target.id);
   // Background work may discover a conflict after a later tool has been
   // skipped. Origin positions need not follow control acceptance order.
   if(tool.kind!=='tool'||!tool.targets?.some(contains)||!conflicts.some(value=>agentTaskTargetSchema.safeParse(value).success&&contains(value)))invalid();
  }
 }
 if(db.prepare("SELECT 1 FROM agent_task_runs_v2 GROUP BY json_extract(data,'$.conversationId') HAVING count(DISTINCT projectId)>1 OR (sum(json_type(data,'$.diagnostic') IS NOT NULL)>0 AND count(*)>1) LIMIT 1").get())invalid();
}
