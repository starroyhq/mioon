import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';
import {createEditTasks,safeEditTaskError} from '../packages/business/src/edit-tasks.mjs';
import {DURABLE_EDIT_OPERATIONS,EDIT_TASK_LIMITS,isEditTaskEnvelope,isEditTaskListEnvelope,schemas} from '@mioon/contracts';

const code=name=>error=>error.code===name&&!JSON.stringify(error).includes('PRIVATE');
async function fixture(t,options={}) {
 const root=mkdtempSync(path.join(tmpdir(),'mioon-edit-tasks-'));
 let store=openStore(root),services=createServices(store,new Map()),tasks,calls=0,fault=()=>{},dispatch;
 const start=()=>{tasks=createEditTasks({store,services:{call(op,input){calls++;assert.equal(store.db.isTransaction,false);return dispatch?dispatch(op,input,services):services.call(op,input);}},fault:label=>fault(label),limits:options.limits});};start();
 const project=await services.call('project.create',{name:'Durable intent'}),other=await services.call('project.create',{name:'PRIVATE_OTHER'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const f={root,project,other,get store(){return store;},get services(){return services;},get tasks(){return tasks;},get calls(){return calls;},
  setFault(fn){fault=fn;},setDispatch(fn){dispatch=fn;},
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
  row(task){return store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(task.id);},
  request(task){return {projectId:task.projectId,taskId:task.id,digest:task.digest};},
  execute(envelope){return tasks.execute({...f.request(envelope.task),instanceId:envelope.instanceId});},
  ack(task){return tasks.acknowledge({...f.request(task),expectedRevision:task.revision,status:task.status});},
  prepare(operation,input,origin='new'){return tasks.prepare({projectId:project.id,operation,input,origin});},
  async track(fields={}){const timeline=await services.call('timeline.get',{projectId:project.id});return f.prepare('timeline.track.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio',...fields});},
  asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:project.id,name:'Fixture',mimeType:'video/mp4',duration:10,width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:new Date().toISOString(),...patch});},
  snapshot(){return JSON.stringify(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','timeline_requests','reference_requests','timeline_history','timeline_history_cursors'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
 };return f;
}

test('legacy FIRST12 prefix remains in the fifteen-operation scope; prepare is durable/noncreating and preserves duplicate identity',async t=>{
 const f=await fixture(t);assert.equal(DURABLE_EDIT_OPERATIONS.length,15);assert.equal(DURABLE_EDIT_OPERATIONS.includes('timeline.render'),false);
 f.store.db.prepare('DELETE FROM timelines WHERE projectId=?').run(f.project.id);
 const input={projectId:f.project.id,expectedRevision:1,requestId:randomUUID(),kind:'audio'},before=f.snapshot();
 const saved=f.prepare('timeline.track.add',input);assert.equal(saved.task.status,'prepared');assert.equal(f.snapshot(),before);assert.equal(f.calls,0);
 assert.deepEqual(saved.task.input,input);assert.equal(saved.task.digest,hash({operation:'timeline.track.add',input}));assert.ok(isEditTaskEnvelope(saved));
 assert.deepEqual(f.prepare('timeline.track.add',input),saved);
 assert.throws(()=>f.prepare('timeline.track.add',{...input,kind:'video'}),code('EDIT_TASK_CONFLICT'));
 assert.throws(()=>f.tasks.prepare({projectId:f.other.id,operation:'timeline.track.add',input:{...input,projectId:f.other.id},origin:'new'}),code('EDIT_TASK_CONFLICT'));
 assert.throws(()=>f.prepare('timeline.undo',input),code('EDIT_TASK_VALIDATION'));
 assert.throws(()=>f.prepare('timeline.track.add',{...input,requestId:randomUUID()}),code('EDIT_TASK_CONFLICT'));
 const writes=f.store.db.prepare('SELECT total_changes() n').get().n;
 f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.ok(isEditTaskListEnvelope(f.tasks.list({projectId:f.project.id})));
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,writes);assert.equal(f.snapshot(),before);
});

