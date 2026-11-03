import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import type {SQLInputValue} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {validateImageConsumption} from '../packages/business/src/image-consumption.ts';
import {frameOutputResultSchema,sceneOutputResultSchema} from '../packages/contracts/src/project-output-sources.ts';
import {mp4HeaderFixture,mediaFixturePath} from './helpers/media-reference-fixtures.ts';
import {referenceTestAsset} from '../packages/business/src/project-file/test-asset-fixture.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const record=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const invalid={code:'INSPECTION_UNAVAILABLE'};
async function until(read:()=>unknown){for(let attempt=0;attempt<2000;attempt++){const value=record(await read());if(value.state==='succeeded')return value;await pause(5);}assert.fail('Local output did not finish');}
async function fixture(t:TestContext){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-portable-derived-'))),original=openStore(path.join(root,'original')),projectId=original.projectId;
 original.put('projects',{id:projectId,name:'Portable derived images',revision:1});
 const sourceId=randomUUID(),sourceBytes=mp4HeaderFixture('portable source whose decoder is explicitly stubbed'),relativePath=`media/${sourceId}.mp4`,sourceHash=hash(sourceBytes);
 writeFileSync(path.join(original.projectDir,relativePath),sourceBytes,{mode:0o600});
 original.put('assets',{id:sourceId,projectId,name:'Source.mp4',mimeType:'video/mp4',sha256:sourceHash,sizeBytes:sourceBytes.length,relativePath,width:16,height:16,duration:3,provenance:'user-import'});
 const bytes=png({width:16,height:16,rgba:false,tagged:false}),probe={streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:16,height:16,rotation:0,sarNumerator:1,sarDenominator:1};
 const frames=createFrameServices(original,{decode:async input=>{input!.beforeSpawn!(input!.signal!);return {bytes,metadata:{mimeType:'image/png',width:16,height:16,byteLength:bytes.length,sha256:hash(bytes)},provenance:{profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceFrame:Number(input!.requestedFrame),fps:30,sourceHash,probe}};}});
 const scenes=createSceneServices(original,{detect:async input=>{input.beforeSpawn!(input.signal!);return {profileId:'scene-cuts-v1',fps:30,frameCount:90,options:{mode:'adaptive',sensitivity:60,minShotSeconds:0.6},cuts:[{frame:30,score:0.8}],segments:[],sourceHash,analysis:{width:256,height:144,decodedFrames:90}};},
  decodeKeyframes:async input=>{input.beforeSpawn!(input.signal!);input.marks!.forEach((_,index)=>input.onFrame!({index,marks:[index],bytes}));return {profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceHash,width:16,height:16,probe,frameOf:input.marks!.map((_,index)=>index)};}});
 let originalClosed=false,received:ReturnType<typeof openStore>|undefined;
 t.after(async()=>{try{if(!originalClosed){await frames.drain();await scenes.drain();original.close();}received?.close();}finally{rmSync(root,{recursive:true,force:true});}});
 const frameAck=record(await frames.handlers['frame.extract']!({projectId,sourceAssetId:sourceId,sourceHash,sourceFrame:7,requestId:randomUUID()}));
 const frame=await until(()=>frames.handlers['frame.task.get']!({projectId,taskId:frameAck.id}));
 const detectAck=record(await scenes.handlers['scene.detect']!({projectId,sourceAssetId:sourceId,sourceHash,requestId:randomUUID()}));
 const detected=await until(()=>scenes.handlers['scene.task.get']!({projectId,taskId:detectAck.id}));
 const sceneAck=record(await scenes.handlers['scene.shots.create']!({projectId,sourceAssetId:sourceId,sourceHash,resultId:record(detected.result).id,segments:[2],requestId:randomUUID()}));
 const scene=await until(()=>scenes.handlers['scene.task.get']!({projectId,taskId:sceneAck.id}));
 const frameId=String(record(frame.result).assetId),sceneId=String(record((scene.shots as unknown[])[0]).assetId),graph=createOwnedMediaGraphReader(original.db,projectId);
 const frameSource=graph.frameSource(frameId),sceneSource=graph.sceneKeyframeSource(sceneId),frameAsset=record(original.get('assets',frameId)),sceneAsset=record(original.get('assets',sceneId));
 const local={frameTask:original.db.prepare('SELECT * FROM frame_tasks WHERE id=?').get(String(frameAck.id))!,frameRequest:original.db.prepare('SELECT * FROM frame_requests WHERE requestId=?').get(String(frameAck.requestId))!,
  sceneTask:original.db.prepare('SELECT * FROM scene_tasks WHERE id=?').get(String(sceneAck.id))!,sceneRequest:original.db.prepare('SELECT * FROM scene_requests WHERE requestId=?').get(String(sceneAck.requestId))!};
 await frames.drain();await scenes.drain();original.close();originalClosed=true;
 const receivedDir=path.join(root,'received');mkdirSync(receivedDir,{mode:0o700});
 // Copy only portable project contents. No history, cache, staging or
 // publication intent is copied to the receiving machine's local records.
 cpSync(path.join(root,'original','project.mioon'),path.join(receivedDir,'project.mioon'));
 for(const directory of ['media','生成'])cpSync(path.join(root,'original',directory),path.join(receivedDir,directory),{recursive:true,preserveTimestamps:true});
 received=openProjectStore({projectFile:path.join(receivedDir,'project.mioon'),locate:()=>({localDir:path.join(root,'received-records'),cacheDir:path.join(root,'received-cache'),tempDir:path.join(root,'received-temp')})});
 return {store:received,projectId,frameId,sceneId,frameSource,sceneSource,frameAsset,sceneAsset,local};
}

