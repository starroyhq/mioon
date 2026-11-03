import {validateMioInteractionRows} from './mio-interaction-validation.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {agentTaskChangeSchema,agentTaskConversationPolicySchema,agentTaskPolicyModesSchema,agentTaskPolicySchema} from '../../../contracts/src/agent-tasks-v2.ts';
import {
 mioClaimSchema,mioConversationSchema,mioControlSchema,mioEditOwnerSchema,mioEditReceiptSchema,mioEntrySchema,mioEventSchema,
 mioIdentitySchemas,mioImportSchema,mioJsonSchema,mioModelOutputSchema,mioOriginSchema,mioRequestSchema,mioRunSchema,mioStepSchema,
} from '../../../contracts/src/mio-records.ts';
import type {MioEntry} from '../../../contracts/src/mio-records.ts';
import {mioRuleWriteSchema} from '../../../contracts/src/mio-rule-writes.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {readMioStorage} from './mio-storage.ts';

function invalid():never{throw Object.assign(new Error('Invalid Agent task record'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});}
interface Shape<T>{safeParse(value:unknown):{success:true;data:T}|{success:false}}
function parse<T>(schema:Shape<T>,value:unknown):T{const result=schema.safeParse(value);return result.success?result.data:invalid();}
function json(value:unknown,limit=2097152):unknown{
 if(typeof value!=='string'||Buffer.byteLength(value)>limit)return invalid();
 try{return parse(mioJsonSchema,JSON.parse(value));}catch{return invalid();}
}
const sha=(value:string):string=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Current native records use scalar identities and immutable canonical
 * entries instead of workspace snapshot JSON. DDL/repository writes already
 * enforce ownership, state transitions, retention and quota; this read checks
 * persisted types, content hashes, JSON references and cross-file integrity
 * again, including evidence written outside those guarded APIs. */