test('exact claims dispatch once across concurrent managers; no outer transaction; immutable terminal ACK',async t=>{
 const f=await fixture(t),saved=await f.track();let release;
 const wait=new Promise(resolve=>release=resolve);f.setDispatch(async(op,input,services)=>{assert.equal(f.row(saved.task).status,'dispatching');await wait;return services.call(op,input);});
 const first=f.execute(saved),second=createEditTasks({store:f.store,services:f.services});
 const duplicate=await second.execute({...f.request(saved.task),instanceId:saved.instanceId});assert.equal(duplicate.task.status,'dispatching');assert.equal(f.calls,1);
 assert.equal(second.reconcileStartup().processed,0);release();const result=await first;assert.equal(result.task.status,'applied');assert.ok(isEditTaskEnvelope(result));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,1);
 assert.deepEqual(await f.execute(result),result);assert.equal(f.calls,1);
 const acknowledged=f.ack(result.task);assert.equal(acknowledged.task.acknowledged,true);assert.equal(acknowledged.task.revision,result.task.revision+1);
 assert.equal(f.tasks.list({projectId:f.project.id}).items.length,0);assert.equal(f.tasks.list({projectId:f.project.id,pendingOnly:false}).items.length,1);
 assert.throws(()=>f.ack(result.task),code('EDIT_TASK_CONFLICT'));
 for(const sql of ["UPDATE edit_tasks SET status='unknown',revision=revision+1", "UPDATE edit_tasks SET input='{}'",'DELETE FROM edit_tasks'])assert.throws(()=>f.store.db.exec(sql));
 assert.equal(f.row(saved.task).status,'applied');
});

for(const point of ['beforePreparePersist','afterPreparePersist'])test(`prepare failure at ${point} never dispatches`,async t=>{
 const f=await fixture(t);f.setFault(label=>{if(label===point)throw Error('PRIVATE simulated disk failure');});
 await assert.rejects(f.track(),code('EDIT_TASK_STORAGE_UNAVAILABLE'));assert.equal(f.calls,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM edit_tasks').get().n,point==='beforePreparePersist'?0:1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,0);
});

for(const point of ['afterClaim','beforeDispatch','afterBusinessCommit','beforeOutcomePersist','afterOutcomePersist'])test(`restart recovers ${point} without automatic dispatch or lost identity`,async t=>{
 const f=await fixture(t),saved=await f.track();f.setFault(label=>{if(label===point)throw Error('PRIVATE crash');});
 await assert.rejects(f.execute(saved),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 f.setFault(()=>{});f.restart();const before=f.snapshot(),calls=f.calls;
 const lookup=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(lookup.task.id,saved.task.id);assert.notEqual(lookup.instanceId,saved.instanceId);
 await assert.rejects(f.execute(saved),code('EDIT_TASK_STALE_INSTANCE'));f.tasks.reconcileStartup();assert.equal(f.snapshot(),before);assert.equal(f.calls,calls);
 let current=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});
 const committed=!['afterClaim','beforeDispatch'].includes(point);assert.equal(current.task.status,committed?'applied':'unknown');
 const result=await f.execute(current);assert.equal(result.task.status,'applied');assert.equal(result.task.requestId,saved.task.requestId);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,1);assert.equal(f.calls,calls+(committed?0:1));
});

test('lock:false reader cannot dispatch, acknowledge, reconcile or steal startup claims',async t=>{
 const f=await fixture(t),saved=await f.track();let release;const wait=new Promise(resolve=>release=resolve);
 f.setDispatch(async(op,input,services)=>{await wait;return services.call(op,input);});const executing=f.execute(saved);
 const reader=openStore(f.root,{lock:false});t.after(()=>reader.close());const tasks=createEditTasks({store:reader,services:createServices(reader,new Map())});
 assert.equal(tasks.get({projectId:f.project.id,taskId:saved.task.id}).task.status,'dispatching');
 for(const call of [()=>tasks.reconcileStartup(),()=>tasks.reconcile(f.request(saved.task)),()=>tasks.prepare({projectId:f.project.id,operation:saved.task.operation,input:saved.task.input,origin:'new'})])assert.throws(call,code('EDIT_TASK_OWNER_REQUIRED'));
 await assert.rejects(tasks.execute({...f.request(saved.task),instanceId:saved.instanceId}),code('EDIT_TASK_OWNER_REQUIRED'));
 assert.equal(f.row(saved.task).status,'dispatching');release();assert.equal((await executing).task.status,'applied');
});

