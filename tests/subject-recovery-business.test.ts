import type {ExecutedSubjectTask} from './helpers/strict-timeline-audio-subject-recovery-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS, editTaskLane, isEditTaskEnvelope} from '@mioon/contracts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {subjectFixture} from './helpers/strict-timeline-audio-subject-recovery-types.ts';
const code=(expected: string)=>(error: { code: string; })=>error.code===expected&&!JSON.stringify(error).includes('PRIVATE');

test('only three subject writes add a third durable lane; preparation and reads never mutate the domain',async t=>{
 const f=await subjectFixture(t),input=f.createInput(),before=f.snapshot();
 assert.equal(DURABLE_EDIT_OPERATIONS.length,21);
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.slice(17,20),['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']);
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.slice(20),['timeline.loudness.apply']);assert.equal(editTaskLane('timeline.loudness.apply'),'timeline:mutation');
 assert.equal(DURABLE_EDIT_OPERATIONS[16],'timeline.format.set');assert.equal(editTaskLane('timeline.format.set'),'timeline:mutation');
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.slice(13,16),['subject.create','subject.version.add','subject.binding.set']);
 for(const operation of DURABLE_EDIT_OPERATIONS.slice(13,16))assert.equal(editTaskLane(operation),'subject:mutation');
 for(const operation of ['subject.list','subject.version.list','subject.binding.list','subject.delete','timeline.render','shot.update','__proto__'])assert.equal(editTaskLane(operation),null);
 assert.deepEqual(EDIT_TASK_LIMITS,{inputBytes:8192,rowBytes:16384,rows:4096,bytes:64*1024*1024,pageSize:20,maxPageSize:50});
 const saved=f.prepare('subject.create',input);assert.equal(saved.task.status,'prepared');assert.ok(isEditTaskEnvelope(saved));
 assert.deepEqual(saved.task.input,input);assert.deepEqual(f.prepare('subject.create',input),saved);
 const writes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.deepEqual(f.tasks.get({projectId:f.project.id,taskId:saved.task.id}),saved);
 assert.deepEqual(f.tasks.list({projectId:f.project.id}).items,[saved.task]);
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,writes);
 assert.equal(f.snapshot(),before);assert.equal(f.calls,0);
 assert.throws(()=>f.prepare('subject.create',{...input,requestId:randomUUID()}),code('EDIT_TASK_CONFLICT'));
});

test('all three subject operations use exact retained receipts and remain historical after new head and tombstone',async t=>{
 const f=await subjectFixture(t),records:ExecutedSubjectTask[]=[];
 async function edit<O extends string>(operation:O,input: unknown){const saved=f.prepare(operation,input),applied=await f.execute(saved);assert.equal(applied.task.status,'applied',operation);assert.ok(isEditTaskEnvelope(applied));f.ack(applied.task);records.push(applied);return applied.result;}
 let subject=await edit('subject.create',f.createInput());
 const firstVersion=subject.headVersionId;
 const input={projectId:f.project.id,shotId:f.shot.id,subjectId:subject.id,role:'subject',subjectVersionId:firstVersion,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID()};
 let binding=await edit('subject.binding.set',input);
 subject=await edit('subject.version.add',{projectId:f.project.id,subjectId:subject.id,expectedRevision:subject.revision,assetId:f.asset({sha256:'b'.repeat(64)}).id,requestId:randomUUID()});
 binding=await edit('subject.binding.set',{...input,subjectVersionId:null,expectedRevision:binding.revision,expectedSubjectRevision:subject.revision,requestId:randomUUID()});
 assert.equal(binding.subjectVersionId,null);
 const before=f.snapshot();f.restart();assert.equal(f.tasks.reconcileStartup().processed,0);
 for(const prior of records){const result=f.tasks.reconcile(f.request(prior.task));assert.deepEqual(result.result,prior.result);assert.equal(result.task.acknowledged,true);}
 assert.equal(f.snapshot(),before);assert.equal(f.calls,4);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM subject_requests').get()!.n,4);
});

