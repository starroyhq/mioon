import {downgradeReviewedWorkspace} from './helpers/reviewed-schema-layers.ts';
import {CURRENT_ORDINARY_ROLE} from './helpers/workspace-schema-current.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,installCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema,getWorkspaceRestoreContext,type WorkspaceStore} from '../packages/business/src/db.ts';
import {initializeWorkspaceSchema60} from '../packages/business/src/workspace-schema-v60.ts';
import {initializeWorkspaceSchema58 as initializePrivateStorage58} from '../packages/business/src/workspace-storage-schema-v58.ts';
import {validateWorkspaceSchema58} from '../packages/business/src/workspace-schema-v58.ts';
import {installWorkspaceRestoreSchemaV59 as installPrivateRestore59} from '../packages/business/src/workspace-storage-restore-schema-v59.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {readAgentTaskStorage} from '../packages/business/src/agent/task-storage-v2.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createRestoredReadServices} from '../packages/business/src/workspace-restore-read.ts';
import {refuseRestoredOperation} from '../packages/business/src/workspace-restore-policy.ts';
import {readTimelineAudioRoleCapability} from '../packages/business/src/timeline-audio-role-business.ts';
import {workspaceRestoreInspectionSchema} from '../packages/contracts/src/workspace-restore.ts';

const historyTables=['agent_task_runs_v2','agent_task_steps_v2','agent_task_changes_v2','agent_task_events_v2','agent_task_controls_v2','agent_task_control_states_v2','agent_task_policy_v2','agent_task_policy_requests_v2','agent_task_edit_receipts_v2','agent_task_job_origins_v2','agent_task_imports_v2'];
function evidence(store:WorkspaceStore,tables=historyTables){return tables.map(table=>({table,rows:store.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()}));}
function fixture(t:TestContext,privateStorage=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mioon-storage-main-integration-')));let store=openStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 if(privateStorage){downgradeReviewedWorkspace(store.db,56);initializePrivateStorage58(store.db,initializeWorkspaceSchemaThrough24);}else downgradeReviewedWorkspace(store.db,58);
 const projectId=randomUUID(),date=new Date().toISOString();store.put('projects',{id:projectId,name:'Storage integration',revision:1,createdAt:date,updatedAt:date});
 const journal=createAgentTaskJournal(store),run=journal.create({requestId:randomUUID(),projectId,text:'Preserve exact evidence',configuration:{protocol:'chat_completions'}}).run;
 const step=journal.beginStep(run.id,{kind:'model',request:{body:'{"messages":[{"role":"user","content":"synthetic"}]}',history:[{role:'user',content:'synthetic'}]}});
 journal.markDispatch(run.id,step.id);journal.completeStep(run.id,step.id,{result:{text:'Synthetic completion'}});
 return {root,projectId,run,step,get store(){return store;},reopen(){store.close();store=openStore(root);return store;}};
}
function metadata(){return {restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()};}

test('main scene58 keeps its64MiB inline profile, then migrates to60 without changing scene or agent evidence',async t=>{
 const f=fixture(t);assert.equal(readCurrentWorkspaceRole(f.store.db),'ordinary-58');validateWorkspaceSchema58(f.store.db);
 assert.equal(readAgentTaskStorage(f.store.db).limits.bytes,64*1024*1024);
 const bytes=Buffer.from('synthetic managed video'),assetId=randomUUID(),relativePath=`media/${assetId}.mp4`;writeFileSync(join(f.root,relativePath),bytes,{mode:0o600});
 const sha256=createHash('sha256').update(bytes).digest('hex');f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic.mp4',mimeType:'video/mp4',sha256,sizeBytes:bytes.length,relativePath,width:320,height:180,duration:3,provenance:'user-import'});
 const scenes=createSceneServices(f.store,{autoRun:false});await scenes.handlers['scene.detect']!({projectId:f.projectId,sourceAssetId:assetId,sourceHash:sha256,requestId:randomUUID()});
 const before=evidence(f.store,[...historyTables,'scene_tasks','scene_requests','scene_results']);
 initializeWorkspaceSchema60(f.store.db,initializeWorkspaceSchemaThrough24);
 assert.equal(readCurrentWorkspaceRole(f.store.db),'ordinary-60');assert.deepEqual(evidence(f.store,[...historyTables,'scene_tasks','scene_requests','scene_results']),before);
 assert.equal(readAgentTaskStorage(f.store.db).limits.bytes,256*1024*1024);
 f.reopen();assert.deepEqual(evidence(f.store,[...historyTables,'scene_tasks','scene_requests','scene_results']),before);
});

