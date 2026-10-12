import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {schemas,isWorkspaceRestoreInspection,isEditTaskEnvelope,isEditTaskListEnvelope} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.mjs';
import {installWorkspaceRestoreSchema,getWorkspaceRestoreContext} from '../packages/business/src/workspace-restore-schema.mjs';
import {RESTORE_READ_OPERATIONS,RESTORE_LOCAL_OPERATIONS,RESTORE_DENIED_OPERATIONS,assertWorkspaceRestoreOrigin,refuseRestoredOperation} from '../packages/business/src/workspace-restore-policy.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {createImageServices} from '../packages/business/src/images.mjs';
import {createFrameServices} from '../packages/business/src/frames.mjs';
import {createWaveformServices} from '../packages/business/src/waveforms.mjs';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.mjs';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.mjs';
import {createImageReviewServices} from '../packages/business/src/images/reviews.mjs';
import {createComfyRemoteServices} from '../packages/business/src/comfy/remote.mjs';
import {createTimelineServices} from '../packages/business/src/timeline.mjs';
import {createReferenceServices} from '../packages/business/src/references.mjs';
import {createMutationReplay} from '../packages/business/src/mutation-replay.mjs';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.mjs';
import {createTimelinePreflightServices} from '../packages/business/src/timeline-preflight.mjs';
import {createTimelineExportAdmissionServices} from '../packages/business/src/timeline-export-admission.mjs';
import {startServer} from '../apps/server/src/index.mjs';
import {callObservedRpc} from '../apps/server/src/rpc-observation.mjs';
import {request,TASK_TOKEN} from './helpers/edit-tasks-http-fixture.mjs';
import {EventEmitter} from 'node:events';

