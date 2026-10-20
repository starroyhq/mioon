import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {isTimelineMutationResponse} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest} from '../packages/contracts/src/timeline-loudness-apply.ts';
import type {TestContext} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
type Loose = Record<string, unknown>;
type Store = ReturnType<typeof openStore>;
type Services = ReturnType<typeof createServices>;
type Tasks = ReturnType<typeof createEditTasks>;
interface Entity {id: string; projectId?: string; revision?: number; tracks?: Array<{id: string; kind: string}>; clips?: Array<{id: string}>; [key: string]: unknown}
interface LoudnessReport {applyAllowed: boolean; candidate: {status: string; meetsTarget: boolean; meetsTruePeak: boolean; [key: string]: unknown}; identity: {snapshotSha256: string}; [key: string]: unknown}
interface ReplayValue {task: {status: string; digest: string}; restore: Loose; instanceId?: string}
interface ReplayList {items: Array<{id: string; status: string}>; restore?: {tasks: Array<{taskId: string; held: boolean}>}}
interface ReplayFixture {store: Store; services: Services; tasks: Tasks; input: Loose & {projectId: string; requestId: string}; response: Loose; receipt: string; taskId: string; result: Loose; asset: Loose; project: {id: string}; timeline: Entity; clipId: string; assertSourceUnchanged: ()=>void; removeRestoredMedia: ()=>void}