test('precisely classified private storage58 migrates request references unchanged and adds scene definitions',t=>{
 const f=fixture(t,true);assert.equal(readCurrentWorkspaceRole(f.store.db),'storage-private-58');
 const before=evidence(f.store);assert.ok(String(before.find(value=>value.table==='agent_task_events_v2')!.rows.at(-1)!.data).includes('mioon-model-request-ref/1'));
 f.reopen();assert.equal(readCurrentWorkspaceRole(f.store.db),CURRENT_ORDINARY_ROLE);assert.deepEqual(evidence(f.store),before);
 assert.deepEqual(f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'scene_*' ORDER BY name").all().map(row=>row.name),['scene_requests','scene_results','scene_tasks']);
 const hydrated=createAgentTaskJournal(f.store).events(f.run.id).filter(value=>value.type==='step');
 assert.deepEqual((hydrated.at(-1)!.data as {request:unknown}).request,f.step.request);
 assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_task_model_request_update_v58'").get(),undefined);
 assert.ok(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_task_model_request_update_v60'").get());
});

test('private storage59 remains its original read-only source58 identity and never acquires scene or edit capabilities',async t=>{
 const f=fixture(t,true),info=installPrivateRestore59(f.store.db,metadata()),before=evidence(f.store);
 f.reopen();assert.equal(readCurrentWorkspaceRole(f.store.db),'storage-private-59-evidence');assert.deepEqual(evidence(f.store),before);
 assert.equal(getWorkspaceRestoreContext(f.store)!.schemaVersion,59);assert.deepEqual(validateCurrentWorkspaceRestoreSchema(f.store.db),info);
 assert.equal(f.store.db.prepare('SELECT max(version) AS version FROM schema_version').get()!.version,59);
 assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_tasks'").get(),undefined);
 assert.equal(readTimelineAudioRoleCapability(f.store.db).editable,false);
 const services=createRestoredReadServices(f.store as unknown as Parameters<typeof createRestoredReadServices>[0]),inspection=await services.call('workspace.restore.inspect',{includeAudioRoleCapability:true,includeVolumeEnvelopeCapability:true} as Parameters<typeof services.call>[1]);
 assert.ok(workspaceRestoreInspectionSchema.safeParse(inspection).success);
 assert.equal((inspection as {profile:string}).profile,'restored-local-v18');assert.equal((inspection as {audioRoleCapability?:unknown}).audioRoleCapability,undefined);
 const policies=(inspection as {operationPolicy:{operation:string;available:boolean}[]}).operationPolicy;
 assert.ok(policies.filter(value=>value.operation.startsWith('scene.')).every(value=>!value.available));
 await assert.rejects(services.call('scene.task.list',{projectId:f.projectId} as Parameters<typeof services.call>[1]),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 assert.throws(()=>refuseRestoredOperation(f.store,'timeline.clip.add',{projectId:f.projectId,requestId:randomUUID()}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 const tasks=createEditTasks({store:f.store,services:{call:async()=>assert.fail('private restore must not dispatch effects')}} as Parameters<typeof createEditTasks>[0]);
 const editRows=f.store.db.prepare('SELECT * FROM edit_tasks ORDER BY rowid').all();
 assert.throws(()=>tasks.prepare({projectId:f.projectId,operation:'timeline.clip.add',origin:'new',input:{projectId:f.projectId,requestId:randomUUID()}},{expectedWorkspaceOrigin:info.workspaceOrigin}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 assert.deepEqual(f.store.db.prepare('SELECT * FROM edit_tasks ORDER BY rowid').all(),editRows);
 assert.deepEqual(evidence(f.store),before);
});

test('new combined60 restores only as61/v19 and preserves exact evidence through restored startup',t=>{
 const f=fixture(t),before=evidence(f.store);initializeWorkspaceSchema60(f.store.db,initializeWorkspaceSchemaThrough24);
 const info=installCurrentWorkspaceRestoreSchema(f.store.db,metadata());assert.equal(info.schemaVersion,61);assert.equal(info.sourceSchema,60);assert.equal(info.profile,'restored-local-v19');
 f.reopen();assert.equal(readCurrentWorkspaceRole(f.store.db),'restored-61-evidence');assert.deepEqual(evidence(f.store),before);
 assert.deepEqual(validateCurrentWorkspaceRestoreSchema(f.store.db),info);assert.equal(readAgentTaskStorage(f.store.db).limits.bytes,256*1024*1024);assert.equal(readTimelineAudioRoleCapability(f.store.db).editable,true);
});

test('main scene restore59 retains its original identity and scene capabilities without entering private storage migration',t=>{
 const f=fixture(t),before=evidence(f.store),info=installCurrentWorkspaceRestoreSchema(f.store.db,metadata());
 assert.equal(info.schemaVersion,59);assert.equal(info.sourceSchema,58);assert.equal(info.profile,'restored-local-v18');
 f.reopen();assert.equal(readCurrentWorkspaceRole(f.store.db),'restored-59-evidence');assert.deepEqual(evidence(f.store),before);
 assert.ok(f.store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_tasks'").get());
 assert.equal(readAgentTaskStorage(f.store.db).limits.bytes,64*1024*1024);assert.equal(readTimelineAudioRoleCapability(f.store.db).editable,true);
 assert.throws(()=>initializeWorkspaceSchema60(f.store.db,initializeWorkspaceSchemaThrough24),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(validateCurrentWorkspaceRestoreSchema(f.store.db),info);
});

test('a private58 marker with an incomplete immutable catalogue cannot acquire the combined60 role',t=>{
 const f=fixture(t,true);f.store.db.exec('DROP TRIGGER agent_task_model_request_update_v58');
 const before=evidence(f.store),schema=f.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 assert.throws(()=>readCurrentWorkspaceRole(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>initializeWorkspaceSchema60(f.store.db,initializeWorkspaceSchemaThrough24),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(evidence(f.store),before);assert.deepEqual(f.store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);
 assert.equal(f.store.db.prepare('SELECT max(version) AS version FROM schema_version').get()!.version,58);
});
