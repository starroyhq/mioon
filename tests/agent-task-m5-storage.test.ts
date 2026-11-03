import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {MIO_STORAGE_TABLES} from '../packages/contracts/src/mio-storage.ts';
import {schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {agentTaskChangeSchema,agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-native-m5-')),store=openStore(root),projectId=store.projectId,journal=createAgentTaskJournal(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});store.put('projects',{id:projectId,name:'M5 retained records',revision:1});
 const run=journal.create({requestId:randomUUID(),projectId,text:'Preserve existing evidence',configuration:{protocol:'chat_completions',model:'synthetic'}}).run;
 const model=journal.beginModelStep(run.id,{request:{body:JSON.stringify({model:'synthetic',stream:true,messages:[]}),history:[]},data:{retryRequested:true,toolsInvalidated:true}},[]);
 journal.markDispatch(run.id,model.id);journal.completeStep(run.id,model.id,{result:{text:'Saved response',toolCalls:[],providerOutput:{role:'assistant',content:'Saved response'}}});
 const call={id:randomUUID(),name:'mioon_project_inspect',arguments:{}};
 const source=journal.beginModelStep(run.id,{request:{body:JSON.stringify({model:'synthetic',stream:true,messages:[]}),history:[]}},[]);journal.markDispatch(run.id,source.id);journal.completeStep(run.id,source.id,{result:{text:'Source',toolCalls:[call],providerOutput:{role:'assistant',content:'Source',tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:'{}'}}]}}});
 const tool=journal.beginStep(run.id,{kind:'tool',toolCall:call,data:{sourceModelStepId:source.id}});journal.markDispatch(run.id,tool.id);journal.completeStep(run.id,tool.id,{result:{done:true},change:{projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:true}});
 const original=journal.snapshot(run.id).changes[0]!;store.tx(()=>journal.markChangeSupersededInside(original.id));
 const change=journal.snapshot(run.id).changes[0]!;journal.appendEvent(run.id,'change',JSON.parse(JSON.stringify(change)));journal.transition(run.id,journal.run(run.id).revision,'failed');
 const request={requestId:randomUUID(),runId:run.id,expectedRevision:journal.run(run.id).revision,action:'retry'};journal.performControl(request,()=>({state:'completed',stepId:model.id}));
 return {root,store,projectId,journal,run,model,change,request};
}
function retained(store:ReturnType<typeof openStore>){return Object.fromEntries(MIO_STORAGE_TABLES.map(table=>{
 const columns=store.db.prepare(`PRAGMA main.table_info(${table})`).all().map(row=>String(row.name));
 return [table,store.db.prepare(`SELECT * FROM main.${table} ORDER BY ${columns.map(name=>'"'+name+'"').join(',')}`).all()];
}));}
test('current Mio stores retry receipts and superseded evidence across a real kernel reopen without schema changes',t=>{
 const f=fixture(t);assert.equal(agentTaskChangeSchema.parse(f.change).status,'superseded');assert.equal(f.journal.lookupControl(f.request.requestId)?.action,'retry');
 const original=retained(f.store),catalog=schemaObjects(f.store.db);validateAgentTaskRowsV2(f.store.db);assert.equal(readMioStorage(f.store.db).format,'mio_records');assert.deepEqual(schemaObjects(f.store.db),catalog);f.store.close();
 const copy=openStore(f.root);try{
  const journal=createAgentTaskJournal(copy),snapshot=journal.snapshot(f.run.id);validateAgentTaskRowsV2(copy.db);
  assert.deepEqual(schemaObjects(copy.db),catalog);assert.deepEqual(retained(copy),original);assert.equal(snapshot.changes[0]?.status,'superseded');assert.equal(journal.lookupControl(f.request.requestId)?.action,'retry');
  assert.deepEqual(journal.step(f.model.id).data,{retryRequested:true,toolsInvalidated:true});assert.ok(snapshot.changes.every(change=>!Object.hasOwn(change,'modifiedAfter')&&!Object.hasOwn(change,'undoDisposition')));
  assert.deepEqual(journal.performControl(f.request,()=>{throw new Error('Exact retry must not execute');}),journal.lookupControl(f.request.requestId));
  assert.deepEqual(retained(copy),original);
 }finally{copy.close();}
});
const projections=[['modifiedAfter',false],['modifiedAfter',true],['undoDisposition','undo'],['undoDisposition','retain'],['undoDisposition','blocked']] as const;
for(const [field,value]of projections)test(`current Mio refuses persisted ${field}=${value} without altering original evidence`,t=>{
 const f=fixture(t),original=retained(f.store),catalog=schemaObjects(f.store.db),snapshot=f.journal.snapshot(f.run.id);
 const projected=agentTaskSnapshotSchema.parse({...snapshot,changes:snapshot.changes.map(change=>({...change,[field]:value}))});
 assert.equal(projected.changes[0]![field],value);assert.deepEqual(retained(f.store),original,'Public-only DTO fields cannot persist');
 f.store.db.prepare('UPDATE mio_changes SET data=json_set(data,?,json(?)) WHERE id=?').run(`$.${field}`,JSON.stringify(value),f.change.id);const polluted=retained(f.store);
 assert.throws(()=>validateAgentTaskRowsV2(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(retained(f.store),polluted);assert.deepEqual(schemaObjects(f.store.db),catalog);
 assert.equal(f.store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='workspace_restoration'").get(),undefined);
 f.store.db.prepare('UPDATE mio_changes SET data=json_remove(data,?) WHERE id=?').run(`$.${field}`,f.change.id);assert.deepEqual(retained(f.store),original);validateAgentTaskRowsV2(f.store.db);assert.equal(readMioStorage(f.store.db).format,'mio_records');
});