test('project-only copies keep frame and storyboard provenance without local history or writes',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM frame_tasks').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM scene_tasks').get()!.n,0);
 const graph=createOwnedMediaGraphReader(f.store.db,f.projectId);
 assert.deepEqual(graph.asset(f.frameId),f.frameAsset);assert.deepEqual(graph.asset(f.sceneId),f.sceneAsset);
 assert.deepEqual(graph.frameSource(f.frameId),f.frameSource);assert.deepEqual(graph.sceneKeyframeSource(f.sceneId),f.sceneSource);
 assert.equal(validateImageConsumption(f.store.db,{id:f.frameId,provenance:'extracted-frame'},f.projectId).id,f.frameId);
 assert.equal(validateImageConsumption(f.store.db,{id:f.sceneId,provenance:'scene-keyframe'},f.projectId).id,f.sceneId);
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
});

test('portable source, selected frame, request, profile and publication tampering is rejected',async t=>{
 const f=await fixture(t);
 for(const kind of ['frame','scene'] as const){
  const asset=kind==='frame'?f.frameAsset:f.sceneAsset,id=String(asset.id);
  for(const damage of ['source','mark','request','profile','owner','missing','relabel','segment-and-mark'] as const){
   const changed=structuredClone(asset),field=kind==='frame'?'frameResult':'sceneResult',result=record(changed[field]),receipt=record(result.receipt);
   if(damage==='source')receipt.sourceHash='f'.repeat(64);
   if(damage==='mark'){if(kind==='frame')receipt.sourceFrame=8;else record((receipt.keyframes as unknown[])[0]).sourceFrame=61;}
   if(damage==='request')result.requestId=randomUUID();
   if(damage==='profile')receipt.profileId='unknown-profile';
   if(damage==='owner')record(record(changed.publication).owner).id=randomUUID();
   if(damage==='missing')delete changed[field];
   if(damage==='relabel')changed.provenance='user-import';
   if(damage==='segment-and-mark'){if(kind==='frame')receipt.sourceFrame=8;else{result.segment=[2,40,90];record((receipt.keyframes as unknown[])[0]).sourceFrame=65;}}
   f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(changed),id);
   assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(id),invalid,`${kind} ${damage}`);
  }
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),id);
 }
 assert.equal(frameOutputResultSchema.safeParse({...record(f.frameAsset.frameResult),extra:true}).success,false);
 assert.equal(sceneOutputResultSchema.safeParse({...record(f.sceneAsset.sceneResult),extra:true}).success,false);
});

test('a detached local task cannot fall back to its portable success facts',async t=>{
 const f=await fixture(t);
 const insert=(table:string,value:Record<string,SQLInputValue>)=>{const names=Object.keys(value);f.store.db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(value));};
 f.store.tx(()=>{
  insert('frame_tasks',{...f.local.frameTask,state:'queued',revision:1,started:0,assetId:null,stagedReceipt:null,errorCode:null,updatedAt:f.local.frameTask.createdAt!});
  insert('frame_requests',f.local.frameRequest);
  f.store.db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(f.local.frameTask.id!);
  f.store.db.prepare("UPDATE frame_tasks SET state='interrupted',revision=3,errorCode='FRAME_INTERRUPTED' WHERE id=?").run(f.local.frameTask.id!);
  insert('scene_tasks',{...f.local.sceneTask,state:'queued',revision:1,started:0,stagedReceipt:null,outcome:null,errorCode:null,updatedAt:f.local.sceneTask.createdAt!});
  insert('scene_requests',f.local.sceneRequest);
  f.store.db.prepare("UPDATE scene_tasks SET state='running',started=1,revision=2 WHERE id=?").run(f.local.sceneTask.id!);
  f.store.db.prepare("UPDATE scene_tasks SET state='interrupted',revision=3,errorCode='SCENE_INTERRUPTED' WHERE id=?").run(f.local.sceneTask.id!);
 });
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(f.frameId),invalid);
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(f.sceneId),invalid);
});

test('same-content relinks retain portable frame and scene facts while a bad full hash or owner still fails',async t=>{
 const f=await fixture(t);mkdirSync(path.join(f.store.projectDir,'素材'),{mode:0o755});
 for(const [kind,asset] of [['frame',f.frameAsset],['scene',f.sceneAsset]] as const){
  const relativePath=`素材/relinked-${kind}.png`,bytes=readFileSync(mediaFixturePath(f.store.projectDir,asset));writeFileSync(path.join(f.store.projectDir,relativePath),bytes);
  const locator=referenceTestAsset(f.store.projectDir,{relativePath,sha256:asset.sha256,sizeBytes:asset.sizeBytes}),relinked:Record<string,unknown>={...asset,...locator,referenceRevision:2};
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(relinked),String(asset.id));
  const graph=createOwnedMediaGraphReader(f.store.db,f.projectId);assert.deepEqual(graph.asset(String(asset.id)),relinked);
  assert.deepEqual(kind==='frame'?graph.frameSource(asset.id):graph.sceneKeyframeSource(asset.id),kind==='frame'?f.frameSource:f.sceneSource);
  const badHash={...relinked,reference:{...record(relinked.reference),fullSha256:'f'.repeat(64)}};
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(badHash),String(asset.id));assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(asset.id),invalid);
  const wrongOwner=structuredClone(relinked);record(record(wrongOwner.publication).owner).id=randomUUID();
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(wrongOwner),String(asset.id));assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(asset.id),invalid);
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(relinked),String(asset.id));
 }
});
