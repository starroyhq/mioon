import {removeReviewedSchema58} from './helpers/current-schema58-delta.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {agentTaskChangeSchema,agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {removeReviewedSchema56} from './helpers/current-schema56-delta.ts';

type SourceVersion=52|54|56;
function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-m5-storage-')),store=openStore(root),projectId=randomUUID();removeReviewedSchema58(store.db);const journal=createAgentTaskJournal(store);let closed=false;
 const close=()=>{if(!closed){closed=true;store.close();}};
 t.after(()=>{close();for(const path of [root,root+'-backup',root+'-restored'])rmSync(path,{recursive:true,force:true});});
 store.put('projects',{id:projectId,name:'M5 storage compatibility',revision:1});
 const run=journal.create({requestId:randomUUID(),projectId,text:'Preserve existing evidence',configuration:{protocol:'responses'}}).run;
 const model=journal.beginStep(run.id,{kind:'model',data:{retryRequested:true,toolsInvalidated:true}});
 journal.completeStep(run.id,model.id,{result:{text:'Saved response',toolCalls:[],providerOutput:[]}});
 const tool=journal.beginStep(run.id,{kind:'tool'});journal.markDispatch(run.id,tool.id);
 journal.completeStep(run.id,tool.id,{result:{done:true},change:{projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:true}});
 const change=journal.snapshot(run.id).changes[0]!;
 // Both the status and the generic control action were valid before M5. Build
 // these storage fixtures without depending on the new execution semantics.
 store.db.prepare("UPDATE agent_task_changes_v2 SET data=json_set(data,'$.status','superseded') WHERE id=?").run(change.id);
 const superseded=journal.snapshot(run.id).changes[0]!;
 journal.appendEvent(run.id,'change',superseded as unknown as AgentTaskJson);
 journal.transition(run.id,journal.run(run.id).revision,'failed');
 const request={requestId:randomUUID(),runId:run.id,expectedRevision:journal.run(run.id).revision,action:'retry'};
 journal.performControl(request,()=>({state:'completed',stepId:model.id}));
 return {root,store,projectId,journal,run,model,change:superseded,request,close};
}
function sourceProfile(f:ReturnType<typeof fixture>,version:SourceVersion):void {
 if(version<56)removeReviewedSchema56(f.store.db);
 if(version===52)f.store.db.exec("DROP INDEX agent_task_conversation_v2;DROP TRIGGER agent_task_conversation_identity_v2;DROP TRIGGER agent_task_conversation_required_v2;UPDATE agent_task_runs_v2 SET data=json_remove(data,'$.conversationId');DELETE FROM schema_version WHERE version=54");
 assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:version,profile:'ordinary'});
 assert.equal(readWorkspaceBackupSchemaVersion(f.store.db),version);
}
function retained(f:Pick<ReturnType<typeof fixture>,'store'>){
 const tables=['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2'] as const;
 return Object.fromEntries(tables.map(table=>[table,f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function restorationMetadata(){return {restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()};}

for(const version of [52,54,56] as const)test(`existing schema${version} stores retry receipts and superseded evidence without adding schema objects`,async t=>{
 const f=fixture(t);sourceProfile(f,version);
 assert.equal(agentTaskChangeSchema.parse(f.change).status,'superseded');
 assert.equal(f.journal.lookupControl(f.request.requestId)?.action,'retry');
 const original=retained(f),catalog=f.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,version);
 assert.deepEqual(f.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),catalog);
 f.close();
 const captured=await createWorkspaceBackup({source:f.root,destination:f.root+'-backup'});
 assert.equal(captured.databaseSchemaVersion,version);assert.deepEqual(await verifyWorkspaceBackup({directory:f.root+'-backup'}),captured);
 const restored=await restoreWorkspaceBackup({directory:f.root+'-backup',destination:f.root+'-restored'});
 assert.equal(restored.sourceSchema,version);assert.equal(restored.databaseSchemaVersion,version+1);
 const copy=openStore(f.root+'-restored');
 try{
  assert.deepEqual(classifyCurrentWorkspaceSchema(copy.db),{schemaVersion:version+1,profile:`restored-local-v${version===52?15:version===54?16:17}`});
  assert.deepEqual(retained({store:copy}),original);
  const journal=createAgentTaskJournal(copy),snapshot=journal.snapshot(f.run.id);
  assert.equal(snapshot.changes[0]?.status,'superseded');assert.equal(journal.lookupControl(f.request.requestId)?.action,'retry');
  assert.deepEqual(journal.step(f.model.id).data,{retryRequested:true,toolsInvalidated:true});
  assert.ok(snapshot.changes.every(change=>!Object.hasOwn(change,'modifiedAfter')&&!Object.hasOwn(change,'undoDisposition')));
  assert.throws(()=>journal.performControl({...f.request,requestId:randomUUID(),expectedRevision:snapshot.run.revision},()=>null),/RESTORE_OPERATION_UNAVAILABLE|RESTORED_RECORD_HELD/u);
  assert.deepEqual(retained({store:copy}),original);
 }finally{copy.close();}
});

const projections=[['modifiedAfter',false],['modifiedAfter',true],['undoDisposition','undo'],['undoDisposition','retain'],['undoDisposition','blocked']] as const;
for(const version of [52,54,56] as const)for(const [field,value] of projections)test(`schema${version} refuses persisted ${field}=${value} without altering its original evidence`,t=>{
 const f=fixture(t);sourceProfile(f,version);
 const original=retained(f),markers=f.store.db.prepare('SELECT version FROM schema_version ORDER BY version').all();
 f.store.db.prepare('UPDATE agent_task_changes_v2 SET data=json_set(data,?,json(?)) WHERE id=?').run(`$.${field}`,JSON.stringify(value),f.change.id);
 const polluted=retained(f);
 assert.throws(()=>classifyCurrentWorkspaceSchema(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>readWorkspaceBackupSchemaVersion(f.store.db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
 assert.throws(()=>installCurrentWorkspaceRestoreSchema(f.store.db,restorationMetadata()),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(retained(f),polluted);assert.deepEqual(f.store.db.prepare('SELECT version FROM schema_version ORDER BY version').all(),markers);
 assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workspace_restoration'").get(),undefined);
 f.store.db.prepare('UPDATE agent_task_changes_v2 SET data=json_remove(data,?) WHERE id=?').run(`$.${field}`,f.change.id);
 assert.deepEqual(retained(f),original);assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,version);
});

test('public M5 undo projections are optional and never need persisted fields',t=>{
 const f=fixture(t),saved=f.journal.snapshot(f.run.id),before=retained(f);
 assert.deepEqual(agentTaskSnapshotSchema.parse(saved),saved);
 for(const undoDisposition of ['undo','retain','blocked'] as const)for(const modifiedAfter of [false,true]){
  const change={...saved.changes[0]!,modifiedAfter,undoDisposition},response=agentTaskSnapshotSchema.parse({...saved,changes:[change]});
  assert.deepEqual(response.changes,[change]);assert.deepEqual(retained(f),before);
 }
 assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,56);
});
