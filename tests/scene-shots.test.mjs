import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,existsSync,readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {validateImageConsumption} from '../packages/business/src/image-consumption.ts';
import {createPngStreamSplitter,keyframeTargets,decodeSceneKeyframes} from '../packages/business/src/scene-keyframe-decoder.ts';
import {decodeManagedFrame} from '../packages/business/src/frame-decoder.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {RESTORE_DENIED_OPERATIONS,RESTORE_READ_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {AGENT_TASK_OPERATION_ADMISSION} from '../packages/business/src/agent/task-tools-v2.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {SCENE_KEYFRAME_PROVENANCE,SCENE_LIMITS,schemas,descriptions,operationEffect,isSceneTaskResponse,isSceneMutationResponse,isSceneRequestResponse,isSceneListResponse,
 canonicalSceneInput,sceneShotPlan,sceneSegmentBounds} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=(expected,check=()=>true)=>error=>error.code===expected&&!JSON.stringify(error).includes('PRIVATE_SENTINEL')&&check(error);
const proven=(operation,input)=>error=>{
 const proof=error.details?.sceneOutcome;
 return proof?.status==='not_accepted'&&proof.operation===operation&&proof.projectId===input.projectId&&proof.requestId===input.requestId&&proof.inputHash===digest(canonicalSceneInput(input));
};
const refused=(expected,operation,input)=>error=>code(expected)(error)&&proven(operation,input)(error);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function until(read,label){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(5);}assert.fail(`Timed out: ${label}`);}
const W=320,H=180;
const probe={streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:W,height:H,rotation:0,sarNumerator:1,sarDenominator:1};
const still=(index,{width=W,height=H}={})=>png({width,height,rgba:false,tagged:false,pixel:()=>[(index*60)%256,120,200]});
/** A decoder stand-in: one output frame per mark unless groups say otherwise. */
function keyframes(input,{groups=input.marks.map((_,index)=>[index]),image=still}={}){
 input.beforeSpawn(input.signal);
 groups.forEach((marks,index)=>input.onFrame({index,marks,bytes:image(index)}));
 return {profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceHash:input.asset.sha256,width:W,height:H,probe,frameOf:groups.flatMap((marks,index)=>marks.map(()=>index))};
}
const rows=db=>JSON.stringify(['scene_tasks','scene_requests','scene_results','shots','assets'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const staging=root=>existsSync(path.join(root,'scene-staging'))?readdirSync(path.join(root,'scene-staging')):[];

function open(root,{decode,detect,fault,cuts=[30,900],frameCount=1800,autoRun=true,lock=true,real=false}={}){
 const store=openStore(root,{lock});let decodes=0;
 const holds=new Map();
 const services=createSceneServices(store,{autoRun,fault,...(real?{}:{
  detect:async input=>{
   input.beforeSpawn(input.signal);if(detect)return detect(input);
   await holds.get(input.asset.id)?.promise;
   return {profileId:'scene-cuts-v1',fps:30,frameCount,options:input.options,cuts:cuts.map((frame,index)=>({frame,score:0.4+index/100})),segments:[],sourceHash:input.asset.sha256,analysis:{width:256,height:144,decodedFrames:frameCount}};
  },
  decodeKeyframes:async input=>{decodes++;return decode?decode(input):keyframes(input);},
 })});
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;try{await services.drain();}finally{store.close();}};
 const call=async(op,input)=>services.handlers[op](input);
 return {store,services,call,close,holds,get decodes(){return decodes;}};
}
function fixture(t,options={}){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-scene-shots-'))),closers=[];
 // Every store on this root closes before the root is removed.
 t.after(async()=>{try{for(const close of closers.reverse())await close();}finally{rmSync(root,{recursive:true,force:true});}});
 const reopen=(patch={})=>{const value=open(root,patch);closers.push(value.close);return value;};
 const opened=reopen(options),{store,call}=opened;
 const project=store.put('projects',{id:randomUUID(),name:'Storyboard project',revision:1}),other=store.put('projects',{id:randomUUID(),name:'Other project',revision:1});
 const video=(patch={})=>{
  const bytes=Buffer.from(`Synthetic reference film ${randomUUID()} PRIVATE_SENTINEL`),id=randomUUID(),relativePath=`media/${id}.mp4`;
  writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
  return store.put('assets',{id,projectId:project.id,name:'Reference.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:W,height:H,duration:60,provenance:'user-import',...patch});
 };
 const asset=video();
 const get=id=>call('scene.task.get',{projectId:project.id,taskId:id});
 const state=(id,expected)=>until(async()=>{const value=await get(id);return value.state===expected&&value;},expected);
 const detected=async(source=asset)=>{
  const ack=await call('scene.detect',{projectId:project.id,sourceAssetId:source.id,sourceHash:source.sha256,requestId:randomUUID()});
  return (await state(ack.id,'succeeded')).result.id;
 };
 return {...opened,get decodes(){return opened.decodes;},root,project,other,asset,video,get,state,detected,reopen,track:close=>closers.push(close),
  input:(resultId,patch={})=>({projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,resultId,segments:[1,2,3],requestId:randomUUID(),...patch}),
  control:(value,patch={})=>({projectId:project.id,taskId:value.id,expectedRevision:value.revision,requestId:randomUUID(),...patch}),
  shots:()=>store.list('shots',project.id),
  images:()=>store.list('assets',project.id).filter(item=>item.provenance===SCENE_KEYFRAME_PROVENANCE)};
}

test('storyboard operations are registered, described, effect-annotated, restore-classified, localized and tiered for Mio', ()=>{
 for(const operation of ['scene.shots.create','scene.shots.undo']){
  assert.ok(schemas[operation]&&descriptions[operation].length>30,operation);
  assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
  for(const locale of ['zh-Hant','en','ja'])assert.ok(translate(locale,`operation.${operation}`).length>30,`${operation} ${locale}`);
  const effect=operationEffect(operation);
  assert.equal(effect.readOnly,false);assert.equal(effect.paidGeneration,false);assert.equal(effect.externalIO,false);assert.equal(effect.idempotent,true);
  assert.ok(RESTORE_DENIED_OPERATIONS.includes(operation)&&!RESTORE_READ_OPERATIONS.includes(operation),operation);
 }
 for(const operation of ['scene.task.get','scene.task.list','scene.task.cancel'])assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
 assert.equal(operationEffect('scene.shots.create').localProcess,true);
 assert.deepEqual(AGENT_TASK_OPERATION_ADMISSION['scene.shots.create'],{allowed:true,tier:'local_irreversible'});
 assert.equal(AGENT_TASK_OPERATION_ADMISSION['scene.shots.undo'].allowed,false);
 assert.ok(translate('zh-Hans','agent.display.operation.scene.shots.create'));
});

test('segments, titles, keyframe marks, durations and positions follow the result', ()=>{
 assert.deepEqual([1,2,3,4,0].map(segment=>sceneSegmentBounds([30,900],1800,segment)),[[0,30],[30,900],[900,1800],null,null]);
 assert.deepEqual(sceneSegmentBounds([],90,1),[0,90]);
 const plan=sceneShotPlan({titlePrefix:'参考',origin:{x:10,y:20},segments:[[1,0,30],[2,30,900],[3,900,1800],[4,1800,1801],[5,1801,1803],[6,1803,1806],[7,1806,1850]]});
 assert.deepEqual(plan.map(item=>item.title),['参考 01','参考 02','参考 03','参考 04','参考 05','参考 06','参考 07']);
 assert.deepEqual(plan.map(item=>item.sourceFrame),[15,465,1350,1800,1802,1804,1828]);
 assert.deepEqual(plan.map(item=>item.duration),[1,20,20,1,1,1,1],'whole seconds within a shot\'s 1–20');
 assert.deepEqual(plan.map(item=>item.position),[{x:10,y:20},{x:350,y:20},{x:690,y:20},{x:1030,y:20},{x:1370,y:20},{x:1710,y:20},{x:10,y:320}],'rows of six');
 assert.equal(sceneShotPlan({titlePrefix:'Ref',origin:{x:0,y:0},segments:[[123,0,45]]})[0].title,'Ref 123');
 assert.equal(sceneShotPlan({titlePrefix:'参考',origin:{x:0,y:0},segments:[[1,0,45]]})[0].duration,2,'1.5 s rounds to 2 s');
});

test('acceptance freezes the plan, replays exactly and refuses with proofs', async t=>{
 const release=deferred(),f=fixture(t,{decode:async input=>{await release.promise;return keyframes(input);}}),resultId=await f.detected();
 const input=f.input(resultId,{segments:[1,3]}),ack=await f.call('scene.shots.create',input);
 assert.ok(isSceneTaskResponse(ack));assert.ok(isSceneMutationResponse('scene.shots.create',input,ack));
 assert.deepEqual([ack.kind,ack.state,ack.revision,ack.started,ack.shots,ack.progress,ack.undo,ack.errorCode],['shots','queued',1,false,null,null,null,null]);
 assert.deepEqual([ack.resultId,ack.segments,ack.titlePrefix,ack.aspectRatio],[resultId,[1,3],'参考','9:16']);
 assert.deepEqual(await f.call('scene.shots.create',input),ack,'exact replay');
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:input.requestId});
 assert.ok(isSceneRequestResponse(receipt));assert.deepEqual(receipt,{projectId:f.project.id,requestId:input.requestId,operation:'scene.shots.create',response:ack});
 for(const patch of [{segments:[1,2]},{titlePrefix:'Ref'},{position:{x:0,y:0}},{projectId:f.other.id}])
  await assert.rejects(f.call('scene.shots.create',{...input,...patch}),code('SCENE_REQUEST_CONFLICT'));
 // One scene task per video at a time; a storyboard in progress locks the cut list.
 const again=f.input(resultId),detect={projectId:f.project.id,sourceAssetId:f.asset.id,sourceHash:f.asset.sha256,requestId:randomUUID()};
 const save={projectId:f.project.id,assetId:f.asset.id,sourceHash:f.asset.sha256,expectedResultId:resultId,cuts:[30],requestId:randomUUID()};
 await assert.rejects(f.call('scene.shots.create',again),refused('SCENE_TASK_ACTIVE','scene.shots.create',again));
 await assert.rejects(f.call('scene.detect',detect),refused('SCENE_TASK_ACTIVE','scene.detect',detect));
 await assert.rejects(f.call('scene.cuts.save',save),refused('SCENE_TASK_ACTIVE','scene.cuts.save',save));
 for(const patch of [{segments:[]},{segments:[2,1]},{segments:[1,1]},{segments:[0]},{segments:Array.from({length:101},(_,index)=>index+1)},{titlePrefix:''},{titlePrefix:'x'.repeat(41)},{position:{x:1}},{resultId:'nope'}])
  await assert.rejects(f.call('scene.shots.create',f.input(resultId,patch)),code('VALIDATION_ERROR'),JSON.stringify(patch).slice(0,40));
 release.resolve();await f.state(ack.id,'succeeded');
 const newer=await f.call('scene.cuts.save',{...save,requestId:randomUUID()});
 const stale=f.input(resultId);
 await assert.rejects(f.call('scene.shots.create',stale),refused('SCENE_RESULT_CONFLICT','scene.shots.create',stale));
 const beyond=f.input(newer.id,{segments:[1,2,3]});
 await assert.rejects(f.call('scene.shots.create',beyond),refused('SCENE_SEGMENTS_INVALID','scene.shots.create',beyond),'the newer result has two segments');
 const changed=f.input(newer.id,{sourceHash:'b'.repeat(64),segments:[1]});
 await assert.rejects(f.call('scene.shots.create',changed),refused('SCENE_SOURCE_CHANGED','scene.shots.create',changed));
 f.store.put('assets',{...f.store.get('assets',f.asset.id),sha256:'c'.repeat(64)});
 const outdated=f.input(newer.id,{sourceHash:'c'.repeat(64),segments:[1]});
 await assert.rejects(f.call('scene.shots.create',outdated),refused('SCENE_RESULT_STALE','scene.shots.create',outdated));
 await assert.rejects(f.call('scene.shots.create',f.input(newer.id,{projectId:f.other.id})),code('SCENE_NOT_FOUND'));
});

test('a built storyboard saves its keyframe images and shots in one step', async t=>{
 const f=fixture(t),resultId=await f.detected();
 f.store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),f.project.id,JSON.stringify({projectId:f.project.id,fps:30,width:1920,height:1080}));
 const projectRevision=f.store.get('projects',f.project.id).revision;
 const input=f.input(resultId,{titlePrefix:'Ref',position:{x:500,y:700}}),ack=await f.call('scene.shots.create',input);
 assert.equal(ack.aspectRatio,'16:9','new shots follow the project format');
 const done=await f.state(ack.id,'succeeded');
 assert.deepEqual([done.revision,done.started,done.errorCode,done.progress],[4,true,null,null]);
 assert.deepEqual(done.undo,{available:true,blockers:[]});
 assert.deepEqual(done.shots.map(item=>item.segment),[1,2,3]);
 const shots=f.shots().sort((a,b)=>a.orderIndex-b.orderIndex),images=f.images();
 assert.deepEqual(shots.map(item=>item.id),done.shots.map(item=>item.shotId));
 assert.deepEqual(shots.map(({title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId})=>({title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId})),
  done.shots.map((item,index)=>({title:`Ref 0${index+1}`,prompt:'',referenceAssetIds:[item.assetId],aspectRatio:'16:9',duration:[1,20,20][index],parameters:{},
   position:{x:500+index*340,y:700},orderIndex:index,revision:1,selectedVersionId:null})));
 assert.equal(images.length,3);
 for(const [index,item] of done.shots.entries()){
  const image=f.store.get('assets',item.assetId),bytes=readFileSync(path.join(f.root,image.relativePath));
  assert.deepEqual([image.name,image.mimeType,image.width,image.height,image.sizeBytes,image.relativePath,image.provenance],
   [`Ref 0${index+1}.png`,'image/png',W,H,bytes.length,`media/${item.assetId}.png`,'scene-keyframe']);
  assert.equal(image.sha256,digest(bytes));assert.deepEqual(bytes,still(index));
  // Keyframes are owned images: the media graph and image consumers accept them.
  assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(item.assetId).id,item.assetId);
  assert.equal(validateImageConsumption(f.store.db,image,f.project.id).id,item.assetId);
 }
 assert.equal(f.store.get('projects',f.project.id).revision,projectRevision+1);
 assert.deepEqual(staging(f.root),[],'staged keyframes are removed');
 assert.equal(f.decodes,1,'one decode for every segment');
 const page=await f.call('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id});
 assert.ok(isSceneListResponse('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id},page));
 assert.deepEqual(page.items[0],{...done,undo:null},'pages leave undo to task.get');
 assert.deepEqual(await f.call('scene.shots.create',input),ack,'the original acknowledgement replays after success');
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:input.requestId});assert.equal(receipt.response.shots,null);
 // A keyframe whose row no longer matches its receipt, or a forged one, is refused.
 const first=f.store.get('assets',done.shots[0].assetId);
 f.store.put('assets',{...first,sizeBytes:first.sizeBytes+1});
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.project.id).asset(first.id),code('INSPECTION_UNAVAILABLE'));
 assert.throws(()=>validateImageConsumption(f.store.db,f.store.get('assets',first.id),f.project.id),code('IMAGE_SOURCE_INVALID'));
 f.store.put('assets',first);
 const forged=f.store.put('assets',{...first,id:randomUUID(),relativePath:'media/forged.png'});
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.project.id).asset(forged.id),code('INSPECTION_UNAVAILABLE'));
});

