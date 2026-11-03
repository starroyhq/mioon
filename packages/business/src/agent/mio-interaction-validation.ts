import type {DatabaseSync} from 'node:sqlite';
import {agentTaskNoteSchema,agentTaskSkippedTargetSchema,agentTaskTargetSchema} from '../../../contracts/src/agent-tasks-v2.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid:()=>never=()=>{throw Object.assign(new Error('Invalid retained Mio interaction'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
const decode=(text:unknown):unknown=>{if(typeof text!=='string'||Buffer.byteLength(text)>2097152)invalid();try{return JSON.parse(text);}catch{return invalid();}};
interface Step {runId:string;kind:string;position:number;targets:unknown[];conflicts:unknown[]}
/** Current immutable entries replace the old run JSON arrays. Check the same
 * interaction obligations against entry order and actual model/tool ownership;
 * timestamps are validated as dates, never used as ordering authority. */
export function validateMioInteractionRows(db:DatabaseSync):void {
 const steps=new Map<string,Step>();
 for(const row of db.prepare('SELECT id,runId,kind,position,data FROM mio_steps').iterate()){
  const metadata=decode(row.data);if(!object(metadata))invalid();
  const controls=object(metadata.controls)?metadata.controls:{},data=object(metadata.data)?metadata.data:{};
  steps.set(String(row.id),{runId:String(row.runId),kind:String(row.kind),position:Number(row.position),targets:Array.isArray(controls.targets)?controls.targets:[],conflicts:Array.isArray(data.conflictTargets)?data.conflictTargets:[]});
 }
 const states=new Map<string,{notes:Map<string,{model?:string}>;pending:string[];position:number;skipped:Set<string>}>();
 for(const row of db.prepare(`SELECT e.runId,e.kind,e.createdAt,coalesce(e.payloadJson,b.content) AS payload FROM mio_entries e LEFT JOIN mio_blobs b ON b.sha256=e.payloadBlobHash WHERE e.kind IN ('note','host_state') ORDER BY e.runId,e.sequence`).iterate()){
  const runId=String(row.runId),value=decode(row.payload);if(!object(value))invalid();
  let state=states.get(runId);if(!state){state={notes:new Map(),pending:[],position:0,skipped:new Set()};states.set(runId,state);}
  if(row.kind==='note'){
   const note=agentTaskNoteSchema.safeParse({...value,createdAt:row.createdAt});
   if(!note.success||Object.hasOwn(value,'createdAt')||Object.hasOwn(value,'modelStepId')||state.notes.has(note.data.requestId))invalid();
   state.notes.set(note.data.requestId,{});state.pending.push(note.data.requestId);if(state.pending.length>5)invalid();
  }else if(value.type==='notes_bound'){
   if(typeof value.modelStepId!=='string'||!Array.isArray(value.requestIds)||!value.requestIds.length||value.requestIds.some(id=>typeof id!=='string'))invalid();
   const modelStepId=value.modelStepId,step=steps.get(modelStepId);
   if(!step||step.runId!==runId||step.kind!=='model'||step.position<state.position||JSON.stringify(value.requestIds)!==JSON.stringify(state.pending))invalid();
   for(const id of state.pending){const note=state.notes.get(id);if(!note||note.model!==undefined)invalid();note.model=modelStepId;}
   state.pending=[];state.position=step.position;
  }else if(value.type==='skipped_targets'){
   if(!Array.isArray(value.items)||!value.items.length)invalid();
   for(const item of value.items){
    const parsed=agentTaskSkippedTargetSchema.safeParse(item);if(!parsed.success)invalid();const skip=parsed.data,key=JSON.stringify([skip.target.kind,skip.target.id]),step=steps.get(skip.stepId);
    const contains=(target:unknown)=>object(target)&&target.kind===skip.target.kind&&target.id===skip.target.id;
    if(state.skipped.has(key)||!step||step.runId!==runId||step.kind!=='tool'||!step.targets.some(target=>agentTaskTargetSchema.safeParse(target).success&&contains(target))||!step.conflicts.some(target=>agentTaskTargetSchema.safeParse(target).success&&contains(target)))invalid();
    // A background conflict can be accepted after a later tool's skip.
    state.skipped.add(key);
   }
  }
 }
}
