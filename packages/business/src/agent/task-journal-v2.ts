import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {WorkspaceStore} from '../db.ts';
import {readCurrentWorkspaceRole} from '../workspace-schema-dispatch.ts';
import {referenceAgentTaskEventRequest,hydrateAgentTaskEventRequest,AGENT_TASK_EVENT_PAGE_BYTES} from './task-model-requests-v2.ts';
import type {AgentTaskRequestCache} from './task-model-requests-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY,agentTaskPolicySchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskRun,AgentTaskStep,AgentTaskChange,AgentTaskEvent,AgentTaskSnapshot,AgentTaskStatus,AgentTaskStepStatus,AgentTaskJson,AgentTaskReceipt,AgentTaskPolicy,AgentTaskTarget,AgentTaskClaim,AgentTaskEditingInput,AgentTaskDiagnostic,AgentTaskConversation,AgentTaskConversationPage,AgentTaskHistoryPage,AgentTaskNote,AgentTaskSkippedTarget} from '../../../contracts/src/agent-tasks-v2.ts';

function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const encode=(value:unknown):string=>{const data=JSON.stringify(value);if(!data||Buffer.byteLength(data)>2*1024*1024)fail('AGENT_TASK_STORAGE_LIMIT');return data;};
const decode=<T>(value:unknown):T=>JSON.parse(String(value)) as T;
const digest=(value:unknown):string=>createHash('sha256').update(encode(value)).digest('hex');
const now=():string=>new Date().toISOString();
export type AgentTaskChangeInput=Omit<AgentTaskChange,'id'|'runId'|'stepId'|'createdAt'|'status'|'modifiedAfter'|'undoDisposition'>;
export interface AgentTaskStepInput extends Pick<AgentTaskStep,'kind'> {request?:AgentTaskJson;data?:AgentTaskJson;toolCall?:AgentTaskStep['toolCall'];targets?:AgentTaskTarget[];tier?:AgentTaskStep['tier']}
export interface AgentTaskControlRecord {requestId:string;runId:string;expectedRevision:number;action:string;stepId?:string;changeId?:string;resolution?:string;text?:string;undoChangeIds?:string[]}
export function createAgentTaskJournal(store:WorkspaceStore){
 const {db}=store;
 const role=readCurrentWorkspaceRole(db),requestReferences=role==='ordinary-60'||role==='restored-61-evidence'||role==='storage-private-58'||role==='storage-private-59-evidence';
 const transact=<T>(fn:()=>T):T=>db.isTransaction?fn():store.tx(fn);
 const inside=():void=>{if(!db.isTransaction)fail('AGENT_TASK_TRANSACTION_REQUIRED');};
 const run=(id:string):AgentTaskRun=>{const row=db.prepare('SELECT data FROM agent_task_runs_v2 WHERE id=?').get(id);if(!row)fail('AGENT_TASK_NOT_FOUND');return decode<AgentTaskRun>(row.data);};
 const step=(id:string):AgentTaskStep=>{const row=db.prepare('SELECT data FROM agent_task_steps_v2 WHERE id=?').get(id);if(!row)fail('AGENT_TASK_NOT_FOUND');return decode<AgentTaskStep>(row.data);};
 const saveRun=(value:AgentTaskRun):void=>{db.prepare('UPDATE agent_task_runs_v2 SET status=?,revision=?,data=? WHERE id=?').run(value.status,value.revision,encode(value),value.id);};
 const saveStep=(value:AgentTaskStep):void=>{db.prepare('UPDATE agent_task_steps_v2 SET status=?,data=? WHERE id=?').run(value.status,encode(value),value.id);};
 const appendEventInside=(runId:string,type:string,data:AgentTaskJson):AgentTaskEvent=>{inside();const sequence=Number(db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM agent_task_events_v2 WHERE runId=?').get(runId)!.value),projectId=run(runId).projectId;const event={runId,sequence,type,data,createdAt:now()},saved=requestReferences?referenceAgentTaskEventRequest(db,event,projectId):event;db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(runId,projectId,sequence,type,encode(saved));return event;};
 const touch=(value:AgentTaskRun):void=>{if(value.revision>=Number.MAX_SAFE_INTEGER)fail('AGENT_TASK_REVISION_LIMIT');value.revision++;value.updatedAt=new Date(Math.max(Date.now(),Date.parse(value.updatedAt),Date.parse(value.createdAt))).toISOString();saveRun(value);};
 const events=(runId:string,after=0):AgentTaskEvent[]=>{
  const result:AgentTaskEvent[]=[],cache:AgentTaskRequestCache=new Map(),projectId=run(runId).projectId;let bytes=0;
  for(const row of db.prepare('SELECT runId,projectId,sequence,type,data FROM agent_task_events_v2 WHERE runId=? AND sequence>? ORDER BY sequence LIMIT 2000').iterate(runId,after)){
   const saved=decode<AgentTaskEvent>(row.data);
   if(row.projectId!==projectId||saved.runId!==row.runId||saved.sequence!==row.sequence||saved.type!==row.type)fail('AGENT_TASK_STORAGE_CORRUPT');
   const event=hydrateAgentTaskEventRequest(db,saved,projectId,{allowReferences:requestReferences,cache}),size=Buffer.byteLength(encode(event));
   if(result.length&&bytes+size>AGENT_TASK_EVENT_PAGE_BYTES)break;
   result.push(event);bytes+=size;
  }
  return result;
 };
 // SSE observes sequence numbers and a safe snapshot; it need not expand
 // private historical requests merely to signal that progress changed.
 const eventSequence=(runId:string,after=0):number=>Number(db.prepare('SELECT max(sequence) AS sequence FROM (SELECT sequence FROM agent_task_events_v2 WHERE runId=? AND sequence>? ORDER BY sequence LIMIT 2000)').get(runId,after)?.sequence??after);
 // Storyboard tasks exist from schema58; older restored copies have no table to join.
 const sceneTasks=():boolean=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scene_tasks'").get());
 const pendingBackgroundSql=(runExpression:string):string=>{const scenes=sceneTasks();return `SELECT 1 FROM agent_task_job_origins_v2 b
 LEFT JOIN jobs j ON b.kind='job' AND j.id=b.jobId AND j.projectId=b.projectId
 LEFT JOIN exports e ON b.kind='export' AND e.id=b.jobId AND e.projectId=b.projectId
 LEFT JOIN image_tasks i ON b.kind='image' AND i.id=b.jobId AND i.projectId=b.projectId
 LEFT JOIN frame_tasks f ON b.kind='frame' AND f.id=b.jobId AND f.projectId=b.projectId
 ${scenes?"LEFT JOIN scene_tasks s ON b.kind='scene' AND s.id=b.jobId AND s.projectId=b.projectId":''}
 WHERE b.runId=${runExpression} AND CASE b.kind
 WHEN 'job' THEN COALESCE(CASE WHEN json_valid(j.data) THEN json_extract(j.data,'$.status') END,'unknown') NOT IN ('succeeded','failed','cancelled')
 WHEN 'export' THEN COALESCE(CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.status') END,'unknown') NOT IN ('succeeded','failed','cancelled')
 WHEN 'image' THEN COALESCE(i.state,'unknown') NOT IN ('succeeded','failed','cancelled_before_dispatch')
 WHEN 'frame' THEN COALESCE(f.state,'unknown') NOT IN ('succeeded','failed','cancelled_before_start')
 ${scenes?"WHEN 'scene' THEN COALESCE(s.state,'unknown') NOT IN ('succeeded','undone','failed','local_result_error','interrupted','cancelled','cancelled_before_start')":''} ELSE 1 END`;};
 const hasPendingBackground=(runId:string):boolean=>Boolean(db.prepare(pendingBackgroundSql('?')+' LIMIT 1').get(runId));
 function executionEndedAt(value:AgentTaskRun):string|undefined {
  if(!['completed','failed','stopped','reverted'].includes(value.status))return;
  // Undo touches history recency but cannot extend execution time. Read the
  // latest execution segment's run event directly, beyond the paged event API;
  // missing terminal evidence must not fall back to an older completed segment.
  const saved=db.prepare("SELECT json_extract(data,'$.data.id') AS id,json_extract(data,'$.data.projectId') AS projectId,json_extract(data,'$.data.status') AS status,json_extract(data,'$.data.updatedAt') AS updatedAt FROM agent_task_events_v2 WHERE runId=? AND type='run' AND json_extract(data,'$.data.status') IS NOT 'reverted' ORDER BY sequence DESC LIMIT 1").get(value.id);
  if(!saved||saved.id!==value.id||saved.projectId!==value.projectId||!['completed','failed','stopped'].includes(String(saved.status))||value.status!=='reverted'&&saved.status!==value.status||typeof saved.updatedAt!=='string')return;
  const end=Date.parse(saved.updatedAt),start=Date.parse(value.createdAt),updated=Date.parse(value.updatedAt);
  if(Number.isFinite(end)&&Number.isFinite(start)&&Number.isFinite(updated)&&end>=start&&end<=updated&&new Date(end).toISOString()===saved.updatedAt)return saved.updatedAt;
 }
 const snapshot=(runId:string):AgentTaskSnapshot=>{const value=run(runId),ended=executionEndedAt(value);return {backgroundPending:hasPendingBackground(runId),run:value,steps:db.prepare('SELECT data FROM agent_task_steps_v2 WHERE runId=? ORDER BY position').all(runId).map(row=>decode<AgentTaskStep>(row.data)),changes:db.prepare('SELECT data FROM agent_task_changes_v2 WHERE runId=? ORDER BY rowid').all(runId).map(row=>decode<AgentTaskChange>(row.data)),...(ended?{executionEndedAt:ended}:{})};};
 const policy=():AgentTaskPolicy=>{const row=db.prepare('SELECT data FROM agent_task_policy_v2 WHERE id=1').get();return row?agentTaskPolicySchema.parse(decode<unknown>(row.data)):structuredClone(DEFAULT_AGENT_TASK_POLICY);};
 function create(input:{requestId:string;projectId:string;conversationId?:string;text:string;configuration:AgentTaskJson;settingsRevision?:number;context?:AgentTaskJson[];attachments?:string[];policy?:AgentTaskPolicy;diagnostic?:AgentTaskDiagnostic}):AgentTaskSnapshot{return transact(()=>{
  const hash=digest({projectId:input.projectId,conversationId:input.conversationId,text:input.text,configuration:input.configuration,settingsRevision:input.settingsRevision,context:input.context,attachments:input.attachments,...(input.diagnostic?{diagnostic:input.diagnostic}:{})});const old=db.prepare('SELECT id,digest FROM agent_task_runs_v2 WHERE requestId=?').get(input.requestId);
  if(old){if(old.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');return snapshot(String(old.id));}
  if(!store.get('projects',input.projectId))fail('PROJECT_NOT_FOUND');
  if(input.conversationId!==undefined){if(input.diagnostic)fail('AGENT_TASK_INVALID');conversationSummary(input.projectId,input.conversationId);}
  if(db.prepare("SELECT 1 FROM agent_task_runs_v2 WHERE projectId=? AND status IN ('running','paused','awaiting_approval','interrupted') LIMIT 1").get(input.projectId))fail('AGENT_TASK_BUSY');
  const selected=input.policy??policy(),date=conversationDate(input.projectId,input.conversationId);const value:AgentTaskRun={id:randomUUID(),projectId:input.projectId,conversationId:input.conversationId??randomUUID(),requestId:input.requestId,text:input.text,notes:[],skippedTargets:[],configuration:input.configuration,...(input.settingsRevision!==undefined?{settingsRevision:input.settingsRevision}:{}),...(input.context?{context:input.context}:{}),...(input.attachments?{attachments:input.attachments}:{}),...(input.diagnostic?{diagnostic:input.diagnostic}:{}),status:'running',revision:1,stepLimit:selected.stepLimit,budget:selected.stepLimit,stepsUsed:0,createdAt:date,updatedAt:date};
  db.prepare('INSERT INTO agent_task_runs_v2(id,projectId,requestId,digest,status,revision,data) VALUES(?,?,?,?,?,?,?)').run(value.id,value.projectId,value.requestId,hash,value.status,value.revision,encode(value));appendEventInside(value.id,'run',value as unknown as AgentTaskJson);return snapshot(value.id);
 });}
 const conversationIdentity="COALESCE(json_extract(data,'$.conversationId'),id)";
 const visibleRuns="json_type(data,'$.diagnostic') IS NULL";
 /** Persist logical ordering in the existing timestamp: UUID order and SQLite
  * rowids cannot represent send order after clock rollback or a copied restore. */
 function conversationDate(projectId:string,conversationId?:string):string {
  if(!conversationId)return now();
  const previous=db.prepare(`SELECT max(max(json_extract(data,'$.createdAt'),json_extract(data,'$.updatedAt'))) AS latest FROM agent_task_runs_v2 WHERE projectId=? AND ${visibleRuns} AND ${conversationIdentity}=?`).get(projectId,conversationId)?.latest;
  const timestamp=Math.max(Date.now(),typeof previous==='string'?Date.parse(previous)+1:0);
  if(!Number.isFinite(timestamp)||timestamp>253402300799999)fail('AGENT_TASK_STORAGE_LIMIT');
  return new Date(timestamp).toISOString();
 }
 function validPage(limit:number):void {if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('AGENT_TASK_INVALID');}
 function pageCursor(cursor:string|undefined,scope:string[]):string[]|undefined {
  if(cursor===undefined)return;
  if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/u.test(cursor))fail('AGENT_TASK_INVALID');let decoded:unknown;
  try{decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('AGENT_TASK_INVALID');}
  if(!Array.isArray(decoded)||decoded.length!==scope.length+2||scope.some((part,index)=>decoded[index]!==part)||typeof decoded.at(-2)!=='string'||!Number.isFinite(Date.parse(decoded.at(-2)))||typeof decoded.at(-1)!=='string'||!/^[a-f0-9-]{36}$/iu.test(decoded.at(-1)))fail('AGENT_TASK_INVALID');
  return decoded as string[];
 }
 function conversationTitle(text:string):string {
  const normalized=text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/gu,' ').trim();let title='';
  for(const character of normalized){if(title.length+character.length>120)break;title+=character;}return title||'…';
 }
 function conversationSummary(projectId:string,conversationId:string):AgentTaskConversation {
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(conversationId))fail('AGENT_TASK_INVALID');
  const where=`projectId=? AND ${visibleRuns} AND ${conversationIdentity}=?`;
  const first=db.prepare(`SELECT data FROM agent_task_runs_v2 WHERE ${where} ORDER BY json_extract(data,'$.createdAt'),id LIMIT 1`).get(projectId,conversationId);if(!first)fail('AGENT_TASK_NOT_FOUND');
  const initial=decode<AgentTaskRun>(first.data),last=decode<AgentTaskRun>(db.prepare(`SELECT data FROM agent_task_runs_v2 WHERE ${where} ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 1`).get(projectId,conversationId)!.data);
  const aggregate=db.prepare(`SELECT max(json_extract(data,'$.updatedAt')) AS updatedAt,count(*) AS runCount FROM agent_task_runs_v2 WHERE ${where}`).get(projectId,conversationId)!;
  const changes=db.prepare(`SELECT count(*) AS n FROM agent_task_changes_v2 c JOIN agent_task_runs_v2 r ON r.id=c.runId WHERE r.projectId=? AND json_type(r.data,'$.diagnostic') IS NULL AND COALESCE(json_extract(r.data,'$.conversationId'),r.id)=?`).get(projectId,conversationId)!;
  return {id:conversationId,projectId,title:conversationTitle(initial.text),createdAt:initial.createdAt,updatedAt:String(aggregate.updatedAt),lastRunId:last.id,lastRunStatus:last.status,changeCount:Number(changes.n),runCount:Number(aggregate.runCount)};
 }
 function history(projectId:string,{cursor,limit=50}:{cursor?:string;limit?:number}={}):AgentTaskHistoryPage {
  validPage(limit);const before=pageCursor(cursor,[projectId]),date=before?.at(-2),id=before?.at(-1);
  const having=before?' HAVING (updatedAt<? OR (updatedAt=? AND conversationId<?))':'';
  const rows=db.prepare(`SELECT ${conversationIdentity} AS conversationId,max(json_extract(data,'$.updatedAt')) AS updatedAt FROM agent_task_runs_v2 WHERE projectId=? AND ${visibleRuns} GROUP BY ${conversationIdentity}${having} ORDER BY updatedAt DESC,conversationId DESC LIMIT ?`).all(...(before?[projectId,date!,date!,id!,limit+1]:[projectId,limit+1]));
  const selected=rows.slice(0,limit),last=selected.at(-1);
  return {conversations:selected.map(row=>conversationSummary(projectId,String(row.conversationId))),nextCursor:rows.length>limit&&last?Buffer.from(encode([projectId,last.updatedAt,last.conversationId])).toString('base64url'):null};
 }
 function conversation(projectId:string,conversationId:string,{cursor,limit=50}:{cursor?:string;limit?:number}={}):AgentTaskConversationPage {
  validPage(limit);const summary=conversationSummary(projectId,conversationId),after=pageCursor(cursor,[projectId,conversationId]),date=after?.at(-2),id=after?.at(-1);
  const where=after?" AND (json_extract(data,'$.createdAt')>? OR (json_extract(data,'$.createdAt')=? AND id>?))":'';
  const rows=db.prepare(`SELECT data FROM agent_task_runs_v2 WHERE projectId=? AND ${visibleRuns} AND ${conversationIdentity}=?${where} ORDER BY json_extract(data,'$.createdAt'),id LIMIT ?`).all(...(after?[projectId,conversationId,date!,date!,id!,limit+1]:[projectId,conversationId,limit+1])).map(row=>decode<AgentTaskRun>(row.data));
  const runs=rows.slice(0,limit),last=runs.at(-1);return {conversation:summary,runs,nextCursor:rows.length>limit&&last?Buffer.from(encode([projectId,conversationId,last.createdAt,last.id])).toString('base64url'):null};
 }
 /** A continuation can only reference a conversation already owned before its
  * INSERT. The original first run therefore records an omitted input without
  * adding private request metadata to the public run or rewriting old digests. */
 function requestConversationId(runId:string):string|undefined {
  const value=run(runId);if(!value.conversationId)return;
  return db.prepare(`SELECT 1 FROM agent_task_runs_v2 WHERE projectId=? AND ${visibleRuns} AND ${conversationIdentity}=? AND json_extract(data,'$.createdAt')<? LIMIT 1`).get(value.projectId,value.conversationId,value.createdAt)?value.conversationId:undefined;
 }
 function contextRuns(projectId:string,conversationId:string):AgentTaskRun[] {
  conversationSummary(projectId,conversationId);
  return db.prepare(`SELECT data FROM agent_task_runs_v2 WHERE projectId=? AND status='completed' AND ${visibleRuns} AND ${conversationIdentity}=? ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 4`).all(projectId,conversationId).map(row=>decode<AgentTaskRun>(row.data));
 }
 function transition(runId:string,expectedRevision:number,status:AgentTaskStatus,reason?:string):AgentTaskRun{return transact(()=>{const value=run(runId);if(value.revision!==expectedRevision)fail('AGENT_TASK_REVISION_CONFLICT');const allowed:Record<AgentTaskStatus,AgentTaskStatus[]>={accepted:['running','stopped','failed','interrupted'],running:['paused','awaiting_approval','completed','failed','stopped','interrupted'],paused:['running','stopped','failed','interrupted'],awaiting_approval:['running','paused','stopped','failed','interrupted'],interrupted:['running','stopped','failed'],completed:['reverted'],failed:['running','reverted'],stopped:['reverted'],reverted:[]};if(value.status!==status&&!allowed[value.status].includes(status)&&!(value.status==='completed'&&['paused','awaiting_approval','stopped','interrupted'].includes(status)&&hasPendingBackground(runId)))fail('AGENT_TASK_STATE_CONFLICT');value.status=status;if(reason)value.pauseReason=reason;else delete value.pauseReason;touch(value);appendEventInside(runId,'run',value as unknown as AgentTaskJson);return value;});}
 function beginStep(runId:string,input:AgentTaskStepInput):AgentTaskStep{return transact(()=>{const value=run(runId);if(value.status!=='running')fail('AGENT_TASK_STATE_CONFLICT');if(input.kind!=='wait'&&value.stepsUsed>=value.budget)fail('AGENT_TASK_BUDGET_EXHAUSTED');const date=now();const item:AgentTaskStep={...input,id:randomUUID(),runId,position:Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS value FROM agent_task_steps_v2 WHERE runId=?').get(runId)!.value),status:'intent',createdAt:date,updatedAt:date};db.prepare('INSERT INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(item.id,runId,value.projectId,item.position,item.status,encode(item));if(item.kind!=='wait')value.stepsUsed++;touch(value);appendEventInside(runId,'step',item as unknown as AgentTaskJson);return item;});}
 /** The exact request and its queued user notes become durable together. A
  * later note cannot rewrite this intent, even if submission is prevented. */
 function beginModelStep(runId:string,input:Omit<AgentTaskStepInput,'kind'>,noteRequestIds:string[]):AgentTaskStep{return transact(()=>{
  const value=run(runId),pending=(value.notes??[]).filter(note=>note.modelStepId===undefined);
  if(encode(pending.map(note=>note.requestId))!==encode(noteRequestIds))fail('AGENT_TASK_REVISION_CONFLICT');
  const item=beginStep(runId,{...input,kind:'model'});
  if(pending.length){const current=run(runId);for(const note of current.notes??[])if(noteRequestIds.includes(note.requestId))note.modelStepId=item.id;touch(current);appendEventInside(runId,'notes_bound',{modelStepId:item.id,requestIds:noteRequestIds});}
  return item;
 });}
 function appendNoteInside(runId:string,requestId:string,text:string):AgentTaskNote {
  inside();const value=run(runId);if(!['running','awaiting_approval','paused'].includes(value.status))fail('AGENT_TASK_STATE_CONFLICT');
  const notes=value.notes??[];if(notes.filter(note=>note.modelStepId===undefined).length>=5)fail('AGENT_TASK_NOTE_LIMIT');
  if(notes.some(note=>note.requestId===requestId))fail('AGENT_TASK_REQUEST_CONFLICT');
  const note:AgentTaskNote={requestId,text,createdAt:new Date(Math.max(Date.now(),Date.parse(value.createdAt),Date.parse(value.updatedAt))).toISOString()};value.notes=[...notes,note];touch(value);appendEventInside(runId,'note',note as unknown as AgentTaskJson);return note;
 }
 function skipTargetsInside(runId:string,targets:{stepId:string;target:AgentTaskTarget}[]):AgentTaskSkippedTarget[] {
  inside();const value=run(runId),saved=value.skippedTargets??[],seen=new Set(saved.map(item=>encode([item.target.kind,item.target.id]))),added:AgentTaskSkippedTarget[]=[];
  for(const entry of targets){const identity=encode([entry.target.kind,entry.target.id]);if(seen.has(identity))continue;const source=step(entry.stepId);if(source.runId!==runId||source.kind!=='tool')fail('AGENT_TASK_INVALID');seen.add(identity);added.push({target:structuredClone(entry.target),stepId:entry.stepId,createdAt:new Date(Math.max(Date.now(),Date.parse(value.createdAt),Date.parse(value.updatedAt))).toISOString()});}
  if(!added.length)fail('AGENT_TASK_INVALID');value.skippedTargets=[...saved,...added];touch(value);appendEventInside(runId,'skipped_targets',added as unknown as AgentTaskJson);return added;
 }
 function updateStep(runId:string,stepId:string,patch:Partial<Pick<AgentTaskStep,'status'|'request'|'data'|'result'|'error'|'cost'|'targets'|'tier'>>):AgentTaskStep{return transact(()=>{
  const value=run(runId),item=step(stepId);if(item.runId!==runId)fail('AGENT_TASK_NOT_FOUND');
  const allowed:Record<AgentTaskStepStatus,AgentTaskStepStatus[]>={intent:['awaiting_approval','dispatch_started','completed','denied','rejected','failed'],awaiting_approval:['intent','denied','rejected','failed'],dispatch_started:['completed','failed','unknown'],unknown:['completed','failed'],completed:[],denied:[],rejected:[],failed:[]};
  if(patch.status&&patch.status!==item.status&&!allowed[item.status].includes(patch.status))fail('AGENT_TASK_STATE_CONFLICT');
  const changes={...patch};
  if(requestReferences&&item.kind==='model'&&Object.hasOwn(item,'request')&&Object.hasOwn(changes,'request')){
   if(!isDeepStrictEqual(item.request,changes.request))fail('AGENT_TASK_REQUEST_IMMUTABLE');
   delete changes.request;
  }
  Object.assign(item,changes,{updatedAt:now()});saveStep(item);touch(value);appendEventInside(runId,'step',item as unknown as AgentTaskJson);return item;
 });}
 function dispatchPrevented(runId:string,stepId:string,next:'intent'|'awaiting_approval'):AgentTaskStep{return transact(()=>{const value=run(runId),item=step(stepId);if(item.runId!==runId)fail('AGENT_TASK_NOT_FOUND');if(item.status!=='dispatch_started')fail('AGENT_TASK_STATE_CONFLICT');item.status=next;item.updatedAt=now();item.data={...(item.data&&typeof item.data==='object'&&!Array.isArray(item.data)?item.data:{}),dispatchPrevented:true};saveStep(item);touch(value);appendEventInside(runId,'dispatch_prevented',{stepId,next});appendEventInside(runId,'step',item as unknown as AgentTaskJson);return item;});}
 function completeStepInside(runId:string,stepId:string,input:{result?:AgentTaskJson;change?:AgentTaskChangeInput;changes?:AgentTaskChangeInput[]}={}):AgentTaskStep{inside();const value=run(runId),item=step(stepId);if(item.runId!==runId)fail('AGENT_TASK_NOT_FOUND');if(item.status==='completed')return item;if(item.status!=='dispatch_started'&&!(item.status==='intent'&&(item.kind==='model'||item.kind==='wait')))fail('AGENT_TASK_STATE_CONFLICT');
  for(const change of [...(input.change?[input.change]:[]),...(input.changes??[])]){const record:AgentTaskChange={...change,id:randomUUID(),runId,stepId,status:'applied',createdAt:now()};if(record.projectId!==value.projectId)fail('AGENT_TASK_PROJECT_MISMATCH');db.prepare('INSERT INTO agent_task_changes_v2(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(record.id,runId,stepId,value.projectId,encode(record));appendEventInside(runId,'change',record as unknown as AgentTaskJson);}
  if(input.result!==undefined)item.result=input.result;item.status='completed';item.updatedAt=now();saveStep(item);touch(value);appendEventInside(runId,'step',item as unknown as AgentTaskJson);return item;
 }
 function appendChangesInside(runId:string,stepId:string,changes:AgentTaskChangeInput[]):AgentTaskChange[]{inside();const value=run(runId),item=step(stepId);if(item.runId!==runId)fail('AGENT_TASK_NOT_FOUND');const added:AgentTaskChange[]=[];for(const change of changes){if(change.projectId!==value.projectId)fail('AGENT_TASK_PROJECT_MISMATCH');const record:AgentTaskChange={...change,id:randomUUID(),runId,stepId,status:'applied',createdAt:now()};db.prepare('INSERT INTO agent_task_changes_v2(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(record.id,runId,stepId,value.projectId,encode(record));appendEventInside(runId,'change',record as unknown as AgentTaskJson);added.push(record);}if(added.length)touch(value);return added;}
 function control(input:AgentTaskControlRecord,result:AgentTaskJson=null):AgentTaskReceipt{return transact(()=>{const hash=digest(input),old=db.prepare('SELECT digest,data FROM agent_task_controls_v2 WHERE requestId=?').get(input.requestId);if(old){if(old.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');return decode<AgentTaskReceipt>(old.data);}const value=run(input.runId);if(value.revision!==input.expectedRevision)fail('AGENT_TASK_REVISION_CONFLICT');const receipt:AgentTaskReceipt={requestId:input.requestId,runId:input.runId,action:input.action,revision:value.revision,result};db.prepare('INSERT INTO agent_task_controls_v2(requestId,runId,projectId,digest,data) VALUES(?,?,?,?,?)').run(input.requestId,input.runId,value.projectId,hash,encode(receipt));return receipt;});}
 function performControl(input:AgentTaskControlRecord,apply:()=>AgentTaskJson):AgentTaskReceipt{return transact(()=>{const hash=digest(input),old=db.prepare('SELECT digest,data FROM agent_task_controls_v2 WHERE requestId=?').get(input.requestId);if(old){if(old.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');return decode<AgentTaskReceipt>(old.data);}const before=run(input.runId);if(before.revision!==input.expectedRevision)fail('AGENT_TASK_REVISION_CONFLICT');const result=apply(),value=run(input.runId);const receipt:AgentTaskReceipt={requestId:input.requestId,runId:input.runId,action:input.action,revision:value.revision,result};db.prepare('INSERT INTO agent_task_controls_v2(requestId,runId,projectId,digest,data) VALUES(?,?,?,?,?)').run(input.requestId,input.runId,value.projectId,hash,encode(receipt));return receipt;});}
 function rejectControl(input:AgentTaskControlRecord,failureCode:string):AgentTaskReceipt{return transact(()=>{
 if(!/^[A-Z0-9_]{1,100}$/u.test(failureCode))fail('AGENT_TASK_INVALID');const hash=digest(input),old=db.prepare('SELECT digest FROM agent_task_controls_v2 WHERE requestId=?').get(input.requestId);
 if(old){if(old.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');const saved=lookupControl(input.requestId);if(!saved)fail('AGENT_TASK_NOT_FOUND');return saved;}
 const value=run(input.runId),receipt:AgentTaskReceipt={requestId:input.requestId,runId:input.runId,action:input.action,revision:value.revision,result:{state:'rejected',code:failureCode}};
 db.prepare('INSERT INTO agent_task_controls_v2(requestId,runId,projectId,digest,data) VALUES(?,?,?,?,?)').run(input.requestId,input.runId,value.projectId,hash,encode(receipt));appendEventInside(input.runId,'control',receipt as unknown as AgentTaskJson);return receipt;
 });}
 function lookupControl(requestId:string):AgentTaskReceipt|null{const row=db.prepare('SELECT COALESCE(s.data,c.data) AS data FROM agent_task_controls_v2 c LEFT JOIN agent_task_control_states_v2 s ON s.requestId=c.requestId WHERE c.requestId=?').get(requestId);return row?decode<AgentTaskReceipt>(row.data):null;}
 function beginControl(input:AgentTaskControlRecord):AgentTaskReceipt{const old=lookupControl(input.requestId);if(old){const saved=db.prepare('SELECT digest FROM agent_task_controls_v2 WHERE requestId=?').get(input.requestId);if(saved?.digest!==digest(input))fail('AGENT_TASK_REQUEST_CONFLICT');return old;}return control(input,{state:'pending'});}
 function finishControl(requestId:string,result:AgentTaskJson):AgentTaskReceipt{return transact(()=>{const receipt=lookupControl(requestId);if(!receipt)fail('AGENT_TASK_NOT_FOUND');const value=run(receipt.runId);receipt.revision=value.revision;receipt.result=result;db.prepare('INSERT INTO agent_task_control_states_v2(requestId,runId,projectId,data) VALUES(?,?,?,?) ON CONFLICT(requestId) DO UPDATE SET data=excluded.data').run(requestId,receipt.runId,value.projectId,encode(receipt));appendEventInside(receipt.runId,'control',receipt as unknown as AgentTaskJson);return receipt;});}
 // Approval resumes an already counted intent. Only an explicit continuation
 // authorizes a new round, using this Run's fixed step limit.
 function resume(runId:string,expectedRevision:number,{extendBudget=false}:{extendBudget?:boolean}={}):AgentTaskRun{return transact(()=>{const value=run(runId);if(value.revision!==expectedRevision)fail('AGENT_TASK_REVISION_CONFLICT');if(!['paused','awaiting_approval','interrupted'].includes(value.status))fail('AGENT_TASK_STATE_CONFLICT');if(db.prepare("SELECT 1 FROM agent_task_steps_v2 WHERE runId=? AND status IN ('dispatch_started','unknown') LIMIT 1").get(runId))fail('AGENT_TASK_UNKNOWN_RESULT');if(extendBudget&&value.stepsUsed>=value.budget){if(!Number.isSafeInteger(value.budget+value.stepLimit))fail('AGENT_TASK_BUDGET_LIMIT');value.budget+=value.stepLimit;}value.status='running';delete value.pauseReason;touch(value);appendEventInside(runId,'run',value as unknown as AgentTaskJson);return value;});}
 // Keep unresolved conflict selection across restart; interruption cannot accept
 // old tool parameters or consume the user's separate skip/stop decision.
 /** Diagnostic runs are hidden from conversations and have no side effects to review, so a restart stops
  * them instead of leaving an invisible interrupted run that would block the project's next send. */
 function recover():number{return transact(()=>{let count=0;for(const row of db.prepare(`SELECT r.id FROM agent_task_runs_v2 r WHERE r.status IN ('accepted','running','paused','awaiting_approval') OR (r.status='completed' AND EXISTS(${pendingBackgroundSql('r.id')}))`).all()){const value=run(String(row.id));db.prepare("UPDATE agent_task_edit_claims_v2 SET state='uncertain' WHERE projectId=?").run(value.projectId);for(const entry of db.prepare("SELECT id FROM agent_task_steps_v2 WHERE runId=? AND status='dispatch_started'").all(value.id)){const item=step(String(entry.id));item.status='unknown';item.updatedAt=now();saveStep(item);appendEventInside(value.id,'step',item as unknown as AgentTaskJson);}value.status=value.diagnostic?'stopped':'interrupted';if(value.diagnostic||value.pauseReason!=='conflict'&&value.pauseReason!=='editing')value.pauseReason='restart';touch(value);appendEventInside(value.id,'run',value as unknown as AgentTaskJson);count++;}db.prepare("UPDATE agent_task_edit_claims_v2 SET state='uncertain'").run();
 for(const pending of db.prepare("SELECT c.requestId,c.runId FROM agent_task_controls_v2 c LEFT JOIN agent_task_control_states_v2 s ON s.requestId=c.requestId WHERE json_extract(COALESCE(s.data,c.data),'$.result.state')='pending'").all()){
 const runId=String(pending.runId),revertedIds=snapshot(runId).changes.filter(change=>change.status==='reverted').map(change=>change.id);finishControl(String(pending.requestId),{state:'blocked',error:{code:'AGENT_TASK_INTERRUPTED',message:'控制操作因进程重启而中断；已完成的变更回退保持不变。'},revertedIds});
 }return count;});}
 function updatePolicy(input:AgentTaskPolicy,requestId?:string):AgentTaskPolicy{return transact(()=>{const hash=digest(input);if(requestId){const saved=db.prepare('SELECT digest,data FROM agent_task_policy_requests_v2 WHERE requestId=?').get(requestId);if(saved){if(saved.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');return agentTaskPolicySchema.parse(decode(saved.data));}}const next=agentTaskPolicySchema.parse(input),old=policy();if(next.revision!==old.revision)fail('AGENT_TASK_REVISION_CONFLICT');if(next.revision>=Number.MAX_SAFE_INTEGER)fail('AGENT_TASK_REVISION_LIMIT');next.revision++;db.prepare('INSERT INTO agent_task_policy_v2(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(encode(next));if(requestId)db.prepare('INSERT INTO agent_task_policy_requests_v2(requestId,digest,data) VALUES(?,?,?)').run(requestId,hash,encode(next));return next;});}
 function targetRevision(projectId:string,kind:string,id:string):number{return Number(db.prepare('SELECT revision FROM agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(projectId,kind,id)?.revision??0);}
 function assertTargets(projectId:string,targets:AgentTaskTarget[]):void{for(const target of targets){if(targetRevision(projectId,target.kind,target.id)!==target.revision)fail('AGENT_TASK_TARGET_CHANGED');if(db.prepare('SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND kind=? AND targetId=? LIMIT 1').get(projectId,target.kind,target.id))fail('AGENT_TASK_TARGET_CLAIMED');}}
 function conflictingTargets(projectId:string,targets:AgentTaskTarget[]):AgentTaskTarget[]{return targets.filter(target=>targetRevision(projectId,target.kind,target.id)!==target.revision||!!db.prepare('SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND kind=? AND targetId=? LIMIT 1').get(projectId,target.kind,target.id));}
 function claims(projectId:string,ownerId?:string):AgentTaskClaim[]{const sql='SELECT * FROM agent_task_edit_claims_v2 WHERE projectId=?'+(ownerId?' AND ownerId=?':'')+' ORDER BY id';return db.prepare(sql).all(...(ownerId?[projectId,ownerId]:[projectId])).map(row=>({id:String(row.id),projectId,ownerId:String(row.ownerId),target:{kind:String(row.kind),id:String(row.targetId),revision:Number(row.revision)},state:row.state==='active'?'active':'uncertain',createdAt:String(row.createdAt),updatedAt:String(row.updatedAt)}));}
 function claim(input:{projectId:string;ownerId:string;targets:AgentTaskTarget[]}):AgentTaskClaim[]{return transact(()=>{for(const target of input.targets){if(targetRevision(input.projectId,target.kind,target.id)!==target.revision)fail('AGENT_TASK_TARGET_CHANGED');const existing=db.prepare('SELECT revision,state FROM agent_task_edit_claims_v2 WHERE projectId=? AND ownerId=? AND kind=? AND targetId=?').get(input.projectId,input.ownerId,target.kind,target.id);if(existing&&Number(existing.revision)!==target.revision)fail('AGENT_TASK_TARGET_CHANGED');if(existing?.state==='uncertain')fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');const date=now();db.prepare("INSERT INTO agent_task_edit_claims_v2(id,projectId,ownerId,kind,targetId,revision,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'active',?,?) ON CONFLICT(projectId,ownerId,kind,targetId) DO UPDATE SET state='active',updatedAt=excluded.updatedAt").run(randomUUID(),input.projectId,input.ownerId,target.kind,target.id,target.revision,date,date);}return claims(input.projectId,input.ownerId);});}
 function releaseClaims(projectId:string,ownerId:string,targets?:AgentTaskTarget[]):void{transact(()=>{if(!targets)db.prepare('DELETE FROM agent_task_edit_claims_v2 WHERE projectId=? AND ownerId=?').run(projectId,ownerId);else for(const target of targets)db.prepare('DELETE FROM agent_task_edit_claims_v2 WHERE projectId=? AND ownerId=? AND kind=? AND targetId=?').run(projectId,ownerId,target.kind,target.id);});}
 function appendText(runId:string,stepId:string,text:string):void{transact(()=>{const item=step(stepId);if(item.runId!==runId)fail('AGENT_TASK_NOT_FOUND');item.text=(item.text??'')+text;if(Buffer.byteLength(item.text)>256*1024)fail('AGENT_TASK_STORAGE_LIMIT');saveStep(item);appendEventInside(runId,'text',{stepId,text});});}
 function markChangeRevertedInside(changeId:string):AgentTaskChange{inside();const row=db.prepare('SELECT data FROM agent_task_changes_v2 WHERE id=?').get(changeId);if(!row)fail('AGENT_TASK_NOT_FOUND');const change=decode<AgentTaskChange>(row.data);if(!change.reversible)fail('AGENT_TASK_NOT_REVERSIBLE');change.status='reverted';change.revertedAt=now();change.revertedTargets=change.targets.map(target=>({...target,revision:targetRevision(change.projectId,target.kind,target.id)}));db.prepare('UPDATE agent_task_changes_v2 SET data=? WHERE id=?').run(encode(change),changeId);touch(run(change.runId));appendEventInside(change.runId,'change',change as unknown as AgentTaskJson);return change;}
 function markChangeSupersededInside(changeId:string):AgentTaskChange{inside();const row=db.prepare('SELECT data FROM agent_task_changes_v2 WHERE id=?').get(changeId);if(!row)fail('AGENT_TASK_NOT_FOUND');const change=decode<AgentTaskChange>(row.data);if(!change.reversible||change.status!=='applied')fail('AGENT_TASK_NOT_REVERSIBLE');change.status='superseded';db.prepare('UPDATE agent_task_changes_v2 SET data=? WHERE id=?').run(encode(change),changeId);touch(run(change.runId));appendEventInside(change.runId,'change',change as unknown as AgentTaskJson);return change;}
 function markChangeRetainedInside(changeId:string,reason:string):AgentTaskChange{inside();const row=db.prepare('SELECT data FROM agent_task_changes_v2 WHERE id=?').get(changeId);if(!row)fail('AGENT_TASK_NOT_FOUND');const change=decode<AgentTaskChange>(row.data);if(!change.reversible||change.status!=='applied'||change.operation!=='shot.create')fail('AGENT_TASK_NOT_REVERSIBLE');change.reversible=false;change.summary=`${change.summary??change.operation}（${reason}）`;db.prepare('UPDATE agent_task_changes_v2 SET data=? WHERE id=?').run(encode(change),changeId);touch(run(change.runId));appendEventInside(change.runId,'change',change as unknown as AgentTaskJson);return change;}
 function edit(input:AgentTaskEditingInput):{requestId:string;projectId:string;ownerId:string;generation:number;sequence:number;claims:AgentTaskClaim[]}{return transact(()=>{
 const hash=digest(input),saved=db.prepare('SELECT digest,data FROM agent_task_edit_receipts_v2 WHERE requestId=?').get(input.requestId);if(saved){if(saved.digest!==hash)fail('AGENT_TASK_REQUEST_CONFLICT');return decode(saved.data);}
 const owner=db.prepare('SELECT generation,sequence FROM agent_task_edit_owners_v2 WHERE projectId=? AND ownerId=?').get(input.projectId,input.ownerId);
 if(owner&&(Number(owner.generation)>input.generation||Number(owner.generation)===input.generation&&Number(owner.sequence)>=input.sequence))fail('AGENT_TASK_EDIT_OWNER_STALE');
 if(owner&&input.generation>Number(owner.generation)&&!['resolve','restore'].includes(input.action))fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
 if(input.action==='claim'&&db.prepare("SELECT 1 FROM agent_task_edit_claims_v2 WHERE projectId=? AND ownerId=? AND state='uncertain' LIMIT 1").get(input.projectId,input.ownerId))fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
 if(input.action==='restore'){
 const retained=claims(input.projectId,input.ownerId),requested=new Map(input.targets.map(target=>[`${target.kind}:${target.id}`,target]));
 if(!owner||!retained.length||requested.size!==input.targets.length||requested.size!==retained.length)fail('AGENT_TASK_EDIT_OWNER_UNCERTAIN');
 for(const entry of retained){const target=requested.get(`${entry.target.kind}:${entry.target.id}`);if(!target||target.revision!==entry.target.revision||targetRevision(input.projectId,target.kind,target.id)!==entry.target.revision)fail('AGENT_TASK_TARGET_CHANGED');}
 db.prepare("UPDATE agent_task_edit_claims_v2 SET state='active',updatedAt=? WHERE projectId=? AND ownerId=?").run(now(),input.projectId,input.ownerId);
 }else if(input.action==='claim')claim(input);else if(input.action==='release'||input.action==='resolve')releaseClaims(input.projectId,input.ownerId,input.targets);else db.prepare("UPDATE agent_task_edit_claims_v2 SET updatedAt=? WHERE projectId=? AND ownerId=?").run(now(),input.projectId,input.ownerId);
 db.prepare('INSERT INTO agent_task_edit_owners_v2(projectId,ownerId,generation,sequence) VALUES(?,?,?,?) ON CONFLICT(projectId,ownerId) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence').run(input.projectId,input.ownerId,input.generation,input.sequence);
 const result={requestId:input.requestId,projectId:input.projectId,ownerId:input.ownerId,generation:input.generation,sequence:input.sequence,claims:claims(input.projectId,input.ownerId)};db.prepare('INSERT INTO agent_task_edit_receipts_v2(requestId,projectId,ownerId,digest,data) VALUES(?,?,?,?,?)').run(input.requestId,input.projectId,input.ownerId,hash,encode(result));return result;
 });}
 function markClaimsUncertain(projectId?:string,ownerId?:string):void{transact(()=>{const filters:string[]=[],args:string[]=[];if(projectId){filters.push('projectId=?');args.push(projectId);}if(ownerId){filters.push('ownerId=?');args.push(ownerId);}db.prepare("UPDATE agent_task_edit_claims_v2 SET state='uncertain'"+(filters.length?' WHERE '+filters.join(' AND '):'')).run(...args);});}
 function expireClaims(maxAgeMs=30000):number{return transact(()=>Number(db.prepare("UPDATE agent_task_edit_claims_v2 SET state='uncertain' WHERE state='active' AND updatedAt<?").run(new Date(Date.now()-maxAgeMs).toISOString()).changes));}
 return {expireClaims,markClaimsUncertain,edit,lookupRequest:(projectId:string,requestId:string):AgentTaskSnapshot|null=>{const row=db.prepare('SELECT id FROM agent_task_runs_v2 WHERE projectId=? AND requestId=?').get(projectId,requestId);return row?snapshot(String(row.id)):null;},lookupEdit:(requestId:string):unknown=>{const row=db.prepare('SELECT data FROM agent_task_edit_receipts_v2 WHERE requestId=?').get(requestId);return row?decode(row.data):null;},create,conversation,conversationSummary,contextRuns,requestConversationId,snapshot,hasPendingBackground,history,latestDiagnostic:(profile:AgentTaskDiagnostic['profile']):AgentTaskSnapshot|null=>{const row=db.prepare("SELECT id FROM agent_task_runs_v2 WHERE json_extract(data,'$.diagnostic.profile')=? ORDER BY json_extract(data,'$.createdAt') DESC,rowid DESC LIMIT 1").get(profile);return row?snapshot(String(row.id)):null;},list:(projectId:string,{excludeDiagnostics=false}:{excludeDiagnostics?:boolean}={}):AgentTaskRun[]=>db.prepare(`SELECT data FROM agent_task_runs_v2 WHERE projectId=?${excludeDiagnostics?` AND ${visibleRuns}`:''} ORDER BY rowid DESC LIMIT 100`).all(projectId).map(row=>decode<AgentTaskRun>(row.data)),events,eventSequence,run,step,transition,beginStep,beginModelStep,appendNoteInside,skipTargetsInside,updateStep,dispatchPrevented,markDispatch:(runId:string,stepId:string)=>updateStep(runId,stepId,{status:'dispatch_started'}),completeStepInside,appendChangesInside,completeStep:(runId:string,stepId:string,input:Parameters<typeof completeStepInside>[2])=>transact(()=>completeStepInside(runId,stepId,input)),appendText,appendEvent:(runId:string,type:string,data:AgentTaskJson)=>transact(()=>appendEventInside(runId,type,data)),control,performControl,rejectControl,beginControl,finishControl,lookupControl,resume,recover,policy,updatePolicy,lookupPolicy:(requestId:string):AgentTaskPolicy|null=>{const row=db.prepare('SELECT data FROM agent_task_policy_requests_v2 WHERE requestId=?').get(requestId);return row?agentTaskPolicySchema.parse(decode(row.data)):null;},targetRevision,revisionSnapshot:(projectId:string):AgentTaskTarget[]=>db.prepare('SELECT kind,targetId,revision FROM agent_task_target_revisions_v2 WHERE projectId=? ORDER BY kind,targetId').all(projectId).map(row=>({kind:String(row.kind),id:String(row.targetId),revision:Number(row.revision)})),assertTargets,conflictingTargets,claims,claim,releaseClaims,markChangeRevertedInside,markChangeRetainedInside,markChangeSupersededInside};
}
export type AgentTaskJournal=ReturnType<typeof createAgentTaskJournal>;