const operation='timeline.loudness.apply',sha=(bytes: Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function pcmWav(): Buffer{
 const frames=3*48000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
 bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
 for(let i=0;i<frames;i++){const sample=Math.round(.15*32767*Math.sin(2*Math.PI*997*i/48000));bytes.writeInt16LE(sample,44+i*4);bytes.writeInt16LE(-sample,46+i*4);}return bytes;
}
function tree(root: string): Array<unknown[]>{
 const visit=(relative: string): Array<unknown[]>=>{
  const file=path.join(root,relative),info=fs.lstatSync(file);
  if(info.isDirectory())return [[relative,{mode:info.mode}],...fs.readdirSync(file).sort().flatMap((name: string)=>visit(path.join(relative,name)))];
  return [[relative,{mode:info.mode,size:info.size,sha256:sha(fs.readFileSync(file))}]];
 };return visit('');
}
function rows(db: DatabaseSync): Record<string, Loose[]> {return Object.fromEntries(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all()
 .map((value: unknown)=>{const name=(value as {name: string}).name;return [name,db.prepare(`SELECT rowid,* FROM main."${name}" ORDER BY rowid`).all() as Loose[]];}));}

// Real public services + FFmpeg measurement + durable operation. The completed
// source is cleanly stopped before the independent cold backup and restore.
// Every historical DB owner remains present; only the edited clip is removed.
async function restored(t: TestContext,{alterReceipt}: {alterReceipt?: (value: Loose)=>void}={}): Promise<ReplayFixture> {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'restore-apply-replay-'));
 const source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');
 let sourceStore: Store=openStore(source),sourceServices: Services=createServices(sourceStore,new Map()),sourceTasks: Tasks|undefined;
 let store: Store|undefined,services: Services|undefined,tasks: Tasks|undefined;
 t.after(async()=>{
  await tasks?.drain().catch(()=>{});await services?.drain().catch(()=>{});store?.close();
  await sourceTasks?.drain().catch(()=>{});await sourceServices?.drain().catch(()=>{});sourceStore?.close();
  fs.rmSync(base,{recursive:true,force:true});
 });
 const project=await sourceServices.call('project.create',{name:'Real restored apply archive'}) as {id: string},assetId=randomUUID(),bytes=pcmWav();
 const asset: Loose={id:assetId,projectId:project.id,name:'Source.wav',mimeType:'audio/wav',relativePath:`media/${assetId}.wav`,sha256:sha(bytes),sizeBytes:bytes.length,
  duration:3,hasAudio:true,hasVideo:false,width:0,height:0,url:`/media/${assetId}`,createdAt:new Date().toISOString()};
 fs.writeFileSync(path.join(source,String(asset.relativePath)),bytes,{mode:0o600});sourceStore.put('assets',asset);
 let timeline=await sourceServices.call('timeline.get',{projectId:project.id}) as Entity;
 timeline=await sourceServices.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
  trackId:timeline.tracks!.find((track: {kind: string})=>track.kind==='audio')!.id,assetId,startFrame:0,durationFrames:60,gain:.75,fadeInFrames:0}) as Entity;
 const clipId=timeline.clips![0]!.id;
 const prepareInput={projectId:project.id,expectedRevision:timeline.revision,mixProfile:'timeline-float-mix-v1',
  measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
 const report=await sourceServices.call('timeline.loudness.prepare',prepareInput) as LoudnessReport;
 assert.equal(report.applyAllowed,false);assert.equal(report.candidate.status,'measured');assert.equal(report.candidate.meetsTarget,true);assert.equal(report.candidate.meetsTruePeak,true);
 const input={...prepareInput,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
 sourceTasks=createEditTasks({store:sourceStore,services:sourceServices});
 const prepared=sourceTasks.prepare({projectId:project.id,operation,input,origin:'new'}) as {task: {id: string; digest: string}; instanceId: string};
 const executed=await sourceTasks.execute({projectId:project.id,taskId:prepared.task.id,digest:prepared.task.digest,instanceId:prepared.instanceId}) as {task: {status: string}; result: Loose};
 assert.equal(executed.task.status,'applied');assert.equal(isTimelineMutationResponse(operation,input,executed.result),true);
 const response=executed.result,taskId=prepared.task.id;
 let receipt=sourceStore.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId)!.response as string;
 assert.equal(receipt,JSON.stringify(response));
 timeline=await sourceServices.call('timeline.clip.remove',{projectId:project.id,expectedRevision:(response.timeline as Loose).revision,requestId:randomUUID(),clipId}) as Entity;
 assert.equal(timeline.clips!.some((clip: {id: string})=>clip.id===clipId),false);
 if(alterReceipt){
  const altered=structuredClone(response);alterReceipt(altered);receipt=' \n'+JSON.stringify(altered,null,'\t')+'\n ';
  // Deliberately corrupt one synthetic stored ACK while restoring the exact
  // application-owned trigger definition. Production guards are not relaxed.
  const ddl=sourceStore.db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='immutable_timeline_responses'").get()!.sql as string;
  sourceStore.db.exec('DROP TRIGGER immutable_timeline_responses');
  sourceStore.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(receipt,input.requestId);
  sourceStore.db.exec(ddl);
 }
 const sourceRows=rows(sourceStore.db);
 await sourceTasks.drain();sourceTasks=undefined as unknown as Tasks;await sourceServices.drain();sourceServices=undefined as unknown as Services;sourceStore.close();sourceStore=undefined as unknown as Store;
 const sourceBefore=tree(source),created=await createWorkspaceBackup({source,destination:backup}),backupBefore=tree(backup);
 assert.equal(created.databaseSchemaVersion,50);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const result=await restoreWorkspaceBackup({directory:backup,destination});assert.equal(result.databaseSchemaVersion,51);
 assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
 store=openStore(destination);services=createServices(store,new Map());tasks=createEditTasks({store,services});
 const retained=rows(store.db);
 for(const [table,original] of Object.entries(sourceRows)){
  const captured=retained[table]!.filter((row: Loose)=>table!=='schema_version'||row['version']!==51).map((row: Loose)=>{
   const copy={...row};if(table==='edit_tasks')delete copy['executionEpoch'];return copy;
  });
  assert.deepEqual(captured.map((row: Loose)=>({...row})),original.map((row: Loose)=>({...row})),table);
 }
 return {store:store!,services:services!,tasks:tasks!,input,response,receipt,taskId,result,asset,project,timeline,clipId,
  assertSourceUnchanged(){assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);},
  removeRestoredMedia(){fs.unlinkSync(path.join(destination,String(asset.relativePath)));}};
}

