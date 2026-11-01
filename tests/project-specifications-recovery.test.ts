import type {TypedTaskManager, TaskRecord, TaskEnvelope} from './helpers/strict-edit-task-types.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices,canonical,hash} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {isEditTaskEnvelope} from '@mioon/contracts';
import {schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';

const code=(expected: string)=>(error: { code: string; })=>error.code===expected&&!JSON.stringify(error).includes('PRIVATE');
const DOMAIN_TABLES=['projects','timelines','timeline_requests','timeline_format_requests','timeline_history','timeline_history_cursors','exports'];
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext,name='Foreign project'){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-format-recovery-foreign-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices);
 try{return await services.call('project.create',{name});}
 finally{await services.drain();store.close();}
}
async function fixture(t: test.TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-format-recovery-'));
 let store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices),tasks!: TypedTaskManager,calls=0,fault: (point: string) => void=()=>{},dispatch: ((operation: string,input: Record<string,unknown>,services: TypedServices) => unknown) | undefined;
 const start=()=>{tasks=createEditTasks({store,services:{call<O extends string>(operation: O,input: unknown){calls++;assert.equal(store.db.isTransaction,false);return dispatch?dispatch(operation,input as Record<string,unknown>,services):services.call(operation,input);}},fault:(point: string)=>fault(point)}) as unknown as TypedTaskManager;};start();
 const project=await services.call('project.create',{name:'Format recovery'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const f={root,project,get store(){return store;},get services(){return services;},get tasks(){return tasks;},get calls(){return calls;},
  setFault(fn: (point: string) => void){fault=fn;},setDispatch(fn: (operation: string,input: Record<string,unknown>,services: TypedServices) => unknown){dispatch=fn;},
  call<O extends string>(operation: O,input: unknown){return services.call(operation,input);},
  restart(){store.close();store=(openStore(root) as TypedStore);services=(createServices(store,new Map()) as TypedServices);start();},
  request(task: TaskRecord){return {projectId:task.projectId,taskId:task.id,digest:task.digest};},
  execute(envelope: TaskEnvelope){return tasks.execute({...f.request(envelope.task),instanceId:envelope.instanceId}) as Promise<TaskEnvelope<'timeline.get'>>;},
  ack(task: TaskRecord){return tasks.acknowledge({...f.request(task),expectedRevision:task.revision,status:task.status});},
  prepare(input: { projectId: string; expectedProjectRevision: unknown; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; presetId: string; },origin='new'){return tasks.prepare({projectId:project.id,operation:'timeline.format.set',input,origin});},
  row(task: TaskRecord){return store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(task.id);},
  snapshot({tasks=false}={}){return Object.fromEntries([...DOMAIN_TABLES,...(tasks?['edit_tasks']:[])].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
  async input(patch={}){const state=await f.call('timeline.format.get',{projectId:project.id});return {projectId:project.id,expectedProjectRevision:state.projectRevision,expectedRevision:state.timelineRevision,requestId:randomUUID(),presetId:'landscape_720',...patch};},
 };return f;
}
async function rejectedUnchanged(f: Awaited<ReturnType<typeof fixture>>,input: unknown,expected='TIMELINE_FORMAT_LOCKED'){
 const before=f.snapshot({tasks:true});
 await assert.rejects(f.call('timeline.format.set',input),code(expected));
 assert.deepEqual(f.snapshot({tasks:true}),before);
}
function counts(f: Awaited<ReturnType<typeof fixture>>){return Object.fromEntries(['timeline_requests','timeline_format_requests','timeline_history'].map(table=>[table,f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n]));}
function dropProtection(db: DatabaseSync,table: string){
 for(const {name} of schemaObjects(db).filter(object=>object.type==='trigger'&&object.tbl_name===table))db.exec(`DROP TRIGGER "${name.replaceAll('"','""')}"`);
}

test('format intent preparation is durable and noncreating; a matching prepared task is not a dispatch claim',async t=>{
 const f=await fixture(t),input=await f.input(),before=f.snapshot();
 assert.equal(input.expectedRevision,0);
 const saved=f.prepare(input);assert.equal(saved.task.status,'prepared');assert.equal(saved.task.lane,'timeline:mutation');
 assert.equal(saved.task.digest,hash({operation:'timeline.format.set',input}));assert.ok(isEditTaskEnvelope(saved));
 assert.deepEqual(f.prepare({...input}),saved);assert.deepEqual(f.snapshot(),before);assert.equal(f.calls,0);
 const state=await f.call('timeline.format.get',{projectId:f.project.id});
 assert.equal(state.timelineId,null);assert.equal(state.timelineRevision,0);assert.equal(state.eligible,false);assert.deepEqual(state.blockedReasons,['PENDING_EDIT']);
 await rejectedUnchanged(f,input);
 const applied=await f.execute(saved);assert.equal(applied.task.status,'applied');assert.ok(isEditTaskEnvelope(applied));
 assert.equal((applied.result)!.revision,1);assert.equal((applied.result)!.width,1280);assert.equal((applied.result)!.height,720);
 assert.equal(f.calls,1);assert.deepEqual(counts(f),{timeline_requests:1,timeline_format_requests:1,timeline_history:0});
 assert.deepEqual(f.store.db.prepare('SELECT * FROM projects').all(),before.projects,'format CAS never rewrites the project row');
 assert.deepEqual(await f.call('timeline.format.set',input),applied.result,'exact receipt replays before pending-task admission');
 assert.deepEqual(await f.execute(applied),applied);assert.equal(f.calls,1);
 const ack=f.ack(applied.task);assert.equal(ack.task.acknowledged,true);
 assert.equal((await f.call('timeline.format.get',{projectId:f.project.id})).eligible,true);
});

test('only the exact claimed format input is exempt inside its live coordinator dispatch context',async t=>{
 const f=await fixture(t),input=await f.input(),saved=f.prepare(input);
 f.setDispatch(async<O extends string>(operation: O,claimed: Record<string,unknown>,services: TypedServices)=>{
  assert.equal(operation,'timeline.format.set');assert.equal(f.row(saved.task)!.status,'dispatching');
  assert.ok(f.row(saved.task)!.claim);assert.ok(f.row(saved.task)!.claimInstance);
  // Sharing the async context cannot authorize a different key or preset.
  for(const patch of [{requestId:randomUUID()},{presetId:'square_720'}]){
   const before=f.snapshot({tasks:true});
   await assert.rejects(services.call(operation,{...claimed,...patch}),code('TIMELINE_FORMAT_LOCKED'));
   assert.deepEqual(f.snapshot({tasks:true}),before);
  }
  assert.deepEqual((await services.call('timeline.format.get',{projectId:f.project.id})).blockedReasons,['PENDING_EDIT']);
  return services.call(operation,claimed);
 });
 const outcome=await f.execute(saved);assert.equal(outcome.task.status,'applied');assert.equal(f.calls,1);
 assert.deepEqual(counts(f),{timeline_requests:1,timeline_format_requests:1,timeline_history:0});
});

test('a direct caller cannot borrow a live claim while its coordinator awaits dispatch',async t=>{
 const f=await fixture(t),input=await f.input(),saved=f.prepare(input);let ready: (value?: unknown) => void,release;
 const entered=new Promise(resolve=>ready=resolve),waiting=new Promise(resolve=>release=resolve);
 f.setDispatch(async<O extends string>(operation: O,claimed: Record<string,unknown>,services: TypedServices)=>{ready();await waiting;return services.call(operation,claimed);});
 const execution=f.execute(saved);await entered;
 try{
  await rejectedUnchanged(f,input);
  const second=createEditTasks({store:f.store,services:f.services});
  assert.equal((await second.execute({...f.request(saved.task),instanceId:saved.instanceId}) as TaskEnvelope).task.status,'dispatching');
  assert.equal(second.reconcileStartup().processed,0);assert.equal(f.calls,1);
 }finally{release!();}
 const applied=await execution;assert.equal(applied.task.status,'applied');assert.equal(f.calls,1);
});

for(const status of ['prepared','unknown','applied','not_applied'])test(`another ${status} unacknowledged timeline task blocks a fresh format key`,async t=>{
 const f=await fixture(t);let saved;
 if(status==='not_applied'){
  saved=f.prepare(await f.input({expectedProjectRevision:f.project.revision+1}));
  saved=await f.execute(saved);assert.equal(saved.task.status,'not_applied');
 }else if(status==='applied'){
  saved=await f.execute(f.prepare(await f.input()));assert.equal(saved.task.status,'applied');
 }else saved=f.prepare(await f.input(),status==='unknown'?'legacy_session':'new');
 const state=await f.call('timeline.format.get',{projectId:f.project.id});
 assert.ok(state.blockedReasons.includes('PENDING_EDIT'));assert.equal(state.eligible,false);
 const input=await f.input({presetId:'square_720'});await rejectedUnchanged(f,input);
 if(['applied','not_applied'].includes(status)){
  f.ack(saved.task);assert.equal((await f.call('timeline.format.get',{projectId:f.project.id})).eligible,true);
  assert.equal((await f.call('timeline.format.set',input)).width,720);
 }
});

test('an older timeline edit blocks the same project only, without creating either timeline',async t=>{
 const f=await fixture(t),other=await f.call('project.create',{name:'Unrelated format project'});
 const saved=f.tasks.prepare({projectId:f.project.id,operation:'timeline.track.add',origin:'new',
  input:{projectId:f.project.id,requestId:randomUUID(),expectedRevision:1,kind:'audio'}});
 const input=await f.input();await rejectedUnchanged(f,input);
 assert.equal(f.store.list('timelines').length,0);
 const state=await f.call('timeline.format.get',{projectId:other.id});assert.equal(state.eligible,true);
 const response=await f.call('timeline.format.set',{projectId:other.id,requestId:randomUUID(),expectedProjectRevision:other.revision,expectedRevision:0,presetId:'square_720'});
 assert.equal(response.width,720);assert.equal(response.height,720);
 assert.equal(f.tasks.get!({projectId:f.project.id,taskId:saved.task.id}).task.status,'prepared');
 assert.equal((await f.call('timeline.format.get',{projectId:f.project.id})).timelineId,null);
});

test('reference and subject lanes do not block a pristine timeline specification',async t=>{
 const f=await fixture(t),requestId=randomUUID();
 // Preparing a valid absent-reference recovery intent is noncreating and does
 // not require a timeline. Its separate lane must not lock output selection.
 const saved=f.tasks.prepare({projectId:f.project.id,operation:'reference.detach',origin:'legacy_session',
  input:{projectId:f.project.id,edgeId:randomUUID(),expectedShotRevision:1,requestId}});
 assert.equal(saved.task.lane,'reference:mutation');
 const assetId=randomUUID();
 f.store.put('assets',{id:assetId,projectId:f.project.id,name:'Subject source',mimeType:'image/png',width:64,height:64,
  sha256:'a'.repeat(64),provenance:'user-import',relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
 const subject=f.tasks.prepare({projectId:f.project.id,operation:'subject.create',origin:'new',
  input:{projectId:f.project.id,requestId:randomUUID(),assetId,kind:'character',name:'Prepared subject'}});
 assert.equal(subject.task.lane,'subject:mutation');
 const state=await f.call('timeline.format.get',{projectId:f.project.id});assert.equal(state.eligible,true);
 const response=await f.call('timeline.format.set',await f.input());assert.equal(response.width,1280);
 assert.equal(f.tasks.get!({projectId:f.project.id,taskId:saved.task.id}).task.status,'unknown');
});

for(const point of ['afterClaim','beforeDispatch','afterBusinessCommit','beforeOutcomePersist','afterOutcomePersist'])test(`format restart after ${point} preserves one request identity and original acknowledgement`,async t=>{
 const f=await fixture(t),input=await f.input(),saved=f.prepare(input),projectRows=f.snapshot().projects;
 f.setFault((label: string)=>{if(label===point)throw Error('PRIVATE lost format acknowledgement');});
 await assert.rejects(f.execute(saved),code('EDIT_TASK_STORAGE_UNAVAILABLE'));f.setFault(()=>{});
 const committed=!['afterClaim','beforeDispatch'].includes(point),before=f.snapshot(),calls=f.calls;
 assert.deepEqual(counts(f),{timeline_requests:committed?1:0,timeline_format_requests:committed?1:0,timeline_history:0});
 const original=committed?f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId)!.response:null;
 f.restart();assert.equal(f.calls,calls);assert.deepEqual(f.snapshot(),before);
 const current=f.tasks.get!({projectId:f.project.id,taskId:saved.task.id});assert.notEqual(current.instanceId,saved.instanceId);
 await assert.rejects(f.execute(saved),code('EDIT_TASK_STALE_INSTANCE'));
 const startup=f.tasks.reconcileStartup!();assert.equal(startup.unavailable,0);assert.equal(f.calls,calls);assert.deepEqual(f.snapshot(),before);
 const recovered=f.tasks.get!({projectId:f.project.id,taskId:saved.task.id});assert.equal(recovered.task.status,committed?'applied':'unknown');
 const applied=await f.execute(recovered);assert.equal(applied.task.status,'applied');assert.equal(applied.task.id,saved.task.id);assert.equal(applied.task.requestId,input.requestId);
 assert.equal((applied.result)!.revision,1);assert.equal(f.calls,calls+(committed?0:1));
 assert.deepEqual(counts(f),{timeline_requests:1,timeline_format_requests:1,timeline_history:0});
 assert.deepEqual(f.snapshot().projects,projectRows);
 assert.equal(f.store.db.prepare('SELECT input FROM timeline_format_requests WHERE requestId=?').get(input.requestId)!.input,canonical(input));
 if(original!==null)assert.equal(JSON.stringify(applied.result),original);
 const after=f.snapshot({tasks:true});assert.deepEqual(await f.execute(applied),applied);assert.deepEqual(f.snapshot({tasks:true}),after);
});

test('exact format replay survives later formats, project CAS drift, edits and restart without recreating history',async t=>{
 const f=await fixture(t),input=await f.input(),applied=await f.execute(f.prepare(input));f.ack(applied.task);
 const originalText=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId)!.response;
 const secondInput=await f.input({presetId:'square_720'}),second=await f.call('timeline.format.set',secondInput);
 assert.equal(second.revision,2);assert.equal(second.width,720);assert.equal(second.height,720);
 await f.call('timeline.track.add',{projectId:f.project.id,expectedRevision:second.revision,requestId:randomUUID(),kind:'audio'});
 f.store.put('projects',{...f.store.get('projects',f.project.id),name:'Changed project',revision:f.project.revision+1});
 f.restart();const before=f.snapshot({tasks:true}),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 const state=await f.call('timeline.format.get',{projectId:f.project.id});assert.equal(state.eligible,false);
 assert.ok(state.blockedReasons.includes('HISTORY_PRESENT'));assert.ok(state.blockedReasons.includes('REQUEST_HISTORY'));
 assert.equal(JSON.stringify(await f.call('timeline.format.set',input)),originalText);
 assert.deepEqual(f.tasks.reconcile!(f.request(applied.task)).result,applied.result);
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.deepEqual(f.snapshot({tasks:true}),before);
});

test('current owner and immutable historical format ACK remain mandatory for lost-response recovery',async t=>{
 for(const corruption of ['project owner','timeline owner','receipt revision','receipt dimensions','companion input'])await t.test(corruption,async t=>{
  const f=await fixture(t),input=await f.input(),applied=await f.execute(f.prepare(input));
  const other=await foreignProject(t,'PRIVATE_OTHER');
  if(corruption==='project owner')f.store.db.prepare("UPDATE projects SET data=json_set(data,'$.id',?) WHERE id=?").run(other.id,f.project.id);
  if(corruption==='timeline owner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE timelines SET projectId=? WHERE id=?').run(other.id,(applied.result)!.id));
  if(corruption.startsWith('receipt ')){
   dropProtection(f.store.db,'timeline_requests');
   const changed={...applied.result,...(corruption==='receipt revision'?{revision:2}:{width:720,height:720})};
   f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(changed),input.requestId);
  }
  if(corruption==='companion input'){
   dropProtection(f.store.db,'timeline_format_requests');
   f.store.db.prepare('UPDATE timeline_format_requests SET input=? WHERE requestId=?').run(canonical({...input,presetId:'square_720'}),input.requestId);
  }
  const before=f.snapshot({tasks:true});
  await assert.rejects(f.call('timeline.format.set',input),error=>{
   assert.ok(['TIMELINE_SOURCE_UNAVAILABLE','INVALID_TIMELINE_SNAPSHOT'].includes((error as Failure).code),(error as Failure).code);
   assert.equal((error as Failure).details?.mutationOutcome,undefined);assert.equal(JSON.stringify(error).includes('PRIVATE_OTHER'),false);return true;
  });
  assert.throws(()=>f.tasks.reconcile!(f.request(applied.task)),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
  assert.deepEqual(f.snapshot({tasks:true}),before);
 });
});

test('format receipt insertion failure rolls back the timeline, both journals and project CAS',async t=>{
 const f=await fixture(t),input=await f.input(),saved=f.prepare(input),before=f.snapshot();
 f.store.db.exec("CREATE TRIGGER reject_format_receipt BEFORE INSERT ON timeline_format_requests BEGIN SELECT RAISE(ABORT,'PRIVATE injected receipt failure');END");
 const outcome=await f.execute(saved);assert.equal(outcome.task.status,'unknown');assert.deepEqual(f.snapshot(),before);
 assert.equal(Object.hasOwn(outcome,'result'),false);assert.equal(outcome.task.errorCode,undefined);
 f.store.db.exec('DROP TRIGGER reject_format_receipt');
 const retried=await f.execute(outcome);assert.equal(retried.task.status,'applied');assert.equal((retried.result)!.revision,1);
 assert.equal(retried.task.requestId,input.requestId);assert.deepEqual(counts(f),{timeline_requests:1,timeline_format_requests:1,timeline_history:0});
});

test('same-preset and stale project CAS produce definite not-applied tasks without replacing requests',async t=>{
 const f=await fixture(t),first=await f.execute(f.prepare(await f.input()));f.ack(first.task);
 for(const patch of [{presetId:'landscape_720'},{presetId:'square_720',expectedProjectRevision:f.project.revision+1}]){
  const saved=f.prepare(await f.input(patch)),before=f.snapshot();
  const result=await f.execute(saved);assert.equal(result.task.status,'not_applied');
  assert.equal(result.task.errorCode,patch.expectedProjectRevision?'REVISION_CONFLICT':'TIMELINE_FORMAT_UNCHANGED');
  assert.deepEqual(f.snapshot(),before);assert.equal(Object.hasOwn(result,'result'),false);f.ack(result.task);
 }
});

for(const corruption of ['acknowledged prepared task','wrong timeline lane'])test(`corrupt ${corruption} cannot hide pending format work from the read or write boundary`,async t=>{
 const f=await fixture(t),input=await f.input(),saved=f.prepare(input);
 dropProtection(f.store.db,'edit_tasks');f.store.db.exec('PRAGMA ignore_check_constraints=ON');
 if(corruption==='acknowledged prepared task')f.store.db.prepare('UPDATE edit_tasks SET acknowledged=1 WHERE id=?').run(saved.task.id);
 else f.store.db.prepare("UPDATE edit_tasks SET lane='reference:mutation' WHERE id=?").run(saved.task.id);
 const before=f.snapshot({tasks:true}),changes=f.store.db.prepare('SELECT total_changes() AS n FROM edit_tasks LIMIT 1').get()!.n;
 for(const [operation,args] of [['timeline.format.get',{projectId:f.project.id}],['timeline.format.set',input]] as const)await assert.rejects(f.call(operation,args),error=>{
  assert.equal((error as Failure).code,'INVALID_TIMELINE_SNAPSHOT');assert.equal((error as Failure).details?.mutationOutcome,undefined);return true;
 });
 assert.deepEqual(f.snapshot({tasks:true}),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
});

for(const owner of ['invalid UUID','missing project'])test(`a retained receipt with ${owner} fails closed rather than disappearing from format admission`,async t=>{
 const f=await fixture(t),input=await f.input(),projectId=owner==='invalid UUID'?'x'.repeat(36):randomUUID();
 f.store.db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),JSON.stringify({projectId}));
 const before=f.snapshot({tasks:true}),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 for(const [operation,args] of [['timeline.format.get',{projectId:f.project.id}],['timeline.format.set',input]] as const)await assert.rejects(f.call(operation,args),error=>{
  assert.equal((error as Failure).code,'INVALID_TIMELINE_SNAPSHOT');assert.equal((error as Failure).details?.mutationOutcome,undefined);return true;
 });
 assert.deepEqual(f.snapshot({tasks:true}),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
});
