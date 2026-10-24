import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {validateAgentInteractionRowsV2} from '../packages/business/src/agent/task-interaction-schema-v2.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {initializeWorkspaceSchema56} from '../packages/business/src/workspace-schema-v56.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {classifyWorkspaceSchemaV54V55} from '../packages/business/src/workspace-restore-schema-v55.ts';
import {removeReviewedSchema56,currentOrdinary56Delta,withoutReviewedInteractionObjects} from './helpers/current-schema56-delta.ts';
import {removeReviewedSchema58} from './helpers/current-schema58-delta.ts';
import {agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskRun,AgentTaskNote,AgentTaskSkippedTarget} from '../packages/contracts/src/agent-tasks-v2.ts';

function fixture(){const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-interaction-schema-')),store=openStore(root),projectId=randomUUID();store.put('projects',{id:projectId,name:'Interaction schema',revision:1});const journal=createAgentTaskJournal(store);const run=journal.create({requestId:randomUUID(),projectId,text:'Preserved original',configuration:{protocol:'responses'},context:[{role:'user',content:'retained context'}]}).run;return {root,store,projectId,journal,run,close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function write(f:ReturnType<typeof fixture>,patch:Partial<AgentTaskRun>){const value={...f.journal.run(f.run.id),...patch};f.store.db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(JSON.stringify(value),f.run.id);}
const note=(modelStepId?:string):AgentTaskNote=>({requestId:randomUUID(),text:'Additional instruction',createdAt:'2020-01-01T00:00:00.000Z',...(modelStepId?{modelStepId}:{})});
function evidence(f:ReturnType<typeof fixture>){const one=f.journal.beginStep(f.run.id,{kind:'model'}),two=f.journal.beginStep(f.run.id,{kind:'model'}),target={kind:'shot',id:randomUUID(),revision:9},tool=f.journal.beginStep(f.run.id,{kind:'tool',targets:[{...target,revision:1}],data:{conflictTargets:[target]}});return {one,two,target,tool};}

const display={operation:'shot.update',targets:[],targetCount:0,fields:[]};
function changeEvidence(f:ReturnType<typeof fixture>){const step=f.journal.beginStep(f.run.id,{kind:'tool'});f.journal.markDispatch(f.run.id,step.id);f.journal.completeStep(f.run.id,step.id,{result:{done:true},change:{projectId:f.projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:false}});return f.journal.snapshot(f.run.id);}
function sourceSchema(f:ReturnType<typeof fixture>,version:52|54|56|58){
 if(version===56)removeReviewedSchema58(f.store.db);
 if(version<56)removeReviewedSchema56(f.store.db);
 if(version===52)f.store.db.exec("DROP INDEX agent_task_conversation_v2;DROP TRIGGER agent_task_conversation_identity_v2;DROP TRIGGER agent_task_conversation_required_v2;UPDATE agent_task_runs_v2 SET data=json_remove(data,'$.conversationId');DELETE FROM schema_version WHERE version=54");
 assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:version,profile:'ordinary'});
}
function restoreMetadata(){return {restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()};}

for(const version of [52,54,56,58] as const)for(const family of ['step','change'] as const)test(`schema${version} rejects persisted ${family} display during classification and restore admission`,()=>{const f=fixture();try{
 const snapshot=changeEvidence(f),table=family==='step'?'agent_task_steps_v2':'agent_task_changes_v2',id=family==='step'?snapshot.steps[0]!.id:snapshot.changes[0]!.id;sourceSchema(f,version);
 const markers=f.store.db.prepare('SELECT version FROM schema_version ORDER BY version').all();
 f.store.db.prepare(`UPDATE ${table} SET data=json_set(data,'$.display',json(?)) WHERE id=?`).run(JSON.stringify(display),id);
 const polluted=f.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data;
 assert.throws(()=>classifyCurrentWorkspaceSchema(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>installCurrentWorkspaceRestoreSchema(f.store.db,restoreMetadata()),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.equal(f.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data,polluted);assert.deepEqual(f.store.db.prepare('SELECT version FROM schema_version ORDER BY version').all(),markers);assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workspace_restoration'").get(),undefined);
 f.store.db.prepare(`UPDATE ${table} SET data=json_remove(data,'$.display') WHERE id=?`).run(id);
 const restored=installCurrentWorkspaceRestoreSchema(f.store.db,restoreMetadata());assert.equal(restored.sourceSchema,version);assert.equal(restored.schemaVersion,version+1);assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,version+1);
}finally{f.close();}});

test('public snapshots accept Step and Change display without changing persistent records',()=>{const f=fixture();try{
 const snapshot=changeEvidence(f),response=agentTaskSnapshotSchema.parse({...snapshot,steps:snapshot.steps.map(step=>({...step,display})),changes:snapshot.changes.map(change=>({...change,display}))});
 assert.deepEqual(response.steps[0]!.display,display);assert.deepEqual(response.changes[0]!.display,display);assert.deepEqual(f.journal.snapshot(f.run.id),snapshot);assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:58,profile:'ordinary'});
}finally{f.close();}});