test('legacy unknown imports remain idle; explicit recovery same key and preexisting receipt readback',async t=>{
 const f=await fixture(t),timeline=await f.services.call('timeline.get',{projectId:f.project.id}),input={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio'};
 const imported=f.prepare('timeline.track.add',input,'legacy_session');assert.equal(imported.task.status,'unknown');
 assert.equal(f.tasks.reconcile(f.request(imported.task)).task.status,'unknown');assert.equal(f.calls,0);
 const applied=await f.execute(imported);f.ack(applied.task);assert.equal(f.calls,1);
 const next={...input,expectedRevision:applied.result.revision,requestId:randomUUID()};const response=await f.services.call('timeline.track.add',next);
 const existing=f.prepare('timeline.track.add',next,'legacy_session');const recovered=await f.execute(existing);
 assert.deepEqual(recovered.result,response);assert.equal(f.calls,1);assert.equal(recovered.task.status,'applied');
});

test('only journal absence plus transaction-issued proof is terminal not_applied',async t=>{
 const f=await fixture(t),saved=await f.track({expectedRevision:99});const before=f.snapshot();
 const outcome=await f.execute(saved);assert.equal(outcome.task.status,'not_applied');assert.equal(outcome.task.errorCode,'REVISION_CONFLICT');assert.equal(f.snapshot(),before);
 assert.equal(Object.hasOwn(outcome,'result'),false);assert.equal(JSON.stringify(outcome).includes('current'),false);
 f.ack(outcome.task);const second=await f.track();f.setDispatch(()=>{throw Error('PRIVATE generic failure');});
 assert.equal((await f.execute(second)).task.status,'unknown');assert.equal(f.calls,2);
});

test('history replay remains exact after undo and removed target clip',async t=>{
 const f=await fixture(t),asset=f.asset();let timeline=await f.services.call('timeline.get',{projectId:f.project.id});
 const input={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:60};
 const saved=f.prepare('timeline.clip.add',input),applied=await f.execute(saved);timeline=applied.result;const clipId=timeline.clips[0].id;
 timeline=await f.services.call('timeline.clip.remove',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId});
 assert.deepEqual(f.tasks.reconcile(f.request(saved.task)).result,applied.result);
 await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID()});
 assert.deepEqual(f.tasks.reconcile(f.request(saved.task)).result,applied.result);f.ack(applied.task);
});

test('reference receipts survive detached/rebound targets and separate family namespace',async t=>{
 const f=await fixture(t),asset=f.asset({mimeType:'image/png'}),node=await f.services.call('node.create',{projectId:f.project.id,type:'image',assetId:asset.id,position:{x:0,y:0}}),shot=await f.services.call('shot.create',{projectId:f.project.id,title:'Reference'});
 const input={projectId:f.project.id,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame'};
 const saved=f.prepare('reference.attach',input),attached=await f.execute(saved);f.ack(attached.task);
 const detached=await f.services.call('reference.detach',{projectId:f.project.id,edgeId:attached.result.edge.id,expectedShotRevision:attached.result.shot.revision,requestId:randomUUID()});
 await f.services.call('reference.attach',{...input,expectedShotRevision:detached.shot.revision,requestId:randomUUID()});
 assert.deepEqual(f.tasks.reconcile(f.request(saved.task)).result,attached.result);
 const timeline=await f.services.call('timeline.get',{projectId:f.project.id});
 const other=f.prepare('timeline.track.add',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:input.requestId,kind:'audio'});
 assert.equal((await f.execute(other)).task.status,'applied');
});