for(const phase of ['beforePreparePersist','afterPreparePersist','afterClaim','beforeDispatch','afterBusinessCommit','beforeOutcomePersist','afterOutcomePersist'])test(`subject restart preserves exact intent after ${phase}, without autoresume`,async t=>{
 const f=await subjectFixture(t),input=f.createInput();let saved;
 if(!phase.includes('Prepare'))saved=f.prepare('subject.create',input);
 f.setFault((label: string)=>{if(label===phase)throw Error('PRIVATE synthetic fault');});
 if(phase.includes('Prepare'))assert.throws(()=>f.prepare('subject.create',input),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 else await assert.rejects(f.execute(saved),code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 f.setFault(()=>{});f.restart();const before=f.snapshot(),calls=f.calls;
 f.tasks.reconcileStartup();assert.equal(f.calls,calls);assert.equal(f.snapshot(),before);
 const list=f.tasks.list({projectId:f.project.id});
 if(phase==='beforePreparePersist'){assert.deepEqual((list.items as unknown),[]);return;}
 const task=list.items[0];assert.deepEqual(task.input,input);
 const committed=['afterBusinessCommit','beforeOutcomePersist','afterOutcomePersist'].includes(phase);
 assert.equal(task.status,phase==='afterPreparePersist'?'prepared':committed?'applied':'unknown');
 if(saved)await assert.rejects(f.execute(saved),code('EDIT_TASK_STALE_INSTANCE'));
 const current=f.tasks.get({projectId:f.project.id,taskId:task.id}),applied=await f.execute(current);
 assert.equal(applied.task.status,'applied');assert.equal(applied.task.requestId,input.requestId);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM subject_requests').get()!.n,1);
 assert.equal(f.calls,calls+(committed?0:1));
});

test('two durable managers claim one subject write once and acknowledgement never dispatches again',async t=>{
 const f=await subjectFixture(t),saved=f.prepare('subject.create',f.createInput());let release;
 const wait=new Promise<void>(resolve=>release=resolve);f.setDispatch(async<O extends string>(op: O,input: unknown,services: import("./helpers/strict-service-responses.ts").TypedServices)=>{assert.equal(f.row(saved.task)!.status,'dispatching');assert.equal(f.store.db.isTransaction,false);await wait;return services.call(op,input);});
 const active=f.execute(saved),other=createEditTasks({store:f.store,services:f.services});
 assert.equal(((await other.execute({...f.request(saved.task),instanceId:saved.instanceId})) as ExecutedSubjectTask).task.status,'dispatching');
 assert.equal(other.reconcileStartup().processed,0);assert.equal(f.calls,1);release!();
 const result=await active;assert.equal(result.task.status,'applied');const ack=f.ack(result.task);
 assert.equal((await f.execute(ack)).task.acknowledged,true);assert.equal(f.calls,1);
});

test('fresh rollback proof resolves rejection while generic and mismatched success remain unknown',async t=>{
 const f=await subjectFixture(t),subject=await f.services.call('subject.create',f.createInput());
 const input={projectId:f.project.id,subjectId:subject.id,expectedRevision:99,assetId:f.asset().id,requestId:randomUUID()};
 const saved=f.prepare('subject.version.add',input),before=f.snapshot(),rejected=await f.execute(saved);
 assert.equal(rejected.task.status,'not_applied');assert.equal(rejected.task.errorCode,'REVISION_CONFLICT');assert.equal(f.snapshot(),before);f.ack(rejected.task);
 for(const response of [null,{},subject]){
  const next=f.prepare('subject.create',f.createInput());f.setDispatch(()=>response);
  assert.equal((await f.execute(next)).task.status,'unknown');assert.equal(f.tasks.list({projectId:f.project.id}).items[0].requestId,next.task.requestId);
  // Continue only through the stored request, never replacing unknown identity.
  f.setDispatch(undefined);f.ack((await f.execute(f.tasks.get({projectId:f.project.id,taskId:next.task.id})) ).task);
 }
});

test('shared local namespace collisions and duplicate receipts cannot authorize subject execution',async t=>{
 const f=await subjectFixture(t),key=randomUUID();
 await f.services.call('node.create',{projectId:f.project.id,type:'text',text:'Reserved local key',position:{x:0,y:0},requestId:key});
 const before=f.snapshot();assert.throws(()=>f.prepare('subject.create',f.createInput({requestId:key})),code('EDIT_TASK_CONFLICT'));
 assert.equal(f.snapshot(),before);assert.equal(f.calls,0);
 const input=f.createInput(),saved=f.prepare('subject.create',input),applied=await f.execute(saved),row=f.store.db.prepare('SELECT * FROM subject_requests WHERE requestId=?').get(input.requestId);
 f.store.db.exec('DROP TRIGGER reject_mutation_cross_subject_request; PRAGMA ignore_check_constraints=ON;');
 f.store.db.prepare('INSERT INTO mutation_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)').run(row!.requestId,row!.operation,row!.projectId,row!.canonicalInput,row!.response);
 assert.throws(()=>f.tasks.reconcile(f.request(applied.task)),code('EDIT_TASK_CONFLICT'));assert.equal(f.calls,1);
});

test('current relational ownership is checked before historical receipt and foreign contents never escape',async t=>{
 const f=await subjectFixture(t),saved=f.prepare('subject.create',f.createInput()),applied=await f.execute(saved),before=f.row(saved.task);
 const source=f.store.get('assets',f.source.id)!;
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.other.id,JSON.stringify({...source,projectId:f.other.id,name:'PRIVATE_FOREIGN'}),source.id);
 for(const call of [()=>f.tasks.get({projectId:f.project.id,taskId:saved.task.id}),()=>f.tasks.reconcile(f.request(saved.task)),()=>f.ack(applied.task)])assert.throws(call,code('EDIT_TASK_STORAGE_UNAVAILABLE'));
 assert.deepEqual(f.row(saved.task),before);assert.equal(f.calls,1);
});

test('subject task quota remains retained after acknowledgement',async t=>{
 const f=await subjectFixture(t,{limits:{rows:1}}),applied=await f.execute(f.prepare('subject.create',f.createInput()));f.ack(applied.task);
 assert.throws(()=>f.prepare('subject.create',f.createInput()),code('EDIT_TASK_STORAGE_LIMIT'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM edit_tasks').get()!.n,1);
});

test('external subject receipt adoption remains metadata-only until explicit reconciliation',async t=>{
 const f=await subjectFixture(t),input=f.createInput(),result=await f.services.call('subject.create',input),before=f.snapshot();
 const imported=f.prepare('subject.create',input,'legacy_session');assert.equal(imported.task.status,'unknown');assert.equal(f.calls,0);
 assert.deepEqual(f.tasks.get({projectId:f.project.id,taskId:imported.task.id}).task,imported.task);assert.equal(f.snapshot(),before);
 const reconciled=f.tasks.reconcile(f.request(imported.task));assert.equal(reconciled.task.status,'applied');assert.deepEqual(reconciled.result,result);assert.equal(f.calls,0);
 assert.equal(f.ack(reconciled.task).task.acknowledged,true);assert.equal(f.snapshot(),before);
});

test('corrupt or oversized retained subject response never settles or leaks a durable request',async t=>{
 for(const response of ['{',JSON.stringify({private:'PRIVATE'.repeat(4000)}),JSON.stringify({projectId:'not-the-project'})]){
  const f=await subjectFixture(t),saved=f.prepare('subject.create',f.createInput()),applied=await f.execute(saved),before=f.row(saved.task);
  f.store.db.exec('DROP TRIGGER immutable_subject_requests; PRAGMA ignore_check_constraints=ON;');
  f.store.db.prepare('UPDATE subject_requests SET response=? WHERE requestId=?').run(response,saved.task.requestId);
  for(const call of [()=>f.tasks.get({projectId:f.project.id,taskId:saved.task.id}),()=>f.tasks.list({projectId:f.project.id}),()=>f.ack(applied.task)])assert.throws(call,code('EDIT_TASK_STORAGE_UNAVAILABLE'));
  assert.deepEqual(f.row(saved.task),before);assert.equal(f.calls,1);
 }
});