test('without a position the batch goes below the canvas content and continues the order', async t=>{
 const f=fixture(t),resultId=await f.detected();
 f.store.put('shots',{id:randomUUID(),projectId:f.project.id,title:'Existing',prompt:'',referenceAssetIds:[],aspectRatio:'9:16',duration:2,parameters:{},position:{x:0,y:400},orderIndex:4,revision:1,selectedVersionId:null});
 f.store.put('nodes',{id:randomUUID(),projectId:f.project.id,type:'text',label:'',text:'Note',position:{x:900,y:1000},revision:1});
 const ack=await f.call('scene.shots.create',f.input(resultId,{segments:[2]})),done=await f.state(ack.id,'succeeded');
 const shot=f.store.get('shots',done.shots[0].shotId);
 assert.deepEqual([shot.title,shot.position,shot.orderIndex,shot.aspectRatio],['参考 02',{x:80,y:1360},5,'9:16']);
});

test('cancelling a storyboard leaves no shots, images or staged files', async t=>{
 const started=deferred(),f=fixture(t,{decode:async input=>{
  input.beforeSpawn(input.signal);input.onFrame({index:0,marks:[0],bytes:still(0)});started.resolve();
  await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'MEDIA_CANCELLED'})),{once:true}));
 }}),resultId=await f.detected();
 // A detection held on another video keeps the storyboard queued.
 const other=f.video(),hold=deferred();f.holds.set(other.id,hold);
 const blocking=await f.call('scene.detect',{projectId:f.project.id,sourceAssetId:other.id,sourceHash:other.sha256,requestId:randomUUID()});
 await f.state(blocking.id,'running');
 const queued=await f.call('scene.shots.create',f.input(resultId)),control=f.control(queued),first=await f.call('scene.task.cancel',control);
 assert.deepEqual([first.kind,first.state,first.revision,first.started],['shots','cancelled_before_start',2,false]);
 assert.ok(isSceneMutationResponse('scene.task.cancel',control,first));
 assert.deepEqual(await f.call('scene.task.cancel',control),first);
 hold.resolve();await f.state(blocking.id,'succeeded');
 const ack=await f.call('scene.shots.create',f.input(resultId));await started.promise;
 assert.deepEqual(staging(f.root),[`${ack.id}-0.png`]);
 const running=await f.get(ack.id);assert.deepEqual([running.state,running.progress],['running',{done:1,total:3}]);
 const cancelling=await f.call('scene.task.cancel',f.control(running));
 assert.deepEqual([cancelling.state,cancelling.revision],['cancelling',3]);
 const ended=await f.state(ack.id,'cancelled');
 assert.deepEqual([ended.revision,ended.shots,ended.errorCode],[4,null,null]);
 assert.deepEqual(f.shots(),[]);assert.deepEqual(f.images(),[]);assert.deepEqual(staging(f.root),[]);
});