test('capacity is retained after acknowledgement, list pages are SQL-bounded, exact maximum valid inputs fit',async t=>{
 const f=await fixture(t,{limits:{rows:3,pageSize:1}});
 for(let n=0;n<3;n++){const saved=await f.track();f.ack((await f.execute(saved)).task);}
 await assert.rejects(f.track(),code('EDIT_TASK_STORAGE_LIMIT'));
 let cursor,ids=[];do{const page=f.tasks.list({projectId:f.project.id,pendingOnly:false,limit:1,...(cursor?{cursor}:{})});assert.equal(page.items.length,1);ids.push(page.items[0].id);cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,3);assert.throws(()=>f.tasks.list({projectId:f.project.id,limit:51}),code('EDIT_TASK_VALIDATION'));
 const maximal={projectId:f.project.id,requestId:'界'.repeat(200),expectedRevision:Number.MAX_SAFE_INTEGER,clipId:randomUUID(),patch:{name:'界'.repeat(200),trackId:randomUUID(),startFrame:18000,durationFrames:18000,sourceInFrame:Number.MAX_SAFE_INTEGER-18000,rect:{x:0,y:0,width:720,height:1280},gain:2,fadeInFrames:18000,fadeOutFrames:18000}};
 assert.ok(schemas['timeline.clip.update'].safeParse(maximal).success);assert.ok(Buffer.byteLength(JSON.stringify(maximal))<EDIT_TASK_LIMITS.inputBytes);
 assert.throws(()=>f.prepare('timeline.track.add',{...maximal,name:'界'.repeat(3000)}),code('EDIT_TASK_LIMIT'));
});

test('corrupt/foreign owners and oversized row data fail closed without leaking private contents',async t=>{
 const f=await fixture(t),saved=await f.track(),applied=await f.execute(saved);
 assert.throws(()=>f.tasks.get({projectId:f.other.id,taskId:saved.task.id}),code('EDIT_TASK_NOT_FOUND'));
 const current=f.store.get('timelines',applied.result.id);f.store.db.prepare('UPDATE timelines SET projectId=?,data=? WHERE id=?').run(f.other.id,JSON.stringify({...current,projectId:f.other.id,name:'PRIVATE_FOREIGN'}),current.id);
 const before=f.row(saved.task);assert.throws(()=>f.ack(applied.task),code('EDIT_TASK_STORAGE_UNAVAILABLE'));assert.deepEqual(f.row(saved.task),before);
 assert.throws(()=>f.tasks.get({projectId:f.project.id,taskId:saved.task.id}),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 const safe=safeEditTaskError({code:'SQLITE_PRIVATE',message:'PRIVATE stack',details:{secret:'PRIVATE'}});assert.equal(JSON.stringify(safe).includes('PRIVATE'),false);
});

test('drain fences new calls and waits for full execution outcome persistence',async t=>{
 const f=await fixture(t),saved=await f.track();let release;const wait=new Promise(resolve=>release=resolve);f.setDispatch(async(op,input,services)=>{await wait;return services.call(op,input);});
 const executing=f.execute(saved),draining=f.tasks.drain();assert.throws(()=>f.tasks.list({projectId:f.project.id}),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 release();assert.equal((await executing).task.status,'applied');await draining;assert.equal(f.row(saved.task).status,'applied');
});

test('all FIRST12 operations use the same retained service receipts',async t=>{
 const f=await fixture(t),seen=new Set(),receipts=[];
 const generated=f.asset({provenance:'generated'}),shot=await f.services.call('shot.create',{projectId:f.project.id,title:'Selected'}),jobId=randomUUID(),versionId=randomUUID();
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId,assetId:generated.id,status:'succeeded',snapshot:{projectId:f.project.id,shotId:shot.id}});
 f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:shot.id,jobId,assetId:generated.id,sha256:generated.sha256,number:1});
 f.store.put('shots',{...shot,selectedVersionId:versionId});
 let timeline=await f.services.call('timeline.get',{projectId:f.project.id});
 async function edit(operation,fields={}){
  const input={projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields};
  const saved=f.prepare(operation,input),result=await f.execute(saved);assert.equal(result.task.status,'applied',operation);timeline=result.result;f.ack(result.task);seen.add(operation);receipts.push({saved,result});return timeline;
 }
 await edit('timeline.seed');await edit('timeline.track.add',{kind:'audio'});await edit('timeline.track.update',{trackId:timeline.tracks[0].id,patch:{name:'Revised'}});
 const source=f.asset(),replacement=f.asset();await edit('timeline.clip.add',{assetId:source.id,trackId:timeline.tracks[1].id,startFrame:90,durationFrames:60});
 const clipId=timeline.clips.at(-1).id;await edit('timeline.clip.update',{clipId,patch:{gain:.5}});await edit('timeline.clip.split',{clipId,atFrame:120});
 await edit('timeline.clip.replaceSource',{clipId,assetId:replacement.id});await edit('timeline.clip.remove',{clipId});await edit('timeline.undo');await edit('timeline.redo');
 const image=f.asset({mimeType:'image/png'}),node=await f.services.call('node.create',{projectId:f.project.id,type:'image',assetId:image.id,position:{x:0,y:0}}),referenceShot=await f.services.call('shot.create',{projectId:f.project.id,title:'Reference target'});
 const attach=f.prepare('reference.attach',{projectId:f.project.id,sourceNodeId:node.id,targetShotId:referenceShot.id,expectedSourceRevision:node.revision,expectedShotRevision:referenceShot.revision,requestId:randomUUID(),role:'first_frame'});
 const attached=await f.execute(attach);assert.equal(attached.task.status,'applied');f.ack(attached.task);seen.add('reference.attach');
 const detach=f.prepare('reference.detach',{projectId:f.project.id,edgeId:attached.result.edge.id,expectedShotRevision:attached.result.shot.revision,requestId:randomUUID()});
 const detached=await f.execute(detach);assert.equal(detached.task.status,'applied');f.ack(detached.task);seen.add('reference.detach');
 assert.deepEqual(seen,new Set(DURABLE_EDIT_OPERATIONS.slice(0,12)));assert.equal(f.calls,12);
 for(const {saved,result} of receipts)assert.deepEqual(f.tasks.reconcile(f.request(saved.task)).result,result.result);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,10);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM reference_requests').get().n,2);
});