test('ordinary54 migrates only interaction defaults while preserving original digests, context, events and arbitrary legacy receipts',()=>{const f=fixture();try{
 for(const action of ['note','skip','legacy-extension'])f.journal.performControl({requestId:randomUUID(),runId:f.run.id,expectedRevision:f.journal.run(f.run.id).revision,action},()=>({state:'rejected',legacy:true}));
 removeReviewedSchema56(f.store.db);assert.deepEqual(classifyWorkspaceSchemaV54V55(f.store.db),{schemaVersion:54,profile:'ordinary'});
 const before=f.store.db.prepare('SELECT * FROM agent_task_runs_v2').get()!,data=JSON.parse(String(before.data)),events=f.store.db.prepare('SELECT * FROM agent_task_events_v2 ORDER BY rowid').all(),receipts=f.store.db.prepare('SELECT * FROM agent_task_controls_v2 ORDER BY rowid').all();
 initializeWorkspaceSchema56(f.store.db,initializeWorkspaceSchemaThrough24);assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:56,profile:'ordinary'});
 const after=f.store.db.prepare('SELECT * FROM agent_task_runs_v2').get()!;assert.deepEqual({...after,data:undefined},{...before,data:undefined});assert.deepEqual(JSON.parse(String(after.data)),{...data,notes:[],skippedTargets:[]});assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_task_events_v2 ORDER BY rowid').all(),events);assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_task_controls_v2 ORDER BY rowid').all(),receipts);
}finally{f.close();}});

test('interaction migration failure rolls back default rows, DDL and marker together',()=>{const f=fixture();try{
 removeReviewedSchema56(f.store.db);const before=f.store.db.prepare('SELECT data FROM agent_task_runs_v2').get()!.data,exec=f.store.db.exec.bind(f.store.db);let injected=false;
 f.store.db.exec=(sql:string)=>{if(!injected&&sql.includes('CREATE TRIGGER agent_task_interaction_insert_v2')){injected=true;throw Error('synthetic DDL write failure');}return exec(sql);};
 assert.throws(()=>initializeWorkspaceSchema56(f.store.db,initializeWorkspaceSchemaThrough24),/synthetic DDL write failure/u);f.store.db.exec=exec;assert.equal(injected,true);assert.equal(f.store.db.prepare('SELECT data FROM agent_task_runs_v2').get()!.data,before);assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB 'agent_task_interaction_*'").get(),undefined);assert.equal(f.store.db.prepare('SELECT 1 FROM schema_version WHERE version=56').get(),undefined);assert.deepEqual(classifyWorkspaceSchemaV54V55(f.store.db),{schemaVersion:54,profile:'ordinary'});
}finally{f.close();}});

