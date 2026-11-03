import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync,SQLInputValue,SQLOutputValue} from 'node:sqlite';
import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse,TypedStore,TypedServices} from './helpers/strict-service-responses.ts';
import type {EditTask} from '../packages/contracts/src/edit-tasks.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {DURABLE_EDIT_OPERATIONS,editTaskLane} from '@mioon/contracts';
import {kernelFixture,snapshot} from './helpers/current-retained-fixture.ts';
import {withoutForeignKeys} from './helpers/project-database.ts';
interface RetainedRow extends Record<string,SQLOutputValue>{position:number;id:string;projectId:string;revision:number;input:string}
type TypedEditTasks=Omit<ReturnType<typeof createEditTasks>,'prepare'|'execute'|'reconcile'> & {prepare(input:unknown):{task:EditTask;instanceId:string};execute(input:unknown):Promise<{task:EditTask;result:unknown}>;reconcile(input:unknown):{task:EditTask;result:unknown}};
const LEGACY_OPERATIONS = Object.freeze([
 'timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update',
 'timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed',
 'timeline.undo','timeline.redo','reference.attach','reference.detach',
]);
const COLUMNS = ['position','id','projectId','operation','input','requestId','digest','lane','origin','status',
 'revision','acknowledged','claim','claimInstance','receiptDigest','errorCode','createdAt','updatedAt','bytes'];
const WHEN = '2026-09-08T07:06:05.004Z';
const quote = (name: string) => '"'+name.replaceAll('"','""')+'"';
function insertTask(db: DatabaseSync,row: Record<string,SQLInputValue | undefined>) {
 db.prepare(`INSERT INTO edit_tasks(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})`).run(...COLUMNS.map(key=>row[key] as SQLInputValue));
}
function asset(store: TypedStore,projectId: string,patch={}) {
 const id=randomUUID();return store.put('assets',{id,projectId,name:'Migration source',mimeType:'video/mp4',duration:10,
 width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),
 relativePath:`media/${id}.fixture`,createdAt:WHEN,...patch});
}

// All twelve original operations produce real retained domain receipts. No
// provider, media process, native shell or network operation is invoked.
async function exerciseCurrentOperations(store: TypedStore) {
 const services=(createServices(store,new Map()) as TypedServices),project=store.get('projects',String(store.db.prepare('SELECT id FROM projects').get()!.id))!;
 const recovered: {operation:string;input:{requestId:string;projectId:string;expectedRevision?:number};result:unknown;row:RetainedRow}[]=[],generated=asset(store,project.id,{provenance:'generated'});
 const shot=await services.call('shot.create',{projectId:project.id,title:'Selected migration shot'}),jobId=randomUUID(),versionId=randomUUID();
 store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,versionId,assetId:generated.id,status:'succeeded',snapshot:{projectId:project.id,shotId:shot.id}});
 store.put('versions',{id:versionId,projectId:project.id,shotId:shot.id,jobId,assetId:generated.id,sha256:generated.sha256,number:1});
 store.put('shots',{...shot,selectedVersionId:versionId});
 const tasks=(createEditTasks({store,services}) as TypedEditTasks);let timeline=await services.call('timeline.get',{projectId:project.id});
 async function edit<O extends string>(operation: O,fields={}) {
  const requestId=`migration-界-"\\-${recovered.length}-${randomUUID()}`;
  const input={projectId:project.id,...(operation!.startsWith('timeline.')?{expectedRevision:timeline.revision}:{}),requestId,...fields};
  let result,row;
   const prepared=tasks.prepare({projectId:project.id,operation,input,origin:'new'});
   const applied=await tasks.execute({projectId:project.id,taskId:prepared.task.id,digest:prepared.task.digest,instanceId:prepared.instanceId});
   assert.equal(applied.task.status,'applied',operation);result=applied.result;
   tasks.acknowledge({projectId:project.id,taskId:applied.task.id,digest:applied.task.digest,expectedRevision:applied.task.revision,status:'applied'});
   row=store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(prepared.task.id);
  recovered.push({operation,input,result,row:row as RetainedRow});if(operation!.startsWith('timeline.'))timeline=result as FixtureTimeline;return result as ServiceResponse<O>;
 }
 await edit('timeline.seed');await edit('timeline.track.add',{kind:'audio',name:'Escaped "quote" \\ path\t界'});
 await edit('timeline.track.update',{trackId:timeline.tracks[0].id,patch:{name:'Revised\n界'}});
 const source=asset(store,project.id),replacement=asset(store,project.id);
 await edit('timeline.clip.add',{assetId:source.id,trackId:timeline.tracks[1].id,startFrame:90,durationFrames:60});
 const clipId=timeline.clips.at(-1)!.id;
 await edit('timeline.clip.update',{clipId,patch:{gain:.5}});await edit('timeline.clip.split',{clipId,atFrame:120});
 await edit('timeline.clip.replaceSource',{clipId,assetId:replacement.id});await edit('timeline.clip.remove',{clipId});
 await edit('timeline.undo');await edit('timeline.redo');
 const image=asset(store,project.id,{mimeType:'image/png'});
 const node=await services.call('node.create',{projectId:project.id,type:'image',assetId:image.id,position:{x:0,y:0}});
 const target=await services.call('shot.create',{projectId:project.id,title:'Migration reference target'});
 const attached=await edit('reference.attach',{sourceNodeId:node.id,targetShotId:target.id,expectedSourceRevision:node.revision,expectedShotRevision:target.revision,role:'first_frame'});
 await edit('reference.detach',{edgeId:attached.edge.id,expectedShotRevision:attached.shot.revision});
 assert.deepEqual(new Set(recovered.map(item=>item.operation)),new Set(LEGACY_OPERATIONS));
 await tasks.drain();await services.drain();
 return {project,recovered};
}