const isCode=code=>error=>error?.code===code;
const tables=['projects','jobs','exports','edit_tasks','timelines','timeline_requests','timeline_history','timeline_history_cursors','workspace_restore_holds'];
const snapshot=db=>JSON.stringify(Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
async function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-restore-execution-'));
 let store=openStore(root),services=createServices(store,new Map()),tasks=createEditTasks({store,services});
 const project=await services.call('project.create',{name:'Restored empty project'});
 const edited=await services.call('project.create',{name:'Restored receipt project'});
 const timeline=await services.call('timeline.get',{projectId:edited.id});
 const input={projectId:edited.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio'};
 const response=await services.call('timeline.track.add',input);
 const pending=tasks.prepare({projectId:project.id,operation:'timeline.track.add',input:{projectId:project.id,expectedRevision:1,requestId:randomUUID(),kind:'audio'},origin:'new'});
 const now=new Date().toISOString();
 for(const status of ['queued','submitting','running','downloading','submission_unknown','succeeded','failed','cancelled'])store.put('jobs',{id:randomUUID(),projectId:project.id,status,providerId:'mock',snapshot:{},revision:1,createdAt:now,updatedAt:now});
 for(const status of ['queued','running','succeeded','failed'])store.put('exports',{id:randomUUID(),projectId:project.id,requestId:randomUUID(),status,snapshot:[],orderedVersionIds:[],createdAt:now,updatedAt:now});
 await tasks.drain();await services.drain();store.close();
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:now};
 try{installWorkspaceRestoreSchema(db,metadata);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
 store=openStore(root);services=createServices(store,new Proxy(new Map(),{get(){throw Error('Restored construction inspected a provider');}}));tasks=createEditTasks({store,services});
 t.after(async()=>{await tasks.drain();await services.drain();if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,tasks,project,edited,input,response,pending,metadata};
}

test('restored profile has fixed catalogue coverage with no hint-based or suffix-based authority',()=>{
 const names=[...RESTORE_READ_OPERATIONS,...RESTORE_LOCAL_OPERATIONS,...RESTORE_DENIED_OPERATIONS];
 assert.equal(new Set(names).size,names.length);
 assert.deepEqual([...names].sort(),Object.keys(schemas).sort());
});

test('restored composition and automatic/manual workers leave all captured rows exact',async t=>{
 const f=await fixture(t),before=snapshot(f.store.db),changes=f.store.db.prepare('SELECT total_changes() n').get().n;
 const bomb=()=>{throw Error('Disabled runtime was entered');};
 const constructorCalls=[()=>createImageServices(f.store,{generate:bomb}),()=>createFrameServices(f.store,{decode:bomb}),
  ()=>createWaveformServices(f.store,{decode:bomb,probe:bomb}),()=>createChatRuntime({store:f.store,agentSettings:{get:bomb},gateway:bomb}),
  ()=>createAgentEditService({store:f.store,services:f.services}),()=>createImageReviewServices(f.store,{getSettings:bomb}),
  ()=>createComfyRemoteServices(f.store,{owner:bomb})];
 for(const construct of constructorCalls)assert.throws(construct,isCode('RESTORE_OPERATION_UNAVAILABLE'));
 const worker=startWorker(f.store,new Proxy({},{get:bomb}),new Proxy({},{get:bomb}));
 await worker.tick();await worker.tick();await worker.stop();
 assert.deepEqual(f.tasks.reconcileStartup(),{processed:0,unavailable:0});
 assert.equal(await f.services.call('timeline.get',{projectId:f.project.id}),null);
 assert.equal((await f.services.call('project.get',{projectId:f.project.id})).timeline,null);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM timelines WHERE projectId=?').get(f.project.id).n,0);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(snapshot(f.store.db),before);
 const inspection=await f.services.call('workspace.restore.inspect',{});
 assert.ok(isWorkspaceRestoreInspection(inspection));assert.equal(inspection.workspaceOrigin,f.metadata.workspaceOrigin);
 assert.equal(inspection.backupCreate.available,false);
});

test('captured task reads stay exact, pending lanes exclude holds, all state-changing entries refuse',async t=>{
 const f=await fixture(t),before=snapshot(f.store.db),context={expectedWorkspaceOrigin:f.metadata.workspaceOrigin};
 const existing=f.tasks.get({projectId:f.project.id,taskId:f.pending.task.id});
 assert.ok(isEditTaskEnvelope(existing));assert.deepEqual(existing.task,f.pending.task);assert.equal(existing.restore.executionEpoch,'captured');assert.equal(existing.restore.held,true);
 const active=f.tasks.list({projectId:f.project.id}),history=f.tasks.list({projectId:f.project.id,pendingOnly:false});
 assert.ok(isEditTaskListEnvelope(active));assert.equal(active.items.length,0);assert.ok(isEditTaskListEnvelope(history));assert.equal(history.items.length,1);assert.equal(history.restore.tasks[0].held,true);
 const action={projectId:f.project.id,taskId:existing.task.id,digest:existing.task.digest};
 await assert.rejects(f.tasks.execute({...action,instanceId:existing.instanceId},context),isCode('RESTORED_RECORD_HELD'));
 assert.throws(()=>f.tasks.reconcile(action,context),isCode('RESTORED_RECORD_HELD'));
 for(const projectId of [f.edited.id,randomUUID()])assert.throws(()=>f.tasks.reconcile({...action,projectId},context),isCode('EDIT_TASK_NOT_FOUND'));
 assert.throws(()=>f.tasks.reconcile({...action,digest:'0'.repeat(64)},context),isCode('EDIT_TASK_CONFLICT'));
 assert.throws(()=>f.tasks.reconcile({...action,extra:true},context),isCode('EDIT_TASK_VALIDATION'));
 assert.throws(()=>f.tasks.acknowledge({...action,expectedRevision:1,status:'applied'},context),isCode('RESTORED_RECORD_HELD'));
 assert.throws(()=>f.tasks.prepare({projectId:f.project.id,operation:'timeline.track.add',input:existing.task.input,origin:'new'},context),isCode('RESTORED_RECORD_HELD'));
 for(const [options,code] of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']]){
  await assert.rejects(f.services.call('project.create',{name:'No new effect'},options),isCode(code));
 }
 await assert.rejects(f.services.call('timeline.track.add',existing.task.input,context),isCode('RESTORED_RECORD_HELD'));
 for(const name of ['createJob','saveJob','event','saveGenerationGuarded','validateGenerationDispatch','updateShotInProject','moveTimelineClipInProject','imageApproval','imageRejection'])assert.throws(()=>f.services[name]({},context),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.equal(snapshot(f.store.db),before);
});

test('exact saved timeline acknowledgement is read without origin, mutation, or worker dispatch',async t=>{
 const f=await fixture(t),before=snapshot(f.store.db),receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response;
 assert.deepEqual(await f.services.call('timeline.track.add',f.input),f.response);
 await assert.rejects(f.services.call('timeline.track.add',{...f.input,kind:'video'}),isCode('IDEMPOTENCY_CONFLICT'));
 assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response,receipt);
 assert.equal(snapshot(f.store.db),before);
 assert.throws(()=>getWorkspaceRestoreContext({...f.store}),isCode('RESTORE_STORE_UNVERIFIED'));
 assert.throws(()=>assertWorkspaceRestoreOrigin(f.store),isCode('RESTORE_WORKSPACE_ORIGIN_REQUIRED'));
 assert.throws(()=>assertWorkspaceRestoreOrigin(f.store,{expectedWorkspaceOrigin:f.metadata.workspaceOrigin+'\n'}),isCode('RESTORE_WORKSPACE_ORIGIN_REQUIRED'));
 assert.throws(()=>assertWorkspaceRestoreOrigin(f.store,{expectedWorkspaceOrigin:randomUUID()}),isCode('RESTORE_WORKSPACE_ORIGIN_MISMATCH'));
 assert.equal(assertWorkspaceRestoreOrigin(f.store,{expectedWorkspaceOrigin:f.metadata.workspaceOrigin}).workspaceOrigin,f.metadata.workspaceOrigin);
});

test('restored server skips settings/runtime constructors and special routes share safe refusal',async t=>{
 const f=await fixture(t),before=snapshot(f.store.db);await f.tasks.drain();await f.services.drain();f.store.close();
 let server;const bomb=()=>{throw Error('Forbidden restored startup dependency');};
 try{
  server=await startServer({dataDir:f.root,port:0,token:TASK_TOKEN,agentSettings:{get:bomb,put:bomb,close:bomb},imageSecretCodec:{storage:bomb},imageNetwork:{request:bomb},comfyNetwork:{httpRequest:bomb},chatGateway:bomb});
  for(const directory of ['agent-settings','image-settings','comfy-settings'])assert.equal(existsSync(path.join(f.root,directory)),false);
  for(const [route,method] of [['/api/agent/settings','GET'],['/api/agent/settings','PUT'],['/api/images/settings','GET'],['/api/images/custom-settings','PUT'],['/api/images/comfy-settings','GET'],['/api/images/comfy-check','POST'],['/api/images/reviews/approve','POST'],['/api/images/reviews/reject','POST'],[`/api/agent/chat/${f.project.id}/runs`,'POST']]){
   const result=await request(server.url,route,{method,input:method==='GET'?undefined:{expectedWorkspaceOrigin:f.metadata.workspaceOrigin}});
   assert.equal(result.status,409,route);assert.equal(result.body.error.code,'RESTORE_OPERATION_UNAVAILABLE',route);assert.deepEqual(result.body.error.details,{});
  }
  const denied=await request(server.url,'/api/rpc',{method:'POST',input:{operation:'project.create',input:{name:'No'}}});
  assert.equal(denied.body.error.code,'RESTORE_WORKSPACE_ORIGIN_REQUIRED');
  const held=await request(server.url,`/api/tasks/${f.pending.task.id}/reconcile`,{method:'POST',input:{projectId:f.project.id,digest:f.pending.task.digest,expectedWorkspaceOrigin:f.metadata.workspaceOrigin}});
  assert.equal(held.status,409);assert.equal(held.body.error.code,'RESTORED_RECORD_HELD');
  assert.equal((await request(server.url,'/api/agent/settings',{authenticated:false})).status,401);
 }finally{await server?.close();}
 const reopened=openStore(f.root);try{assert.equal(snapshot(reopened.db),before);}finally{reopened.close();}
});

test('RPC carries the caller origin separately and never stamps an origin on ordinary requests',async()=>{
 const calls=[],services={call:async(...args)=>{calls.push(args);return {};}};
 const req=new EventEmitter(),res=new EventEmitter();res.writableFinished=false;res.destroyed=false;
 await callObservedRpc(req,res,services,'project.create',{name:'normal'});
 assert.deepEqual(calls.pop(),['project.create',{name:'normal'},{}]);
 const expectedWorkspaceOrigin=randomUUID();
 await callObservedRpc(req,res,services,'timeline.export.preflight',{projectId:randomUUID(),expectedRevision:1},{expectedWorkspaceOrigin});
 const args=calls.pop();assert.equal(args[2].expectedWorkspaceOrigin,expectedWorkspaceOrigin);assert.ok(args[2].signal instanceof AbortSignal);assert.equal(Object.hasOwn(args[1],'expectedWorkspaceOrigin'),false);
});

test('direct shared local mutation and export-compute boundaries cannot bypass pinned admission',async t=>{
 const f=await fixture(t),before=snapshot(f.store.db),bomb=()=>{throw Error('Forbidden effect');};
 const jobId=f.store.db.prepare('SELECT id FROM jobs LIMIT 1').get().id;
 assert.throws(()=>refuseRestoredOperation(f.store,'job.cancel',{jobId,projectId:f.project.id}),isCode('RESTORED_RECORD_HELD'));
 for(const projectId of [f.edited.id,randomUUID()])assert.throws(()=>refuseRestoredOperation(f.store,'job.cancel',{jobId,projectId}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>refuseRestoredOperation(f.store,'job.cancel',{jobId:randomUUID(),projectId:f.project.id}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>refuseRestoredOperation(f.store,'__proto__',{undefined:'bad'}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 const timeline=createTimelineServices(f.store,{required:f.services.required,check:bomb,hash:bomb,now:bomb,exportAdmission:{render:bomb}});
 assert.throws(()=>timeline.ensure(f.project.id),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>timeline.handlers['timeline.track.add'](f.pending.task.input),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>timeline.handlers['timeline.render']({...f.input,purpose:'export',exportSettings:{}}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>createReferenceServices(f.store,{check:bomb,hash:bomb,now:bomb}).handlers['reference.attach']({}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>createMutationReplay(f.store,{canonical:bomb})('shot.create',{},{resolve:bomb,apply:bomb}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 assert.throws(()=>createWorkspacePreferences(f.store).put(f.project.id,{}),isCode('VALIDATION_ERROR'));
 const preflight=createTimelinePreflightServices(f.store,{probe:bomb}),admission=createTimelineExportAdmissionServices(f.store,{inspect:bomb,hash:bomb});
 try{
  await assert.rejects(preflight.handlers['timeline.export.preflight']({}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
  await assert.rejects(admission.handlers['timeline.export.capabilities']({}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
  await assert.rejects(admission.inspect({}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
  await assert.rejects(admission.render({}, {}, {prepare:bomb,accept:bomb}),isCode('RESTORE_OPERATION_UNAVAILABLE'));
 }finally{await preflight.drain();await admission.drain();}
 assert.equal(snapshot(f.store.db),before);
});