test('real applied task restores held; get/list/replay retain original ACK after clip removal without media remeasurement',async t=>{
 const f=await restored(t);f.removeRestoredMedia();
 t.mock.method(globalThis,'fetch',()=>{throw Error('Historical replay must not use network');});
 const before=rows(f.store.db),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 const value=f.tasks.get({projectId:f.input.projectId,taskId:f.taskId}) as ReplayValue;assert.equal(value.task.status,'applied');
 assert.deepEqual(value.restore,{workspaceOrigin:f.result.workspaceOrigin,executionEpoch:'captured',held:true});
 const all=f.tasks.list({projectId:f.input.projectId,pendingOnly:false}) as ReplayList;assert.equal(all.items.find((item: {id: string})=>item.id===f.taskId)!.status,'applied');
 assert.equal(all.restore!.tasks.find((item: {taskId: string})=>item.taskId===f.taskId)!.held,true);assert.deepEqual(f.tasks.list({projectId:f.input.projectId}).items,[]);
 assert.deepEqual(f.tasks.reconcileStartup(),{processed:0,unavailable:0});
 assert.deepEqual(await f.services.call(operation,f.input),f.response);
 assert.equal(JSON.stringify(await f.services.call(operation,f.input)),f.receipt);
 const held={projectId:f.input.projectId,taskId:f.taskId,digest:value.task.digest};
 await assert.rejects(f.tasks.execute({...held,instanceId:value.instanceId},{expectedWorkspaceOrigin:f.result.workspaceOrigin}),{code:'RESTORED_RECORD_HELD'});
 assert.throws(()=>f.tasks.reconcile(held,{expectedWorkspaceOrigin:f.result.workspaceOrigin}),{code:'RESTORED_RECORD_HELD'});
 await assert.rejects(f.services.call(operation,{...f.input,requestId:randomUUID()}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 assert.throws(()=>f.tasks.prepare({projectId:f.input.projectId,operation,input:{...f.input,requestId:randomUUID()},origin:'new'},
  {expectedWorkspaceOrigin:f.result.workspaceOrigin}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 for(const patch of [{projectId:randomUUID()},{candidateDigest:'timeline-loudness-candidate-v1:'+'f'.repeat(64)},{expectedRevision:(f.input.expectedRevision as number)+1}])
  await assert.rejects(f.services.call(operation,{...f.input,...patch}),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(f.services.call('timeline.clip.update',{projectId:f.input.projectId,expectedRevision:f.input.expectedRevision,
  requestId:f.input.requestId,clipId:f.clipId,patch:{gain:.5}}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response,f.receipt);
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.deepEqual(rows(f.store.db),before);f.assertSourceUnchanged();
});

const corruptions: Array<[string,(value: Loose)=>void]> = [
 ['operation',(value: Loose)=>{value['operation']='timeline.clip.update';}],
 ['project',(value: Loose)=>{(value['timeline'] as Loose)['projectId']=randomUUID();}],
 ['request',(value: Loose)=>{value['requestId']=randomUUID();}],
 ['bare timeline',(value: Loose)=>{const timeline=value['timeline'];for(const key of Object.keys(value))delete value[key];Object.assign(value,timeline as Loose);}],
];
for(const [label,alterReceipt] of corruptions)
 test(`real source ACK corrupted to wrong ${label} remains archived but cannot replay`,async t=>{
  const f=await restored(t,{alterReceipt}),before=rows(f.store.db);
  await assert.rejects(f.services.call(operation,f.input),{code:'INVALID_TIMELINE_SNAPSHOT'});
  assert.throws(()=>f.tasks.get({projectId:f.input.projectId,taskId:f.taskId}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId)!.response,f.receipt);
  assert.deepEqual(rows(f.store.db),before);f.assertSourceUnchanged();
 });

for(const defect of ['foreign asset owner','missing current timeline','different current timeline id','current revision behind ACK'])
 test(`held apply replay still requires database ownership: ${defect}`,async t=>{
  const f=await restored(t);
  if(defect==='foreign asset owner'){
   const id=randomUUID();f.store.put('projects',{...f.project,id,name:'Synthetic foreign owner'});
   f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(id,JSON.stringify({...f.asset,projectId:id}),String(f.asset.id));
  }else if(defect==='missing current timeline')f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(f.timeline.id);
  else{
   const next: Loose={...f.timeline,...(defect==='different current timeline id'?{id:randomUUID()}:{revision:f.input.expectedRevision})};
   f.store.db.prepare('UPDATE timelines SET id=?,data=? WHERE id=?').run(next['id'] as string,JSON.stringify(next),f.timeline.id);
  }
  const before=rows(f.store.db);
  await assert.rejects(f.services.call(operation,f.input),{code:defect==='foreign asset owner'?'TIMELINE_SOURCE_UNAVAILABLE':'INVALID_TIMELINE_SNAPSHOT'});
  assert.deepEqual(rows(f.store.db),before);f.assertSourceUnchanged();
 });
