import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson,AgentTaskSkippedTarget} from '../packages/contracts/src/agent-tasks-v2.ts';
const invalid={code:'RESTORE_SCHEMA_UNSUPPORTED'};
function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-native-interactions-'));let store=openStore(root),journal=createAgentTaskJournal(store);
 const projectId=store.projectId;store.put('projects',{id:projectId,name:'Interaction records',revision:1});
 const run=journal.create({requestId:randomUUID(),projectId,text:'Preserved original',configuration:{protocol:'chat_completions',model:'synthetic'},context:[{role:'user',content:'retained context'}]}).run;
 return {root,projectId,run,get store(){return store;},get journal(){return journal;},get records(){return createMioRecords(store);},
  reopen(){store.close();store=openStore(root);journal=createAgentTaskJournal(store);},close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
function entry(f:Fixture,kind:'note'|'host_state',payload:AgentTaskJson,at='2020-01-01T00:00:00.000Z'){
 return f.records.appendEntry({id:randomUUID(),runId:f.run.id,kind,payload:{json:payload},createdAt:at});
}
function toolStep(f:Fixture,runId=f.run.id,options:{targets?:Parameters<typeof f.journal.beginStep>[1]['targets'];data?:AgentTaskJson}={}){
 const call={id:randomUUID(),name:'mioon_project_inspect',arguments:{}};
 const model=f.journal.beginModelStep(runId,{request:{body:JSON.stringify({model:'synthetic',stream:true,messages:[]}),history:[]}},[]);
 f.journal.markDispatch(runId,model.id);f.journal.completeStep(runId,model.id,{result:{text:'Source',toolCalls:[call],providerOutput:{role:'assistant',content:'Source',tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:'{}'}}]}}});
 return f.journal.beginStep(runId,{kind:'tool',toolCall:call,...options,data:{...(options.data&&typeof options.data==='object'&&!Array.isArray(options.data)?options.data:{}),sourceModelStepId:model.id}});
}
function evidence(f:Fixture){const one=f.journal.beginStep(f.run.id,{kind:'model'}),two=f.journal.beginStep(f.run.id,{kind:'model'}),target={kind:'shot',id:randomUUID(),revision:9},tool=toolStep(f,f.run.id,{targets:[{...target,revision:1}],data:{conflictTargets:[target]}});return {one,two,target,tool};}
function notes(f:Fixture,count=1){return Array.from({length:count},()=>{const requestId=randomUUID();entry(f,'note',{requestId,text:'Additional instruction'});return requestId;});}
const bind=(f:Fixture,modelStepId:string,requestIds:string[])=>entry(f,'host_state',{type:'notes_bound',modelStepId,requestIds});
const skip=(f:Fixture,items:AgentTaskSkippedTarget[])=>entry(f,'host_state',{type:'skipped_targets',items:items as unknown as AgentTaskJson});
const validate=(f:Fixture)=>validateAgentTaskRowsV2(f.store.db);
function state(f:Fixture){const library=testProjectAppLibrary(f.store);assert.ok(library);return [f.store.db.prepare('SELECT * FROM mio_entries ORDER BY sequence').all(),f.store.db.prepare('SELECT * FROM mio_storage_counters').all(),f.store.db.prepare('SELECT total_changes() AS n').get(),library.db.prepare('SELECT total_changes() AS n').get()];}
const display={operation:'shot.update',targets:[],targetCount:0,fields:[]};
test('public snapshots accept Step and Change display without changing persistent records',()=>{const f=fixture();try{
 const step=toolStep(f);f.journal.markDispatch(f.run.id,step.id);f.journal.completeStep(f.run.id,step.id,{result:{done:true},change:{projectId:f.projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:false}});
 const snapshot=f.journal.snapshot(f.run.id),before=state(f),response=agentTaskSnapshotSchema.parse({...snapshot,steps:snapshot.steps.map(step=>({...step,display})),changes:snapshot.changes.map(change=>({...change,display}))});
 assert.deepEqual(response.steps[0]!.display,display);assert.deepEqual(response.changes[0]!.display,display);assert.deepEqual(f.journal.snapshot(f.run.id),snapshot);assert.deepEqual(state(f),before);
}finally{f.close();}});
test('notes and skipped targets keep append-only evidence while binding unconsumed notes once',()=>{const f=fixture();try{
 const {one,two,target,tool}=evidence(f);let first='';f.store.tx(()=>{[first]=notes(f);bind(f,one.id,[first]);skip(f,[{target,stepId:tool.id,createdAt:'2020-01-01T00:00:00.000Z'}]);});validate(f);
 const row=f.store.db.prepare("SELECT id FROM mio_entries WHERE kind='note'").get()!;
 for(const sql of ["DELETE FROM mio_entries WHERE id=?","UPDATE mio_entries SET payloadJson='{}' WHERE id=?","UPDATE mio_entries SET createdAt='2021-01-01T00:00:00.000Z' WHERE id=?","INSERT OR REPLACE INTO mio_entries SELECT * FROM mio_entries WHERE id=?"])assert.throws(()=>f.store.db.prepare(sql).run(row.id),/immutable|retained/u);
 assert.throws(()=>f.store.tx(()=>{bind(f,two.id,[first]);validate(f);}),invalid);
 assert.throws(()=>f.store.tx(()=>{notes(f,6);validate(f);}),invalid);
 assert.equal(f.journal.run(f.run.id).notes?.[0]?.modelStepId,one.id);
}finally{f.close();}});
test('valid interaction entry order survives wall-clock rollback and an actual kernel reopen',()=>{const f=fixture();try{
 const {one,two,target,tool}=evidence(f);f.store.tx(()=>{bind(f,one.id,notes(f));bind(f,two.id,notes(f));notes(f);skip(f,[{target,stepId:tool.id,createdAt:'2019-01-01T00:00:00.000Z'}]);});validate(f);
 const before=f.journal.run(f.run.id);assert.ok(before.notes![0]!.createdAt<f.run.createdAt);f.reopen();validate(f);
 assert.deepEqual(f.journal.run(f.run.id).notes,before.notes);assert.deepEqual(f.journal.run(f.run.id).skippedTargets,before.skippedTargets);assert.equal(f.journal.run(f.run.id).text,'Preserved original');
}finally{f.close();}});
for(const kind of ['missing arrays','six pending','duplicate note','foreign model','tool as model','reverse model order','pending before consumed','duplicate skipped target','model as skipped step','foreign skipped step','missing conflict target','invalid conflict target','missing step target','invalid note timestamp','invalid skip timestamp'] as const)test(`native retained interactions reject corrupt ${kind} metadata before recovery`,()=>{const f=fixture(),foreignFixture=fixture();try{
 const {one,two,target,tool}=evidence(f),foreign=foreignFixture.run,foreignModel=foreignFixture.journal.beginStep(foreign.id,{kind:'model'}),foreignTool=toolStep(foreignFixture,foreign.id,{targets:[target],data:{conflictTargets:[target]}});
 if(kind==='missing conflict target')f.journal.updateStep(f.run.id,tool.id,{data:{conflictTargets:[]}});if(kind==='invalid conflict target')f.journal.updateStep(f.run.id,tool.id,{data:{conflictTargets:[{kind:target.kind,id:target.id}]}});if(kind==='missing step target')f.journal.updateStep(f.run.id,tool.id,{targets:[]});
 f.store.tx(()=>{
  if(kind==='six pending'){notes(f,6);return;}
  if(kind==='duplicate note'){const [id]=notes(f);entry(f,'note',{requestId:id,text:'Additional instruction'});return;}
  if(kind==='missing arrays'){entry(f,'host_state',{type:'notes_bound',modelStepId:one.id});return;}
  if(kind==='invalid note timestamp'){
   const owner=f.records.run(f.run.id),sequence=Number(f.store.db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM mio_entries WHERE runId=?').get(f.run.id)!.n);
   f.store.db.prepare('INSERT INTO mio_entries(id,projectId,conversationId,runId,sequence,kind,payloadJson,payloadBlobHash,createdAt) VALUES(?,?,?,?,?,\'note\',?,NULL,?)').run(randomUUID(),f.projectId,owner.conversationId,f.run.id,sequence,JSON.stringify({requestId:randomUUID(),text:'Additional instruction'}),'not an ISO time');return;
  }
  if(kind==='reverse model order'){bind(f,two.id,notes(f));bind(f,one.id,notes(f));return;}
  if(kind==='pending before consumed'){const ids=notes(f,2);bind(f,one.id,[ids[1]!]);return;}
  if(kind==='foreign model'||kind==='tool as model'){bind(f,kind==='foreign model'?foreignModel.id:tool.id,notes(f));return;}
  const item={target,stepId:kind==='model as skipped step'?one.id:kind==='foreign skipped step'?foreignTool.id:tool.id,createdAt:kind==='invalid skip timestamp'?'not an ISO time':'2020-01-01T00:00:00.000Z'};
  skip(f,kind==='duplicate skipped target'?[item,{...item}]:[item]);
 });
 const before=state(f);assert.throws(()=>validate(f),invalid);assert.deepEqual(state(f),before);
}finally{foreignFixture.close();f.close();}});
test('later background conflicts may append a skip originating from an earlier tool position',()=>{const f=fixture();try{
 const earlier={kind:'shot',id:randomUUID(),revision:1},later={kind:'shot',id:randomUUID(),revision:3},first=toolStep(f,f.run.id,{targets:[earlier],data:{conflictTargets:[earlier]}}),second=toolStep(f,f.run.id,{targets:[later],data:{conflictTargets:[later]}});
 for(const step of [first,second]){f.journal.markDispatch(f.run.id,step.id);f.journal.completeStep(f.run.id,step.id,{result:{queued:true}});}
 f.store.tx(()=>{skip(f,[{target:later,stepId:second.id,createdAt:'2026-10-22T00:00:00.000Z'}]);skip(f,[{target:earlier,stepId:first.id,createdAt:'2026-10-22T00:01:00.000Z'}]);});validate(f);
 const before=f.journal.run(f.run.id).skippedTargets;assert.deepEqual(before?.map(item=>item.target),[later,earlier]);f.reopen();validate(f);assert.deepEqual(f.journal.run(f.run.id).skippedTargets,before);
}finally{f.close();}});