export function validateMioProjectRows(store:ProjectStore,application:DatabaseSync,foreignKeysValid:()=>boolean,{maxBytes}:{readonly maxBytes?:number}={}):void{
 const {db,projectId}=store;
 if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>268435456))invalid();
 if(!foreignKeysValid())invalid();
 const metadata=db.prepare('SELECT p.projectId,p.contentSequence,h.projectId AS historyProject,h.seenContentSequence FROM project.project_file p LEFT JOIN main.history_state h ON h.singleton=p.singleton').all();
 if(metadata.length!==1||metadata[0].projectId!==projectId||metadata[0].historyProject!==projectId||metadata[0].contentSequence!==metadata[0].seenContentSequence)invalid();
 // Manual-edit/revision rows may legitimately exceed execution quota. Only an
 // explicit caller bound rejects aggregate bytes; reads never repair counters.
 let inventory:ReturnType<typeof readMioStorage>;try{inventory=readMioStorage(db);}catch{return invalid();}
 if(maxBytes!==undefined&&inventory.usage.bytes>maxBytes)invalid();
 const rows=(table:string)=>db.prepare(`SELECT * FROM main.${table}`).iterate();
 const blobs=new Set<string>(),entries=new Map<string,Pick<MioEntry,'id'|'runId'|'conversationId'|'kind'>>(),modelProtocols=new Map<string,string>();
 for(const row of rows('mio_blobs')){
  parse(mioIdentitySchemas.hash,row.sha256);parse(mioIdentitySchemas.date,row.createdAt);
  if(typeof row.content!=='string'||row.bytes!==Buffer.byteLength(row.content)||sha(row.content)!==row.sha256)invalid();
  blobs.add(String(row.sha256));
 }
 for(const row of rows('mio_conversations'))parse(mioConversationSchema,row);
 for(const row of rows('mio_runs'))parse(mioRunSchema,{...row,usageSummary:row.usageSummary===null?null:json(row.usageSummary)});
 for(const row of rows('mio_entries')){
  const value=parse(mioEntrySchema,{...row,payloadJson:row.payloadJson===null?null:json(row.payloadJson)});
  if((value.payloadJson===null)===(value.payloadBlobHash===null))invalid();
  if(value.payloadBlobHash!==null&&!blobs.has(value.payloadBlobHash))invalid();
  const payload=value.payloadBlobHash===null?value.payloadJson:json(db.prepare('SELECT content FROM mio_blobs WHERE sha256=?').get(value.payloadBlobHash)?.content);
  if(value.kind==='model_output')modelProtocols.set(value.id,parse(mioModelOutputSchema,payload).protocol);
  entries.set(value.id,value);
 }
 for(const row of rows('mio_steps'))parse(mioStepSchema,{...row,data:json(row.data)});
 if(db.prepare(`SELECT 1 FROM mio_steps s LEFT JOIN mio_entries e ON e.id=s.resultEntryId
   WHERE s.resultEntryId IS NOT NULL AND (e.runId IS NOT s.runId OR
    s.kind='model' AND e.kind IS NOT 'model_output' OR s.kind='tool' AND e.kind NOT IN ('tool_result','answer')) LIMIT 1`).get())invalid();
 if(db.prepare(`SELECT 1 FROM mio_steps s LEFT JOIN mio_entries e ON e.id=s.sourceEntryId
   WHERE s.sourceEntryId IS NOT NULL AND (s.kind IS NOT 'tool' OR e.kind IS NOT 'model_output' OR e.runId IS NOT s.runId) LIMIT 1`).get())invalid();
 validateMioInteractionRows(db);
 for(const row of rows('mio_requests')){
  const value=parse(mioRequestSchema,{...row,inputManifest:json(row.inputManifest)});
  if(value.firstEntry!==(value.inputManifest.entryIds[0]??null)||value.lastEntry!==(value.inputManifest.entryIds.at(-1)??null))invalid();
  if(value.originalBody!==null&&(Buffer.byteLength(value.originalBody)!==value.bodyBytes||sha(value.originalBody)!==value.bodySha256))invalid();
  const step=db.prepare('SELECT runId,currentRequestId,status,resultEntryId FROM mio_steps WHERE id=?').get(value.stepId);
  const run=step&&db.prepare('SELECT conversationId FROM mio_runs WHERE id=?').get(step.runId!);
  if(!step||!run)invalid();
  for(const hash of [value.inputManifest.configurationBlobHash,value.inputManifest.toolsBlobHash,value.inputManifest.systemBlobHash,value.inputManifest.baselineBlobHash,value.inputManifest.rulesBlobHash])if(hash!==null&&!blobs.has(hash))invalid();
  for(const id of value.inputManifest.entryIds)if(entries.get(id)?.conversationId!==run.conversationId)invalid();
  for(const id of value.inputManifest.noteEntryIds){const entry=entries.get(id);if(entry?.kind!=='note'||entry.runId!==step.runId)invalid();}
  if(['dispatch_started','completed','unknown'].includes(value.state)&&value.dispatchStartedAt===null)invalid();
  if(value.state==='completed'&&(value.originalBody!==null||value.completedAt===null||step.currentRequestId!==value.id||step.status!=='completed'||typeof step.resultEntryId!=='string'||modelProtocols.get(step.resultEntryId)!==value.protocol))invalid();
  if(value.originalBody===null&&value.state!=='completed'&&!(value.state==='superseded'&&step.status==='completed'))invalid();
  if(value.previousRequestId===null){if(value.assemblyNumber!==1)invalid();}
  else{const previous=db.prepare('SELECT assemblyNumber,state FROM mio_requests WHERE id=? AND stepId=?').get(value.previousRequestId,value.stepId);if(previous?.state!=='superseded'||Number(previous.assemblyNumber)+1!==value.assemblyNumber)invalid();}
 }
 for(const row of rows('mio_changes')){
  const value=parse(agentTaskChangeSchema,json(row.data));
  if(Object.hasOwn(value,'display')||Object.hasOwn(value,'modifiedAfter')||Object.hasOwn(value,'undoDisposition'))invalid();
  for(const key of ['id','runId','stepId','projectId'] as const)if(row[key]!==value[key])invalid();
 }
 for(const row of rows('mio_controls'))parse(mioControlSchema,{...row,data:json(row.data)});
 for(const row of rows('mio_control_states')){parse(mioIdentitySchemas.requestId,row.requestId);parse(mioIdentitySchemas.id,row.runId);parse(mioIdentitySchemas.id,row.projectId);json(row.data);}
 for(const row of rows('mio_imports'))parse(mioImportSchema,row);
 for(const row of rows('mio_job_origins'))parse(mioOriginSchema,row);
 for(const row of rows('mio_edit_claims'))parse(mioClaimSchema,row);
 for(const row of rows('mio_edit_owners'))parse(mioEditOwnerSchema,row);
 for(const row of rows('mio_edit_receipts')){const {projectId:_projectId,...value}=row;parse(mioEditReceiptSchema,{...value,data:json(row.data,65536)});}
 for(const table of ['mio_conversation_policies','mio_conversation_policy_requests'])for(const row of rows(table)){
  const value=table==='mio_conversation_policies'?json(row.data):parse(agentTaskConversationPolicySchema,json(row.response));
  if(!object(value))invalid();
  if(table==='mio_conversation_policies'){
   if(Object.keys(value).length!==5||Object.keys(value).some(key=>!['projectId','conversationId','revision','modes','updatedAt'].includes(key)))invalid();
   parse(mioIdentitySchemas.date,value.updatedAt);if(value.modes!==null)parse(agentTaskPolicyModesSchema,value.modes);
  }
  if(value.projectId!==row.projectId||value.conversationId!==row.conversationId||value.revision!==row.revision)invalid();
  if(table==='mio_conversation_policy_requests'){parse(mioIdentitySchemas.requestId,row.requestId);parse(mioIdentitySchemas.hash,row.inputHash);}
 }
 for(const row of rows('mio_events'))parse(mioEventSchema,row);
 for(const row of rows('mio_rule_writes')){
  if(row.expectedExists!==0&&row.expectedExists!==1)invalid();
  const value=parse(mioRuleWriteSchema,{...row,expectedExists:row.expectedExists===1,fileIdentity:row.fileIdentity===null?null:json(row.fileIdentity,16384)});
  if(!blobs.has(value.afterBlobHash)||value.beforeBlobHash!==null&&!blobs.has(value.beforeBlobHash))invalid();
  if(value.actor==='mio'&&!db.prepare("SELECT 1 FROM mio_steps WHERE id=? AND projectId=? AND runId=? AND kind='tool'").get(value.stepId,value.projectId,value.runId))invalid();
 }
 for(const table of ['project.agent_task_target_revisions_v2','main.mio_process_target_revisions'])if(db.prepare(`SELECT 1 FROM ${table} WHERE typeof(revision)!='integer' OR revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1`).get())throw Object.assign(new Error('Invalid Agent target revision'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 if(db.prepare("SELECT 1 FROM mio_process_target_revisions WHERE kind NOT IN ('job','export','image_task','frame_task') LIMIT 1").get())invalid();
 for(const table of ['agent_task_policy_v2','agent_task_policy_requests_v2'])for(const row of application.prepare(`SELECT * FROM ${table}`).iterate()){
  parse(agentTaskPolicySchema,json(row.data,65536));
  if(table==='agent_task_policy_v2'){if(row.id!==1)invalid();}
  else{if(typeof row.requestId!=='string'||row.requestId.length<1||row.requestId.length>200)invalid();parse(mioIdentitySchemas.hash,row.digest);}
 }
}