test('failures leave no shots, images or files, and keep a safe code', async t=>{
 const outcomes=[
  [{decode:async input=>{input.beforeSpawn(input.signal);throw Object.assign(new Error('PRIVATE_SENTINEL none'),{code:'FRAME_NO_FRAME'});}},'failed','SCENE_KEYFRAME_UNAVAILABLE'],
  [{decode:async input=>keyframes(input,{image:index=>still(index,{width:W-2})})},'failed','SCENE_SHOTS_FAILED'],
  [{decode:async input=>{input.beforeSpawn(input.signal);throw new Error('PRIVATE_SENTINEL unknown');}},'failed','SCENE_SHOTS_FAILED'],
  [{fault:stage=>{if(stage==='before_shots_commit')throw new Error('PRIVATE_SENTINEL commit');}},'local_result_error','SCENE_STORAGE_FAILED'],
  [{fault:stage=>{if(stage==='after_media_publication')throw new Error('PRIVATE_SENTINEL publish');}},'local_result_error','SCENE_STORAGE_FAILED'],
 ];
 for(const [options,expected,errorCode] of outcomes){
  const f=fixture(t,options),resultId=await f.detected(),before=f.store.get('projects',f.project.id).revision;
  const ack=await f.call('scene.shots.create',f.input(resultId)),ended=await f.state(ack.id,expected);
  assert.equal(ended.errorCode,errorCode);assert.equal(ended.shots,null);assert.doesNotMatch(JSON.stringify(ended),/PRIVATE_SENTINEL/);
  assert.deepEqual(f.shots(),[]);assert.deepEqual(f.images(),[]);assert.deepEqual(staging(f.root),[]);
  assert.deepEqual(readdirSync(path.join(f.root,'media')).filter(name=>name.endsWith('.png')),[],'published keyframes are withdrawn');
  assert.equal(f.store.get('projects',f.project.id).revision,before);
  // A failed storyboard frees the video for a retry.
  assert.equal((await f.call('scene.shots.create',f.input(resultId))).state,'queued');
 }
});

