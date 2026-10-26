import type {OpacityTasks} from './helpers/strict-opacity-fixture-types.ts';
import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Replace only codec transport. The application creates its project/timeline,
// imports and hashes managed bytes, then uses the real durable coordinator,
// source graph, transaction/history/receipts and candidate ACK grammar.
let childAttempts=0,codecCalls=0;
const forbidden=()=>{childAttempts++;throw Error('No native child is allowed in application task integration');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const)mock.method(cp,name,forbidden);
syncBuiltinESMExports();
const runtimeUrl=new URL('../packages/business/src/media-runtime.ts',import.meta.url).href;
const actualUrl=runtimeUrl+'?opacity-application-tasks-actual';
const hookKey=Symbol.for('mioon.test.opacity-application-tasks-codec');
(globalThis as unknown as Record<symbol,unknown>)[hookKey]=async(command: unknown,argv: fs.PathLike[],options: import('../packages/business/src/media-runtime.ts').MediaRunOptions={})=>{
 assert.equal(command,'ffprobe');assert.ok(fs.lstatSync(argv.at(-1)!).isFile());options.beforeSpawn?.();options.beforeEffect?.();codecCalls++;
 return JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'h264',width:64,height:48,duration:'2',avg_frame_rate:'30/1',r_frame_rate:'30/1'}],format:{duration:'2'}});
};
const hooks=registerHooks({load(url,context,next){return url===runtimeUrl?{format:'module',shortCircuit:true,
 source:`export * from ${JSON.stringify(actualUrl)};export const run=(...args)=>globalThis[Symbol.for("mioon.test.opacity-application-tasks-codec")](...args);`}:next(url,context);}});