test('a stale dispatch callback cannot regress a reconciled and acknowledged terminal outcome',async t=>{
 const f=await fixture(t),saved=await f.track();let committed,release;const ready=new Promise(resolve=>committed=resolve),wait=new Promise(resolve=>release=resolve);
 f.setDispatch(async(op,input,services)=>{const result=await services.call(op,input);committed();await wait;return result;});
 const executing=f.execute(saved);await ready;
 const recovered=f.tasks.reconcile(f.request(saved.task)),acknowledged=f.ack(recovered.task),row=f.row(saved.task);
 release();const late=await executing;assert.deepEqual(late.task,acknowledged.task);assert.deepEqual(f.row(saved.task),row);assert.equal(f.calls,1);
});

test('oversized/corrupt task payload is bounded in SQLite and never disclosed',async t=>{
 const f=await fixture(t),saved=await f.track();
 f.store.db.exec('DROP TRIGGER immutable_edit_task_identity; DROP TRIGGER edit_task_state_transitions; PRAGMA ignore_check_constraints=ON;');
 f.store.db.prepare('UPDATE edit_tasks SET input=? WHERE id=?').run(JSON.stringify({private:'PRIVATE'.repeat(20000)}),saved.task.id);
 for(const call of [()=>f.tasks.get({projectId:f.project.id,taskId:saved.task.id}),()=>f.tasks.list({projectId:f.project.id}),()=>f.tasks.reconcile(f.request(saved.task))])assert.throws(call,code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 assert.equal(f.calls,0);
});


test('an independent process cannot acquire ownership or steal an active persisted claim',async t=>{
 const f=await fixture(t),saved=await f.track();let release;
 const wait=new Promise(resolve=>release=resolve);f.setDispatch(async(op,input,services)=>{await wait;return services.call(op,input);});
 const executing=f.execute(saved),before=f.row(saved.task);
 try{
  // execFileSync returns only after child exit; timeout is scoped to this owned
  // child handle. No numeric PID is used as authority for any cleanup action.
  const stdout=execFileSync(process.execPath,[new URL('./helpers/edit-tasks-owner-process.mjs',import.meta.url).pathname,
   f.root,JSON.stringify({...f.request(saved.task),instanceId:saved.instanceId})],{encoding:'utf8',timeout:10000,maxBuffer:65536});
  const result=JSON.parse(stdout);
  assert.deepEqual(result,{ownerDenied:true,before:'dispatching',after:'dispatching',unchanged:true,
   failures:{startup:'EDIT_TASK_OWNER_REQUIRED',reconcile:'EDIT_TASK_OWNER_REQUIRED',execute:'EDIT_TASK_OWNER_REQUIRED'}});
  assert.deepEqual(f.row(saved.task),before);assert.equal(f.calls,1);
 }finally{release();await executing;}
 assert.equal(f.row(saved.task).status,'applied');assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests').get().n,1);
});