test('restart turns active storyboards into interrupted ones and removes their files', async t=>{
 const f=fixture(t),resultId=await f.detected();await f.close();
 const reopened=f.reopen({autoRun:false}),queued=await reopened.call('scene.shots.create',f.input(resultId,{segments:[1]}));
 const second=(()=>{const bytes=Buffer.from('Second synthetic reference'),id=randomUUID();writeFileSync(path.join(f.root,`media/${id}.mp4`),bytes,{mode:0o600});
  return reopened.store.put('assets',{id,projectId:f.project.id,name:'Second.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath:`media/${id}.mp4`,width:W,height:H,duration:60,provenance:'user-import'});})();
 await reopened.close();
 // A detection result for the second video, then a storyboard left saving.
 const detecting=f.reopen();
 const detectAck=await detecting.call('scene.detect',{projectId:f.project.id,sourceAssetId:second.id,sourceHash:second.sha256,requestId:randomUUID()});
 const secondResult=(await until(async()=>{const value=await detecting.call('scene.task.get',{projectId:f.project.id,taskId:detectAck.id});return value.state==='succeeded'&&value;},'detected')).result.id;
 await detecting.close();
 const writer=f.reopen({autoRun:false});
 const saving=await writer.call('scene.shots.create',{projectId:f.project.id,sourceAssetId:second.id,sourceHash:second.sha256,resultId:secondResult,segments:[1,2],requestId:randomUUID()});
 const row=writer.store.db.prepare('SELECT * FROM scene_tasks WHERE id=?').get(saving.id),snapshot=JSON.parse(row.snapshot),plan=sceneShotPlan(snapshot);
 const keyframesSaved=plan.map((item,index)=>({segment:item.segment,sourceFrame:item.sourceFrame,assetId:randomUUID(),sha256:digest(still(index)),width:W,height:H,byteLength:still(index).length}));
 const receipt={schemaVersion:1,projectId:f.project.id,taskId:saving.id,inputHash:row.inputHash,sourceAssetId:second.id,sourceHash:second.sha256,profileId:'local-png-1024-v1',
  selectionRule:'first-pts-at-or-after-v1',fps:30,probe,keyframes:keyframesSaved};
 const at=new Date().toISOString();
 writer.store.db.prepare("UPDATE scene_tasks SET state='running',started=1,revision=2,updatedAt=? WHERE id=?").run(at,saving.id);
 writer.store.db.prepare("UPDATE scene_tasks SET state='persisting',stagedReceipt=?,revision=3,updatedAt=? WHERE id=?").run(canonicalSceneInput(receipt),at,saving.id);
 mkdirSync(path.join(f.root,'scene-staging'),{mode:0o700});
 for(const index of [0,1])writeFileSync(path.join(f.root,'scene-staging',`${saving.id}-${index}.png`),still(index),{mode:0o600});
 writeFileSync(path.join(f.root,'media',`${keyframesSaved[0].assetId}.png`),still(0),{mode:0o600});
 await writer.close();
 let decodes=0;
 const restarted=f.reopen({decode:async()=>{decodes++;assert.fail('restart decoded');}});
 const read=id=>restarted.services.handlers['scene.task.get']({projectId:f.project.id,taskId:id});
 assert.deepEqual([read(queued.id).state,read(queued.id).revision,read(queued.id).errorCode],['interrupted',2,'SCENE_INTERRUPTED']);
 assert.deepEqual([read(saving.id).state,read(saving.id).revision,read(saving.id).errorCode],['interrupted',4,'SCENE_INTERRUPTED']);
 assert.deepEqual(staging(f.root),[]);assert.equal(existsSync(path.join(f.root,'media',`${keyframesSaved[0].assetId}.png`)),false);
 assert.deepEqual(restarted.store.list('shots',f.project.id),[]);
 await pause(20);assert.equal(decodes,0);
 // Only the never-started one can still be cancelled.
 assert.equal(restarted.services.handlers['scene.task.cancel']({projectId:f.project.id,taskId:queued.id,expectedRevision:2,requestId:randomUUID()}).state,'cancelled_before_start');
 assert.throws(()=>restarted.services.handlers['scene.task.cancel']({projectId:f.project.id,taskId:saving.id,expectedRevision:4,requestId:randomUUID()}),code('SCENE_STATE_CONFLICT'));
});

test('undo removes the untouched shots and keeps the keyframes; any real change blocks it', async t=>{
 const f=fixture(t),resultId=await f.detected(),ack=await f.call('scene.shots.create',f.input(resultId)),done=await f.state(ack.id,'succeeded');
 const [one,two,three]=done.shots.map(item=>f.store.get('shots',item.shotId));
 // Moving and reordering are layout, not edits.
 f.store.put('shots',{...one,position:{x:-40,y:900},orderIndex:9,revision:one.revision+1});
 f.store.put('shots',{...two,lastFrameAssetId:null,revision:two.revision+1});
 assert.deepEqual((await f.get(ack.id)).undo,{available:true,blockers:[]});
 f.store.put('shots',{...two,prompt:'A changed description',duration:5,revision:two.revision+2});
 const blocked=await f.get(ack.id);
 assert.deepEqual(blocked.undo,{available:false,blockers:[{segment:2,shotId:two.id,reason:'EDITED',fields:['prompt','duration']}]});
 const attempt=f.control(done);
 await assert.rejects(f.call('scene.shots.undo',attempt),error=>refused('SCENE_UNDO_BLOCKED','scene.shots.undo',attempt)(error)&&JSON.stringify(error.details.blockers)===JSON.stringify(blocked.undo.blockers));
 f.store.put('shots',{...two,revision:two.revision+3});
 const edge=f.store.put('edges',{id:randomUUID(),projectId:f.project.id,source:randomUUID(),target:three.id,kind:'visual',createdAt:new Date().toISOString()});
 const job=f.store.put('jobs',{id:randomUUID(),projectId:f.project.id,shotId:one.id,status:'queued'});
 assert.deepEqual((await f.get(ack.id)).undo.blockers.map(item=>[item.segment,item.reason]),[[1,'GENERATED'],[3,'CONNECTED']]);
 f.store.db.prepare('DELETE FROM edges WHERE id=?').run(edge.id);f.store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
 // A non-owner cannot undo.
 const observer=openStore(f.root,{lock:false}),reader=createSceneServices(observer,{decodeKeyframes:()=>assert.fail('observer decoded')});
 f.track(async()=>{await reader.drain();observer.close();});assert.equal(ownsStoreLock(observer),false);
 assert.throws(()=>reader.handlers['scene.shots.undo'](f.control(done)),code('SCENE_OWNER_REQUIRED'));
 assert.throws(()=>reader.handlers['scene.shots.create'](f.input(resultId)),code('SCENE_OWNER_REQUIRED'));
 const projectRevision=f.store.get('projects',f.project.id).revision,undoInput=f.control(done),undone=await f.call('scene.shots.undo',undoInput);
 assert.ok(isSceneMutationResponse('scene.shots.undo',undoInput,undone));
 assert.deepEqual([undone.state,undone.revision,undone.undo],['undone',5,null]);
 assert.deepEqual(undone.shots,done.shots,'the batch it created stays on record');
 assert.deepEqual(f.shots(),[]);
 assert.equal(f.images().length,3,'keyframe images stay in the library');
 for(const item of done.shots)assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(item.assetId).id,item.assetId);
 assert.equal(f.store.get('projects',f.project.id).revision,projectRevision+1);
 assert.deepEqual(await f.call('scene.shots.undo',undoInput),undone,'exact replay');
 assert.deepEqual((await f.call('scene.request.get',{projectId:f.project.id,requestId:undoInput.requestId})).response,undone);
 await assert.rejects(f.call('scene.shots.undo',f.control(undone)),code('SCENE_STATE_CONFLICT'));
 await assert.rejects(f.call('scene.shots.undo',f.control({id:(await f.call('scene.task.list',{projectId:f.project.id})).items.find(item=>item.kind==='detect').id,revision:3})),code('SCENE_STATE_CONFLICT'));
 assert.equal((await f.get(ack.id)).state,'undone');
 assert.equal((await f.call('scene.shots.create',f.input(resultId))).state,'queued','the video can be storyboarded again');
});

test('the PNG stream splitter and keyframe targets are exact', ()=>{
 const images=[still(0),still(1),png({width:8,height:4,rgba:false,tagged:false})],joined=Buffer.concat(images),seen=[];
 const splitter=createPngStreamSplitter(1024*1024,bytes=>seen.push(bytes));
 for(let offset=0;offset<joined.length;offset+=7)splitter.write(joined.subarray(offset,offset+7));
 splitter.finish();assert.deepEqual(seen,images);
 const partial=createPngStreamSplitter(1024*1024,()=>{});partial.write(images[0].subarray(0,40));assert.throws(()=>partial.finish());
 assert.throws(()=>createPngStreamSplitter(64,()=>{}).write(images[0]));
 assert.throws(()=>createPngStreamSplitter(1024,()=>{}).write(Buffer.from('not a png at all')));
 // 10 fps in a 1/10240 time base: three marks fall before the second frame.
 const packets=[3072,0,1024,2048,4096];
 assert.deepEqual(keyframeTargets([1,2,3,4],10240,packets),{targets:[1024,2048],frameOf:[0,0,0,1]});
 assert.deepEqual(keyframeTargets([0,30],10240,[...packets,10240]),{targets:[0,10240],frameOf:[0,1]});
 assert.deepEqual(keyframeTargets([1],10240,[-1024,...packets]),{targets:[1024],frameOf:[0]},'edit-list lead-in packets are never selected');
 assert.throws(()=>keyframeTargets([200],10240,packets),code('FRAME_NO_FRAME'));
});

// Real FFmpeg on managed sources. Fixtures switch content with full-frame
// overlays on one main stream, so cut and frame counts agree across FFmpeg builds.
async function film(f,{rate=30,frames=150,name='Three shots.mp4'}={}){
 const id=randomUUID(),relativePath=`media/${id}.mp4`,file=path.join(f.root,relativePath),small='s=320x180';
 const graph=`testsrc2=${small}:r=${rate},trim=end_frame=${frames}[a];perlin=${small}:r=${rate}:octaves=4:persistence=0.6:tscale=0.3:random_mode=seed:seed=3,format=gbrp[b];`+
  `smptehdbars=${small}:r=${rate},noise=alls=12:allf=t+u[c];[a][b]overlay=shortest=1:enable='between(n,45,99)'[ab];[ab][c]overlay=shortest=1:enable='gte(n,100)',setsar=1[v]`;
 await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex',graph,'-map','[v]','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',file],{timeout:60000});
 const bytes=await readFile(file);
 return f.store.put('assets',{id,projectId:f.project.id,name,mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:320,height:180,duration:frames/rate,provenance:'user-import'});
}
const capture=async(f,asset,requestedFrame)=>{
 const managed=validateManagedSource(f.root,asset,{maxBytes:SCENE_LIMITS.sourceBytes});
 return (await decodeManagedFrame({root:f.root,asset,file:managed.file,info:managed.info,requestedFrame})).bytes;
};

test('real storyboard keyframes are byte-identical to frame capture at the same marks', async t=>{
 const f=fixture(t,{real:true}),asset=await film(f);
 const detect=await f.call('scene.detect',{projectId:f.project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,requestId:randomUUID()});
 const result=(await f.state(detect.id,'succeeded')).result;
 const saved=await f.call('scene.result.get',{projectId:f.project.id,assetId:asset.id});
 assert.deepEqual(saved.result.cuts.map(cut=>cut.frame),[45,100]);
 const ack=await f.call('scene.shots.create',{projectId:f.project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,resultId:result.id,segments:[1,2,3],requestId:randomUUID()});
 const done=await f.state(ack.id,'succeeded');
 const marks=sceneShotPlan({titlePrefix:'参考',origin:{x:0,y:0},segments:[[1,0,45],[2,45,100],[3,100,result.frameCount]]}).map(item=>item.sourceFrame);
 const hashes=done.shots.map(item=>f.store.get('assets',item.assetId).sha256);
 assert.equal(new Set(hashes).size,3,'three different shots');
 for(const [index,mark] of marks.entries())assert.equal(hashes[index],digest(await capture(f,asset,mark)),`segment ${index+1}`);
 assert.deepEqual(staging(f.root),[]);
});

test('real keyframe decoding answers marks between two source frames with one image', async t=>{
 const f=fixture(t,{real:true}),asset=await film(f,{rate:10,frames:20,name:'Ten fps.mp4'});
 const managed=validateManagedSource(f.root,asset,{maxBytes:SCENE_LIMITS.sourceBytes}),frames=[];
 const decoded=await decodeSceneKeyframes({root:f.root,asset,file:managed.file,info:managed.info,marks:[1,2,3,4],onFrame:frame=>frames.push(frame)});
 assert.deepEqual(decoded.frameOf,[0,0,0,1]);assert.deepEqual(frames.map(frame=>frame.marks),[[0,1,2],[3]]);
 assert.deepEqual([decoded.width,decoded.height,decoded.sourceHash],[320,180,asset.sha256]);
 assert.equal(digest(frames[0].bytes),digest(await capture(f,asset,1)));
 assert.equal(digest(frames[1].bytes),digest(await capture(f,asset,4)));
});
