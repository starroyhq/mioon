import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AgentTaskEvent,AgentTaskJson} from '@mioon/contracts/agent-tasks-v2';

export const AGENT_TASK_MODEL_REQUEST_REF_FORMAT='mioon-model-request-ref/1' as const;
export const AGENT_TASK_EVENT_PAGE_BYTES=8*1024*1024;
const requestLimit=2*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const hash=/^[a-f0-9]{64}$/u;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw Object.assign(new Error('Model request evidence is invalid'),{code:'AGENT_TASK_STORAGE_CORRUPT'});};
interface SavedRequest {runId:string;projectId:string;request:AgentTaskJson;sha256:string;bytes:number}
export type AgentTaskRequestCache=Map<string,SavedRequest>;

function referenceCandidate(value:unknown):boolean {
 return record(value)&&(typeof value.format==='string'&&value.format.startsWith('mioon-model-request-ref/')||Object.hasOwn(value,'stepId')&&Object.hasOwn(value,'sha256')&&Object.hasOwn(value,'bytes'));
}
function fingerprint(value:unknown):{sha256:string;bytes:number} {
 const encoded=JSON.stringify(value);if(!encoded)return fail();
 const bytes=Buffer.byteLength(encoded);if(bytes>requestLimit)return fail();
 return {sha256:createHash('sha256').update(encoded).digest('hex'),bytes};
}
function sourceRequest(db:DatabaseSync,stepId:string,cache:AgentTaskRequestCache):SavedRequest {
 const cached=cache.get(stepId);if(cached)return cached;
 const row=db.prepare('SELECT id,runId,projectId,data FROM agent_task_steps_v2 WHERE id=?').get(stepId);
 if(!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>requestLimit)return fail();
 let step:unknown;try{step=JSON.parse(row.data);}catch{return fail();}
 if(!record(step)||step.id!==row.id||step.runId!==row.runId||step.kind!=='model'||!Object.hasOwn(step,'request')||referenceCandidate(step.request)||typeof row.runId!=='string'||typeof row.projectId!=='string')return fail();
 const owner=db.prepare('SELECT projectId FROM agent_task_runs_v2 WHERE id=?').get(row.runId);
 if(owner?.projectId!==row.projectId)return fail();
 const value:SavedRequest={runId:row.runId,projectId:row.projectId,request:step.request as AgentTaskJson,...fingerprint(step.request)};
 cache.set(stepId,value);return value;
}
function modelEvent(event:AgentTaskEvent):Record<string,unknown>|undefined {
 return event.type==='step'&&record(event.data)&&event.data.kind==='model'?event.data:undefined;
}

/** New event rows reference the immutable request in their own model step.
 * Historical status/result/text still belong to the event, not the live step. */
export function referenceAgentTaskEventRequest(db:DatabaseSync,event:AgentTaskEvent,projectId:string):AgentTaskEvent {
 const data=modelEvent(event);if(!data||!Object.hasOwn(data,'request'))return event;
 if(typeof data.id!=='string'||!uuid.test(data.id)||data.runId!==event.runId||referenceCandidate(data.request))return fail();
 const source=sourceRequest(db,data.id,new Map()),actual=fingerprint(data.request);
 if(source.runId!==event.runId||source.projectId!==projectId||source.sha256!==actual.sha256||source.bytes!==actual.bytes)return fail();
 return {...event,data:{...data,request:{format:AGENT_TASK_MODEL_REQUEST_REF_FORMAT,stepId:data.id,sha256:source.sha256,bytes:source.bytes}} as AgentTaskJson};
}

/** References are private persistence metadata. Never rebuild a request from
 * current settings/history, or return a partly verified historical event. */
export function hydrateAgentTaskEventRequest(db:DatabaseSync,event:AgentTaskEvent,projectId:string,{allowReferences,cache=new Map()}:{allowReferences:boolean;cache?:AgentTaskRequestCache}):AgentTaskEvent {
 const data=modelEvent(event);if(!data||!referenceCandidate(data.request))return event;
 if(!allowReferences||!record(data.request))return fail();const ref=data.request;
 if(Object.keys(ref).length!==4||!['format','stepId','sha256','bytes'].every(key=>Object.hasOwn(ref,key))||ref.format!==AGENT_TASK_MODEL_REQUEST_REF_FORMAT||typeof ref.stepId!=='string'||!uuid.test(ref.stepId)||ref.stepId!==data.id||data.runId!==event.runId||typeof ref.sha256!=='string'||!hash.test(ref.sha256)||!Number.isSafeInteger(ref.bytes)||Number(ref.bytes)<1||Number(ref.bytes)>requestLimit)return fail();
 const source=sourceRequest(db,ref.stepId,cache);
 if(source.runId!==event.runId||source.projectId!==projectId||source.sha256!==ref.sha256||source.bytes!==ref.bytes)return fail();
 return {...event,data:{...data,request:structuredClone(source.request)} as AgentTaskJson};
}

export function validateAgentTaskModelRequestReferences(db:DatabaseSync,{allowReferences}:{allowReferences:boolean}):void {
 const cache:AgentTaskRequestCache=new Map();
 for(const row of db.prepare('SELECT data FROM agent_task_steps_v2').iterate()){
  if(typeof row.data!=='string')return fail();let step:unknown;try{step=JSON.parse(row.data);}catch{return fail();}
  if(record(step)&&step.kind==='model'&&referenceCandidate(step.request))return fail();
 }
 for(const row of db.prepare("SELECT runId,projectId,sequence,type,data FROM agent_task_events_v2 WHERE type='step'").iterate()){
  if(typeof row.data!=='string'||typeof row.projectId!=='string')return fail();let event:unknown;try{event=JSON.parse(row.data);}catch{return fail();}
  if(!record(event)||event.runId!==row.runId||event.sequence!==row.sequence||event.type!==row.type)return fail();
  hydrateAgentTaskEventRequest(db,event as unknown as AgentTaskEvent,row.projectId,{allowReferences,cache});
 }
}