function rollbackProbe(db: DatabaseSync,fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): unknown; }) {
 db.exec('SAVEPOINT migration_probe');
 try{return fn();}finally{db.exec('ROLLBACK TO migration_probe; RELEASE migration_probe');}
}
function candidate(db: DatabaseSync,{operation='timeline.track.add',lane='timeline:mutation',status='prepared',acknowledged=0,...patch}={}) {
 const projectId=String(db.prepare('SELECT id FROM projects').get()!.id),requestId=randomUUID(),id=randomUUID();
 const input={projectId,requestId,expectedRevision:1,kind:'audio'};
 const claimed=status==='dispatching'||status==='not_applied';
 return {position:null,id,projectId,operation,input:JSON.stringify(input),requestId,digest:hash({operation,input}),lane,
 origin:'new',status,revision:status==='prepared'?1:3,acknowledged,claim:claimed?randomUUID():null,
 claimInstance:claimed?randomUUID():null,receiptDigest:status==='applied'?'a'.repeat(64):null,
 errorCode:status==='not_applied'?'REVISION_CONFLICT':null,createdAt:WHEN,updatedAt:WHEN,bytes:16384,...patch};
}
function assertConstraintAndTriggerBehavior(db: DatabaseSync,{expanded}: { expanded: boolean; }) {
 const before=snapshot(db);
 for(const operation of LEGACY_OPERATIONS)rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:operation.startsWith('timeline.')?'timeline:mutation':'reference:mutation'});
  insertTask(db,row);assert.equal(db.prepare('SELECT operation FROM edit_tasks WHERE id=?').get(row.id)!.operation,operation);
 });
 const additions=['subject.create','subject.version.add','subject.binding.set'];
 for(const operation of additions)rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:'subject:mutation'});
  if(expanded){insertTask(db,row);assert.equal(db.prepare('SELECT lane FROM edit_tasks WHERE id=?').get(row.id)!.lane,'subject:mutation');}
  else assert.throws(()=>insertTask(db,row),/CHECK constraint failed/);
 });
 for(const operation of ['subject.delete','subject.get','subject.execute','subject.version.update','timeline.render','timeline.anything','reference.anything','generation.create'])rollbackProbe(db,()=>{
  const row=candidate(db,{operation,lane:operation.startsWith('subject.')?'subject:mutation':operation.startsWith('reference.')?'reference:mutation':'timeline:mutation'});
  assert.throws(()=>insertTask(db,row),/CHECK constraint failed/,operation);
 });
 for(const patch of [
  {operation:'reference.attach',lane:'timeline:mutation'}, {operation:'timeline.track.add',lane:'reference:mutation'},
  {operation:'subject.create',lane:'timeline:mutation'}, {operation:'timeline.track.add',lane:'subject:mutation'},
  {lane:'generic:mutation'}, {bytes:16383}, {revision:0}, {revision:Number.MAX_SAFE_INTEGER+1},
  {revision:1.5}, {acknowledged:1}, {status:'dispatching'}, {status:'applied'}, {status:'not_applied'},
  {claim:randomUUID()}, {origin:'legacy_session'}, {input:'[]'}, {input:'not JSON'},
  {input:JSON.stringify({projectId:randomUUID(),requestId:randomUUID()})}, {digest:'short'}, {createdAt:''},
 ])rollbackProbe(db,()=>{const row={...candidate(db),...patch};assert.throws(()=>insertTask(db,row),undefined as unknown as RegExp,JSON.stringify(patch));});
 rollbackProbe(db,()=>{const row=candidate(db);row.projectId=randomUUID();row.input=JSON.stringify({...JSON.parse(row.input),projectId:row.projectId});assert.throws(()=>insertTask(db,row),/FOREIGN KEY constraint failed/);});
 withoutForeignKeys(db,()=>rollbackProbe(db,()=>{
  const row=candidate(db);insertTask(db,row);
  const stored=db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(row.id);
  for(const key of ['position','id','projectId','operation','input','requestId','digest','lane','origin','createdAt','bytes']) {
   const changed=typeof stored![key]==='number'?stored![key]+1:`${stored![key]}!`;
   assert.throws(()=>db.prepare(`UPDATE edit_tasks SET ${quote(key)}=?,status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?`).run(changed,randomUUID(),randomUUID(),row.id),/edit task identities are immutable/,key);
  }
  assert.throws(()=>db.prepare('DELETE FROM edit_tasks WHERE id=?').run(row.id),/edit task identities must be retained/);
  for(const duplicate of [{...stored},{...stored,id:randomUUID(),position:null},{...stored,id:randomUUID(),requestId:randomUUID()}])
   assert.throws(()=>insertTask(db,duplicate),/edit task identities are immutable/);
  assert.throws(()=>db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(row.id),/edit task identities are immutable/);
  const otherKey=randomUUID();
  assert.throws(()=>insertTask(db,{...stored,position:null,id:randomUUID(),requestId:otherKey,input:JSON.stringify({...JSON.parse((stored!.input as string)),requestId:otherKey})}),/UNIQUE constraint failed: edit_tasks.projectId, edit_tasks.lane/);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id),/invalid edit task transition/);
  const claim=randomUUID(),instance=randomUUID();
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(claim,instance,row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1 WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(),randomUUID(),row.id);
  db.prepare("UPDATE edit_tasks SET status='not_applied',revision=revision+1,errorCode='REVISION_CONFLICT' WHERE id=?").run(row.id);
  assert.throws(()=>db.prepare("UPDATE edit_tasks SET acknowledged=1,revision=revision+1,errorCode='DIFFERENT' WHERE id=?").run(row.id),/invalid edit task transition/);
  db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id);
  assert.throws(()=>db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id),/invalid edit task transition/);
  // Acknowledgement releases precisely this project's lane but keeps the old identity.
  insertTask(db,{...row,id:randomUUID(),requestId:otherKey,input:JSON.stringify({...JSON.parse(row.input),requestId:otherKey})});
 }));
 rollbackProbe(db,()=>{
  const row=candidate(db);insertTask(db,row);
  db.prepare("UPDATE edit_tasks SET status='applied',receiptDigest=?,revision=revision+1 WHERE id=?").run('b'.repeat(64),row.id);
  assert.throws(()=>db.prepare('UPDATE edit_tasks SET receiptDigest=?,acknowledged=1,revision=revision+1 WHERE id=?').run('c'.repeat(64),row.id),/invalid edit task transition/);
  db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(row.id);
 });
 // sqlite_master text alone cannot prove the unique partial index or triggers
 // are active. Every probe above is rolled back, including sequence increments.
 assert.deepEqual(snapshot(db),before);
}





test('independent current kernels retain the original twelve service/receipt behaviors and all SQL guards',async t=>{
 const stores=[kernelFixture(t).store,kernelFixture(t).store];
 assert.deepEqual(DURABLE_EDIT_OPERATIONS,['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set','timeline.format.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply']);
 for(const operation of LEGACY_OPERATIONS)assert.equal(editTaskLane(operation),operation.startsWith('timeline.')?'timeline:mutation':'reference:mutation');
 for(const store of stores) {
  assertConstraintAndTriggerBehavior(store.db,{expanded:true});
  const {recovered}=await exerciseCurrentOperations(store);
  assert.equal(recovered.length,12);
  assert.equal(store.db.prepare('SELECT count(*) n FROM timeline_requests').get()!.n,10);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reference_requests').get()!.n,2);
  assert.deepEqual(store.db.prepare('SELECT * FROM subject_requests ORDER BY rowid').all(),[]);
 }
});