const {openNewOpacityCandidateApplicationStore,openOpacityCandidateStore}=await import('../packages/business/src/opacity-candidate-store.ts');
const {createOpacityCandidateApplicationServices,createOpacityCandidateServices}=await import('../packages/business/src/opacity-candidate-services.ts');
const {createEditTasks}=await import('../packages/business/src/edit-tasks.ts');
const {isOpacityApplicationMutationResponse,isOpacityApplicationTask}=await import('../packages/contracts/src/timeline-opacity-persistence.ts');
const {onMediaProcess}=await import('../packages/business/src/media-processes.ts');
const media: unknown[]=[],off=onMediaProcess(event=>media.push(event));
after(()=>{off();hooks.deregister();delete (globalThis as unknown as Record<symbol,unknown>)[hookKey];mock.restoreAll();syncBuiltinESMExports();assert.equal(childAttempts,0);assert.deepEqual(media,[]);});
const curve=()=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:.25},{frame:20,opacity:1}]});
function fixture(t: test.TestContext){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-opacity-app-tasks-'));
 const root=path.join(parent,'new42'),store=(openNewOpacityCandidateApplicationStore(root) as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureStore),services=(createOpacityCandidateApplicationServices(store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityServices),tasks=(createEditTasks({store,services}) as unknown as OpacityTasks);
 t.after(async()=>{try{await tasks.drain();await services.drain();store.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 return {root,store,services,tasks,
  async mutate(projectId: unknown,operation: string,fields={}){
   const timeline=await services.call('timeline.get',{projectId});
   const input={projectId,requestId:randomUUID(),expectedRevision:timeline.revision,...fields};
   const prepared=tasks.prepare({projectId,operation,input,origin:'new'});
   assert.equal(prepared.task.status,'prepared');assert.equal(isOpacityApplicationTask(prepared.task),true);assert.deepEqual(prepared.task.input,input);
   const applied=await tasks.execute({projectId,taskId:prepared.task.id,digest:prepared.task.digest,instanceId:prepared.instanceId});
   assert.equal(applied.task.status,'applied',JSON.stringify(applied));
   assert.equal(isOpacityApplicationMutationResponse(operation,input,applied.result),true);
   const ack=tasks.acknowledge({projectId,taskId:applied.task.id,digest:applied.task.digest,expectedRevision:applied.task.revision,status:'applied'});
   assert.equal(ack.task.acknowledged,true);
   assert.deepEqual((await tasks.execute({projectId,taskId:prepared.task.id,digest:prepared.task.digest,instanceId:prepared.instanceId})).result,applied.result);
   return {input,...applied};
  },
 };
}

test('new42 actual application creates project, imports source and durably adds/removes clips with exact opacity history',async t=>{
 const f=fixture(t);assert.deepEqual(await f.services.call('project.list',{}),[]);
 const project=await f.services.call('project.create',{name:'Synthetic application tasks'}),projectId=project.id;
 const initial=await f.services.call('timeline.get',{projectId});assert.equal(initial.clips.length,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests').get()!.n,0,'no preseeded timeline mutation');
 const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(48)]),beforeCodec=codecCalls;
 const asset=await f.services.call('asset.import',{projectId,name:'Synthetic application source.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
 assert.equal(codecCalls,beforeCodec+1);assert.equal(asset.provenance,'user-import');assert.deepEqual(fs.readFileSync(path.join(f.root,asset.relativePath)),bytes);
 const addedTrack=await f.mutate(projectId,'timeline.track.add',{kind:'video',name:'Opacity overlay'});
 const track=addedTrack.result!.tracks.find((item)=>item.name==='Opacity overlay');assert.ok(track);
 await f.mutate(projectId,'timeline.track.update',{trackId:track.id,patch:{name:'Opacity track'}});
 const clips: import('./helpers/strict-timeline-core-types.ts').FixtureClip[]=[];
 for(const [index,state]of ['absent','null','curve'].entries()){
  const fields:Record<string,unknown>&{assetId:string;trackId:string;name:string;startFrame:number;durationFrames:number}={assetId:asset.id,trackId:track.id,name:`${state} clip`,startFrame:index*20,durationFrames:20};
  if(state!=='absent')fields.opacityEnvelope=state==='null'?null:curve();
  const saved=await f.mutate(projectId,'timeline.clip.add',fields),clip=saved.result!.clips.find((item)=>item.name===fields.name);
  assert.equal(Object.hasOwn(clip!,'opacityEnvelope'),state!=='absent');if(state!=='absent')assert.deepEqual(clip!.opacityEnvelope,fields.opacityEnvelope);clips.push(((clip) as unknown as Parameters<typeof clips.push>[0]));
 }
 const update=await f.mutate(projectId,'timeline.clip.update',{clipId:clips[0].id,patch:{opacityEnvelope:curve()}});
 assert.deepEqual(update.result!.clips.find((item)=>item.id===clips[0].id)!.opacityEnvelope,curve());
 const removed=await f.mutate(projectId,'timeline.clip.remove',{clipId:clips[1].id});assert.equal(removed.result!.clips.some((item)=>item.id===clips[1].id),false);
 const undone=await f.mutate(projectId,'timeline.undo');assert.equal(undone.result!.clips.find((item)=>item.id===clips[1].id)!.opacityEnvelope,null);
 const redone=await f.mutate(projectId,'timeline.redo');assert.equal(redone.result!.clips.some((item)=>item.id===clips[1].id),false);
 const projectView=await f.services.call('project.get',{projectId});assert.deepEqual(projectView.timeline,redone.result);assert.equal(projectView.assets.length,1);
 assert.equal(f.tasks.list({projectId}).items.length,0);
 const retained=f.tasks.list({projectId,pendingOnly:false});assert.equal(retained.items.length,9);assert.ok(retained.items.every(isOpacityApplicationTask));
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests').get()!.n,9);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_history').get()!.n,7);
});

test('application task binding refuses service copies and cannot broaden an ordinary42 store',async t=>{
 const f=fixture(t),parent=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-opacity-task-ordinary-')),ordinary=(openOpacityCandidateStore(parent) as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureStore),services=(createOpacityCandidateServices(ordinary) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityServices);
 t.after(async()=>{try{await services.drain();ordinary.close();}finally{fs.rmSync(parent,{recursive:true,force:true});}});
 assert.throws(()=>(createEditTasks({store:f.store,services:{...f.services}}) as unknown as OpacityTasks),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
 assert.throws(()=>(createEditTasks({store:f.store,services}) as unknown as OpacityTasks),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
 const ordinaryTasks=(createEditTasks({store:ordinary,services}) as unknown as OpacityTasks);t.after(()=>ordinaryTasks.drain());
 const project=await f.services.call('project.create',{name:'Private task owner'});
 assert.throws(()=>ordinaryTasks.prepare({projectId:project.id,operation:'timeline.track.add',input:{projectId:project.id,requestId:randomUUID(),expectedRevision:1,kind:'video'},origin:'new'}),{code:'EDIT_TASK_VALIDATION'});
 assert.equal(ordinary.db.prepare('SELECT count(*) AS n FROM edit_tasks').get()!.n,0);
});