test('schema56 validates exact interaction SQL and frozen54 never accepts new metadata',()=>{const f=fixture();try{
 const objects=f.store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'agent_task_interaction_*' ORDER BY type,name").all() as unknown as typeof currentOrdinary56Delta.objects;assert.deepEqual(withoutReviewedInteractionObjects(objects),[]);
 removeReviewedSchema56(f.store.db);write(f,{notes:[],skippedTargets:[]});assert.throws(()=>classifyWorkspaceSchemaV54V55(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}finally{f.close();}});

test('notes and skipped targets keep append-only evidence while binding unconsumed notes once',()=>{const f=fixture();try{
 const {one,two,target,tool}=evidence(f),first=note();write(f,{notes:[first],skippedTargets:[{target,stepId:tool.id,createdAt:first.createdAt}]});write(f,{notes:[{...first,modelStepId:one.id}]});validateAgentInteractionRowsV2(f.store.db);
 for(const patch of [{notes:[]},{notes:[{...first,modelStepId:two.id}]},{notes:[{...first,text:'rewritten',modelStepId:one.id}]},{skippedTargets:[]}])assert.throws(()=>write(f,patch),/interaction evidence is immutable/u);
 assert.throws(()=>write(f,{notes:Array.from({length:6},()=>note())}),/interaction (?:arrays are required|evidence is immutable)/u);
 assert.equal(f.journal.run(f.run.id).notes?.[0]?.modelStepId,one.id);
}finally{f.close();}});

test('valid interaction order survives wall-clock rollback and restored59 retains it read-only',()=>{const f=fixture();try{
 const {one,two,target,tool}=evidence(f),notes=[note(one.id),note(two.id),note()],skippedTargets=[{target,stepId:tool.id,createdAt:'2019-01-01T00:00:00.000Z'}];write(f,{notes,skippedTargets});validateAgentInteractionRowsV2(f.store.db);assert.ok(notes[0]!.createdAt<f.run.createdAt);
 const info=installCurrentWorkspaceRestoreSchema(f.store.db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});assert.equal(info.schemaVersion,59);assert.equal(info.sourceSchema,58);assert.deepEqual(f.journal.run(f.run.id).notes,notes);assert.deepEqual(f.journal.run(f.run.id).skippedTargets,skippedTargets);assert.throws(()=>write(f,{text:'must remain held'}),/RESTORED_RECORD_HELD/u);
}finally{f.close();}});

for(const kind of ['missing arrays','six pending','duplicate note','foreign model','tool as model','reverse model order','pending before consumed','duplicate skipped target','model as skipped step','foreign skipped step','missing conflict target','invalid conflict target','missing step target','invalid note timestamp','invalid skip timestamp'] as const)test(`schema56 rejects corrupt ${kind} metadata before recovery`,()=>{const f=fixture();try{
 const {one,two,target,tool}=evidence(f),otherProject=randomUUID();f.store.put('projects',{id:otherProject,name:'Other',revision:1});const foreign=f.journal.create({requestId:randomUUID(),projectId:otherProject,text:'Foreign run',configuration:{}}).run,foreignModel=f.journal.beginStep(foreign.id,{kind:'model'}),foreignTool=f.journal.beginStep(foreign.id,{kind:'tool',targets:[target],data:{conflictTargets:[target]}});
 let notes:AgentTaskNote[]=[note(one.id)],skippedTargets:AgentTaskSkippedTarget[]=[{target,stepId:tool.id,createdAt:'2020-01-01T00:00:00.000Z'}];
 if(kind==='six pending')notes=Array.from({length:6},()=>note());if(kind==='duplicate note'){const value=note();notes=[value,{...value}];}if(kind==='foreign model')notes=[note(foreignModel.id)];if(kind==='tool as model')notes=[note(tool.id)];if(kind==='reverse model order')notes=[note(two.id),note(one.id)];if(kind==='pending before consumed')notes=[note(),note(one.id)];if(kind==='duplicate skipped target')skippedTargets.push({...skippedTargets[0]!});if(kind==='model as skipped step')skippedTargets[0]!.stepId=one.id;if(kind==='foreign skipped step')skippedTargets[0]!.stepId=foreignTool.id;if(kind==='invalid note timestamp')notes[0]!.createdAt='not an ISO time';if(kind==='invalid skip timestamp')skippedTargets[0]!.createdAt='not an ISO time';
 if(kind==='missing conflict target')f.journal.updateStep(f.run.id,tool.id,{data:{conflictTargets:[]}});if(kind==='invalid conflict target')f.journal.updateStep(f.run.id,tool.id,{data:{conflictTargets:[{kind:target.kind,id:target.id}]}});if(kind==='missing step target')f.journal.updateStep(f.run.id,tool.id,{targets:[]});
 f.store.db.exec('DROP TRIGGER agent_task_interaction_update_v2');write(f,{notes,skippedTargets});if(kind==='missing arrays')f.store.db.prepare("UPDATE agent_task_runs_v2 SET data=json_remove(data,'$.notes') WHERE id=?").run(f.run.id);assert.throws(()=>validateAgentInteractionRowsV2(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
}finally{f.close();}});


test('offline58 backup restores59 with exact note bindings, skipped targets, receipts and events, without recovery dispatch',async()=>{const f=fixture(),backup=f.root+'-backup',restored=f.root+'-restored';try{
 const requestId=randomUUID(),input={requestId,runId:f.run.id,expectedRevision:f.journal.run(f.run.id).revision,action:'note',text:'Keep this local choice'};
 f.journal.performControl(input,()=>{f.journal.appendNoteInside(f.run.id,requestId,input.text);return {state:'completed',noteRequestId:requestId};});
 const model=f.journal.beginModelStep(f.run.id,{request:{messages:[]}},[requestId]);f.journal.completeStep(f.run.id,model.id,{result:{done:true}});
 const target={kind:'shot',id:randomUUID(),revision:2},tool=f.journal.beginStep(f.run.id,{kind:'tool',targets:[target],data:{conflictTargets:[target]}});f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'paused','conflict');
 f.journal.performControl({requestId:randomUUID(),runId:f.run.id,expectedRevision:f.journal.run(f.run.id).revision,action:'skip'},()=>{f.journal.skipTargetsInside(f.run.id,[{stepId:tool.id,target}]);return {state:'completed',skippedTargets:[{kind:target.kind,id:target.id}]};});
 const before=f.journal.snapshot(f.run.id),events=f.journal.events(f.run.id),receipts=f.store.db.prepare('SELECT * FROM agent_task_controls_v2 ORDER BY rowid').all();f.store.close();
 const captured=await createWorkspaceBackup({source:f.root,destination:backup});assert.equal(captured.databaseSchemaVersion,58);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),captured);assert.equal((await restoreWorkspaceBackup({directory:backup,destination:restored})).databaseSchemaVersion,59);
 const copy=openStore(restored);try{const journal=createAgentTaskJournal(copy);assert.deepEqual(journal.snapshot(f.run.id),before);assert.deepEqual(journal.events(f.run.id),events);assert.deepEqual(copy.db.prepare('SELECT * FROM agent_task_controls_v2 ORDER BY rowid').all(),receipts);assert.throws(()=>journal.resume(f.run.id,before.run.revision),/RESTORED_RECORD_HELD/u);}finally{copy.close();}
}finally{f.close();rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}});


test('later background conflicts may append a skip originating from an earlier tool position',()=>{const f=fixture();try{
 const earlier={kind:'shot',id:randomUUID(),revision:1},later={kind:'shot',id:randomUUID(),revision:3};
 const first=f.journal.beginStep(f.run.id,{kind:'tool',targets:[earlier],data:{conflictTargets:[earlier]}}),second=f.journal.beginStep(f.run.id,{kind:'tool',targets:[later],data:{conflictTargets:[later]}});
 for(const step of [first,second]){f.journal.markDispatch(f.run.id,step.id);f.journal.completeStep(f.run.id,step.id,{result:{queued:true}});}
 const skips:AgentTaskSkippedTarget[]=[{target:later,stepId:second.id,createdAt:'2026-10-22T00:00:00.000Z'},{target:earlier,stepId:first.id,createdAt:'2026-10-22T00:01:00.000Z'}];write(f,{skippedTargets:skips});validateAgentInteractionRowsV2(f.store.db);assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:58,profile:'ordinary'});
 assert.equal(installCurrentWorkspaceRestoreSchema(f.store.db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()}).schemaVersion,59);assert.deepEqual(f.journal.run(f.run.id).skippedTargets,skips);
}finally{f.close();}});
