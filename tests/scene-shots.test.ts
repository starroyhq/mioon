import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {mediaFixturePath, mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {referenceTestAsset} from '../packages/business/src/project-file/test-asset-fixture.ts';
import type {SceneCall, SceneServices, SceneHandlerService} from './helpers/strict-scene-types.ts';
import type {SceneServicesOptions} from '../packages/business/src/scene-tasks.ts';
import type {SceneDetectTaskResponse} from '@mioon/contracts';
import type {DatabaseSync} from 'node:sqlite';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,existsSync,readdirSync,readFileSync,mkdirSync,unlinkSync,lstatSync,linkSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openServerTestStore,openStore} from '../packages/business/src/project-file/test-store.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {ownsStoreLock,assertProjectStore} from '../packages/business/src/store-runtime.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import {setAgentTaskJobOriginRunner,setAgentTaskEffectGate,resumeAgentTaskJobs} from '../packages/business/src/agent/task-effects-v2.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {createCanvasEditing} from '../packages/business/src/canvas-editing.ts';
import {canvasEditingResponses,createCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import {validateImageConsumption} from '../packages/business/src/image-consumption.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {timelineOutputPreset} from '../packages/contracts/src/timeline-output-geometry.ts';
import {setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {projectOutputPublicationReceiptSchema} from '../packages/contracts/src/project-output-publication.ts';
import {createPngStreamSplitter,keyframeTargets,decodeSceneKeyframes, type DecodeSceneKeyframesOptions, type SceneKeyframe} from '../packages/business/src/scene-keyframe-decoder.ts';
import {decodeManagedFrame} from '../packages/business/src/frame-decoder.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {AGENT_TASK_OPERATION_ADMISSION} from '../packages/business/src/agent/task-tools-v2.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {SCENE_KEYFRAME_PROVENANCE,SCENE_LIMITS,schemas,descriptions,operationEffect,isSceneTaskResponse,isSceneMutationResponse,isSceneRequestResponse,isSceneListResponse,
 canonicalSceneInput,sceneShotPlan,sceneSegmentBounds} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';
import {createClient} from '../packages/client/src/index.ts';
import type { BinaryLike } from 'crypto';

const digest=(bytes: BinaryLike|Buffer<ArrayBufferLike>)=>createHash('sha256').update(bytes).digest('hex');
const code=(expected: string,check: ((arg0: { code: string; }) => unknown)|undefined=()=>true)=>(error: unknown)=>(error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} }).code===expected&&!JSON.stringify((error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} })).includes('PRIVATE_SENTINEL')&&check((error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} }));
const proven=(operation: string,input: {projectId: string; requestId: string})=>(error: unknown)=>{

 const proof=(error as {code?: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}}}).details?.sceneOutcome;
 return proof?.status==='not_accepted'&&proof.operation===operation&&proof.projectId===input.projectId&&proof.requestId===input.requestId&&proof.inputHash===digest(canonicalSceneInput(input));
};
const refused=(expected: string,operation: string,input: {projectId: string; requestId: string})=>(error: unknown)=>code(expected)(error)&&proven(operation,input)(error);
const deferred=()=>{let resolve!: (value?: unknown) => void;const promise=new Promise<unknown>(yes=>{resolve=yes;});return {promise,resolve};};
async function until<T>(read: () => T | false | Promise<T | false>, label: string): Promise<T>{const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(5);}assert.fail(`Timed out: ${label}`);}
const W=320,H=180;
const probe={streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:W,height:H,rotation:0,sarNumerator:1,sarDenominator:1};
const still=(index: number,{width=W,height=H}={})=>png({width,height,rgba:false,tagged:false,pixel:()=>[(index*60)%256,120,200]});
/** A decoder stand-in: one output frame per mark unless groups say otherwise. */
function keyframes(input: DecodeSceneKeyframesOptions,{groups=(input.marks)!.map((_,index)=>[index]),image=still}={}): Awaited<ReturnType<NonNullable<SceneServicesOptions['decodeKeyframes']>>>{
 (input.beforeSpawn)!(input.signal!);
 groups.forEach((marks,index)=>(input.onFrame)!({index,marks,bytes:image(index)}));
 return {profileId:'local-png-1024-v1',selectionRule:'first-pts-at-or-after-v1',sourceHash:(input.asset as {sha256: string}).sha256,width:W,height:H,probe,frameOf:groups.flatMap((marks,index)=>marks.map(()=>index))};
}
const rows=(db: DatabaseSync)=>JSON.stringify(['scene_tasks','scene_requests','scene_results','shots','assets'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const staging=(root: string)=>existsSync(path.join(root,'.mioon-store','tmp','scene-staging'))?readdirSync(path.join(root,'.mioon-store','tmp','scene-staging')).filter(name=>name.endsWith('.png')):[];

function open(root: string,{decode,detect,fault,cuts=[30,900],frameCount=1800,autoRun=true,real=false,canvas=false}: {decode?: (input: DecodeSceneKeyframesOptions) => unknown; detect?: SceneServicesOptions['detect']; fault?: SceneServicesOptions['fault']; cuts?: number[]; frameCount?: number; autoRun?: boolean; real?: boolean; canvas?: boolean}={}){
 const projectFile=path.join(root,'project.mioon'),layout=path.join(root,'.mioon-store');
 const location={localDir:path.join(layout,'local'),cacheDir:path.join(layout,'cache'),tempDir:path.join(layout,'tmp')};
 if(canvas&&!existsSync(projectFile)){createProjectFile(projectFile,{format4:{}});mkdirSync(path.join(root,'media'),{mode:0o700});}
 const store=(canvas?openServerTestStore({projectFile,locate:()=>location,format4:{}},path.join(layout,'app')):openStore(root)) as TypedStore;
 let decodes=0;
 const holds=new Map<string, ReturnType<typeof deferred>>();
 const services=(createSceneServices(store,({autoRun,fault,...(real?{}:{
  detect:async input=>{
   (input.beforeSpawn)!(input.signal!);if(detect)return detect(input);
   await holds.get((input.asset as {id: string}).id)?.promise;
   return {profileId:'scene-cuts-v1',fps:30,frameCount,options:input.options as Awaited<ReturnType<NonNullable<SceneServicesOptions['detect']>>>['options'],cuts:cuts.map((frame,index)=>({frame,score:0.4+index/100})),segments:[],sourceHash:(input.asset as {sha256: string}).sha256,analysis:{width:256,height:144,decodedFrames:frameCount}};
  },
  decodeKeyframes:async input=>{decodes++;return decode?decode(input):keyframes(input);},
 })} as SceneServicesOptions)) as SceneHandlerService<'shots'>);
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;try{await services.drain();}finally{store.close();}};
 const call=(async(op: string,input: unknown)=>services.handlers[op]!(input)) as SceneCall<'shots'>;
 return {store,services,call,close,holds,get decodes(){return decodes;}};
}
function fixture(t: test.TestContext,options: NonNullable<Parameters<typeof open>[1]>={}){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-scene-shots-'))),closers: (() => Promise<void>)[]=[];
 // Every store on this root closes before the root is removed.
 t.after(async()=>{try{for(const close of closers.reverse())await close();}finally{rmSync(root,{recursive:true,force:true});}});
 const reopen=(patch: NonNullable<Parameters<typeof open>[1]>={})=>{const value=open(root,patch);closers.push(value.close);return value;};
 const opened=reopen(options),{store,call}=opened;
 const project=store.put('projects',{id:String(store.db.prepare('SELECT projectId FROM project.project_file').get()!.projectId),name:'Storyboard project',revision:1}),other={id:randomUUID(),name:'Other project',revision:1};
 const video=(patch: Record<string, unknown>={})=>{
  const bytes=mp4HeaderFixture(`Synthetic reference film ${randomUUID()} PRIVATE_SENTINEL`),id=randomUUID(),relativePath=`media/${id}.mp4`;
  writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
  return store.put('assets',{id,projectId:project.id,name:'Reference.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:W,height:H,duration:60,provenance:'user-import',...patch});
 };
 const asset=video();
 const get=(id: string)=>call('scene.task.get',{projectId:project.id,taskId:id});
 const state=(id: string,expected: string)=>until(async()=>{const value=await get(id);return value.state===expected&&value;},expected);
 const detected=async(source: { id: unknown; sha256: unknown; }=asset)=>{
  const ack=await call('scene.detect',{projectId:project.id,sourceAssetId:source.id,sourceHash:source.sha256,requestId:randomUUID()});
  return ((await state(ack.id,'succeeded')) as unknown as SceneDetectTaskResponse).result!.id;
 };
 return {...opened,get decodes(){return opened.decodes;},root,project,other,asset,video,get,state,detected,reopen,track:(close: () => Promise<void>)=>closers.push(close),
  input:(resultId: unknown,patch: Record<string, unknown>={})=>({projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,resultId,segments:[1,2,3],requestId:randomUUID(),...patch}),
  control:(value: { id: unknown; revision: unknown; },patch: Record<string, unknown>={})=>({projectId:project.id,taskId:value.id,expectedRevision:value.revision,requestId:randomUUID(),...patch}),
  shots:()=>store.list('shots',project.id),
  images:()=>store.list('assets',project.id).filter(item=>item.provenance===SCENE_KEYFRAME_PROVENANCE)};
}

test('storyboard operations are registered, described, effect-annotated, restore-classified, localized and tiered for Mio', ()=>{
 for(const operation of ['scene.shots.create','scene.shots.undo'] as const){
  assert.ok(schemas[operation]&&descriptions[operation].length>30,operation);
  assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
  for(const locale of ['zh-Hant','en','ja'] as const)assert.ok(translate(locale,`operation.${operation}`).length>30,`${operation} ${locale}`);
  const effect=operationEffect(operation);
  assert.equal(effect.readOnly,false);assert.equal(effect.paidGeneration,false);assert.equal(effect.externalIO,false);assert.equal(effect.idempotent,true);

 }
 for(const operation of ['scene.task.get','scene.task.list','scene.task.cancel'] as const)assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
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
  await assert.rejects(f.call('scene.shots.create',{...input,...patch}),code('projectId' in patch?'SCENE_NOT_FOUND':'SCENE_REQUEST_CONFLICT'));
 // One scene task per video at a time; a storyboard in progress locks the cut list.
 const again=f.input(resultId),detect={projectId:f.project.id,sourceAssetId:f.asset.id,sourceHash:f.asset.sha256,requestId:randomUUID()};
 const save={projectId:f.project.id,assetId:f.asset.id,sourceHash:f.asset.sha256,expectedResultId:resultId,cuts:[30],requestId:randomUUID()};
 await assert.rejects(f.call('scene.shots.create',again),refused('SCENE_TASK_ACTIVE','scene.shots.create',again));
 await assert.rejects(f.call('scene.detect',detect),refused('SCENE_TASK_ACTIVE','scene.detect',detect));
 await assert.rejects(f.call('scene.cuts.save',save),refused('SCENE_TASK_ACTIVE','scene.cuts.save',save));
 for(const patch of [{segments:[]},{segments:[2,1]},{segments:[1,1]},{segments:[0]},{segments:Array.from({length:101},(_,index)=>index+1)},{titlePrefix:''},{titlePrefix:'x'.repeat(41)},{position:{x:1}},{resultId:'nope'}])
  await assert.rejects(f.call('scene.shots.create',f.input(resultId,patch)),code('VALIDATION_ERROR'),JSON.stringify(patch).slice(0,40));
 (release.resolve)!();await f.state(ack.id,'succeeded');
 const newer=await f.call('scene.cuts.save',{...save,requestId:randomUUID()});
 const stale=f.input(resultId);
 await assert.rejects(f.call('scene.shots.create',stale),refused('SCENE_RESULT_CONFLICT','scene.shots.create',stale));
 const beyond=f.input(newer.id,{segments:[1,2,3]});
 await assert.rejects(f.call('scene.shots.create',beyond),refused('SCENE_SEGMENTS_INVALID','scene.shots.create',beyond),'the newer result has two segments');
 const changed=f.input(newer.id,{sourceHash:'b'.repeat(64),segments:[1]});
 await assert.rejects(f.call('scene.shots.create',changed),refused('SCENE_SOURCE_CHANGED','scene.shots.create',changed));
 f.store.put('assets',{...f.store.get('assets',f.asset.id),sha256:'c'.repeat(64),reference:{...mediaReferenceSchema.parse((f.store.get('assets',f.asset.id) as unknown as {reference: unknown}).reference),fullSha256:'c'.repeat(64)}});
 const outdated=f.input(newer.id,{sourceHash:'c'.repeat(64),segments:[1]});
 await assert.rejects(f.call('scene.shots.create',outdated),refused('SCENE_RESULT_STALE','scene.shots.create',outdated));
 await assert.rejects(f.call('scene.shots.create',f.input(newer.id,{projectId:f.other.id})),code('SCENE_NOT_FOUND'));
});

test('a built storyboard saves its keyframe images and shots in one step', async t=>{
 const f=fixture(t),resultId=await f.detected();
 f.store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),f.project.id,JSON.stringify({projectId:f.project.id,fps:30,width:1920,height:1080}));
 const projectRevision=(f.store.get('projects',f.project.id))!.revision;
 const input=f.input(resultId,{titlePrefix:'Ref',position:{x:500,y:700}}),ack=await f.call('scene.shots.create',input);
 assert.equal(ack.aspectRatio,'16:9','new shots follow the project format');
 const done=await f.state(ack.id,'succeeded');
 assert.deepEqual([done.revision,done.started,done.errorCode,done.progress],[4,true,null,null]);
 assert.deepEqual(done.undo,{available:true,blockers:[]});
 assert.deepEqual((done.shots)!.map(item=>item.segment),[1,2,3]);
 const shots=f.shots().sort((a,b)=>a.orderIndex-b.orderIndex),images=f.images();
 assert.deepEqual(shots.map(item=>item.id),(done.shots)!.map(item=>item.shotId));
 assert.deepEqual(shots.map(({title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId})=>({title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId})),
  (done.shots)!.map((item,index)=>({title:`Ref 0${index+1}`,prompt:'',referenceAssetIds:[item.assetId],aspectRatio:'16:9',duration:[1,20,20][index],parameters:{},
   position:{x:500+index*340,y:700},orderIndex:index,revision:1,selectedVersionId:null})));
 assert.equal(images.length,3);
 for(const [index,item] of (done.shots)!.entries()){
  const image=f.store.get('assets',item.assetId),bytes=readFileSync(mediaFixturePath(f.root,image));
  assert.deepEqual([(image)!.name,(image)!.mimeType,(image)!.width,(image)!.height,(image)!.sizeBytes,mediaReferenceSchema.parse((image as unknown as Record<string,unknown>).reference).path.startsWith('生成/'),(image)!.provenance],
   [`Ref 0${index+1}.png`,'image/png',W,H,bytes.length,true,'scene-keyframe']);
  assert.equal((image)!.sha256,digest(bytes));assert.deepEqual(bytes,still(index));
  // Keyframes are owned images: the media graph and image consumers accept them.
  assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(item.assetId).id,item.assetId);
  assert.equal(validateImageConsumption(f.store.db,image!,f.project.id).id,item.assetId);
 }
 assert.equal((f.store.get('projects',f.project.id))!.revision,projectRevision+1);
 await until(()=>staging(f.root).length===0,'registered private staging cleanup');
 assert.equal(f.decodes,1,'one decode for every segment');
 const page=await f.call('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id});
 assert.ok(isSceneListResponse('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id},page));
 assert.deepEqual(page.items[0],{...done,undo:null},'pages leave undo to task.get');
 assert.deepEqual(await f.call('scene.shots.create',input),ack,'the original acknowledgement replays after success');
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:input.requestId});assert.equal((receipt!.response as import("@mioon/contracts").SceneShotsTaskResponse).shots,null);
 // A keyframe whose row no longer matches its receipt, or a forged one, is refused.
 const first=f.store.get('assets',(done.shots)![0].assetId);
 f.store.put('assets',{...first,sizeBytes:(first)!.sizeBytes+1});
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.project.id).asset((first)!.id),code('INSPECTION_UNAVAILABLE'));
 assert.throws(()=>validateImageConsumption(f.store.db,f.store.get('assets',(first)!.id)!,f.project.id),code('IMAGE_SOURCE_INVALID'));
 f.store.put('assets',first!);
 const relocated=`素材/relinked-${first!.id}.png`;mkdirSync(path.join(f.root,'素材'),{recursive:true});writeFileSync(path.join(f.root,relocated),readFileSync(mediaFixturePath(f.root,first)));
 const relinked={...first!,...referenceTestAsset(f.root,{relativePath:relocated,sha256:first!.sha256,sizeBytes:first!.sizeBytes}),referenceRevision:2};f.store.put('assets',relinked);
 assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(first!.id).id,first!.id,'same-content relinks keep the local storyboard owner');
 assert.equal(validateImageConsumption(f.store.db,relinked,f.project.id).id,first!.id);f.store.put('assets',first!);
 const forged=f.store.put('assets',{...first,id:randomUUID(),relativePath:'media/forged.png'});
 assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.project.id).asset(forged.id),code('INSPECTION_UNAVAILABLE'));
});

test('every registered scene keyframe releases its private hard link before the first postcommit reader can pin its identity',async t=>{
 const f=fixture(t),resultId=await f.detected(),store=f.store;assertProjectStore(store);
 const library=testProjectAppLibrary(store);assert.ok(library);
 const references=createProjectAssetReferenceServices(store,{outsidePaths:library.outsidePaths}),registered=deferred();
 let observation:Promise<void>|undefined;
 const remove=setProjectOutputPublicationTestHooks(store,{fault:(point,proof)=>{
  if(proof.owner.kind!=='scene')return;
  const file=path.join(f.root,proof.relativePath);
  if(point==='after_intent'){
   // Resume the inode the older publisher linked before recording targetIdentity.
   const receiptFile=path.join(store.tempDir,'publications',proof.publicationId+'.json');
   const receipt=projectOutputPublicationReceiptSchema.parse(JSON.parse(readFileSync(receiptFile,'utf8')));
   linkSync(path.join(store.tempDir,receipt.stageRelativePath),file);
  }
  if(point!=='after_registered'||observation)return;
  const beforeCleanup=lstatSync(file,{bigint:true});
  // A microtask runs as soon as the writer yields. Starting all markers in one
  // turn is essential: an await between markers leaves later finals at nlink=2
  // and their future unlink changes ctime beneath an ordinary L1 reader.
  observation=Promise.resolve().then(async()=>{
   assert.equal(beforeCleanup.nlink,2n,'exercise a linked publication before cleanup');
   const images=f.images();assert.equal(images.length,3);
   const files=images.map(image=>mediaFixturePath(f.root,image)),before=files.map(file=>lstatSync(file,{bigint:true}));
   for(const info of before)assert.equal(info.nlink,1n,'all visible batch outputs finish their private-link cleanup before any async marker verification');
   const second=images[1]!,read=await references.read(second.id,{maxBytes:Number(second.sizeBytes),expectedSha256:String(second.sha256)});
   assert.deepEqual(read.bytes,readFileSync(files[1]!));
   await until(()=>!f.services.isBusy(),'all scene marker verification settled');
   for(const [index,file] of files.entries())assert.equal(lstatSync(file,{bigint:true}).ctimeNs,before[index]!.ctimeNs,'later marker settlement cannot mutate a visible final identity');
  });void observation.catch(()=>{});registered.resolve();
 }});
 t.after(remove);
 const ack=await f.call('scene.shots.create',f.input(resultId));await f.state(ack.id,'succeeded');await registered.promise;assert.ok(observation);await observation;
 assert.equal(f.shots().length,3);assert.equal(f.decodes,1);
});

test('without a position the batch goes below the canvas content and continues the order', async t=>{
 const f=fixture(t),resultId=await f.detected();
 f.store.put('shots',{id:randomUUID(),projectId:f.project.id,title:'Existing',prompt:'',referenceAssetIds:[],aspectRatio:'9:16',duration:2,parameters:{},position:{x:0,y:400},orderIndex:4,revision:1,selectedVersionId:null});
 f.store.put('nodes',{id:randomUUID(),projectId:f.project.id,type:'text',label:'',text:'Note',position:{x:900,y:1000},revision:1});
 const ack=await f.call('scene.shots.create',f.input(resultId,{segments:[2]})),done=await f.state(ack.id,'succeeded');
 const shot=f.store.get('shots',(done.shots)![0].shotId);
 assert.deepEqual([(shot)!.title,(shot)!.position,(shot)!.orderIndex,(shot)!.aspectRatio],['参考 02',{x:80,y:1360},5,'9:16']);
});

for(const {width,height,aspectRatio} of [
 {width:1600,height:1000,aspectRatio:'16:9'},
 {width:1000,height:1600,aspectRatio:'9:16'},
 {width:1000,height:1000,aspectRatio:'1:1'},
])test(`format 3 infers the storyboard ratio ${aspectRatio} from non-preset geometry ${width}x${height}`, async t=>{
  const f=fixture(t),resultId=await f.detected();
  f.store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)')
   .run(randomUUID(),f.project.id,JSON.stringify({projectId:f.project.id,fps:30,width,height}));
  const input=f.input(resultId,{segments:[1]});
  const ack=await f.call('scene.shots.create',input),done=await f.state(ack.id,'succeeded');
  assert.equal(ack.aspectRatio,aspectRatio);
  assert.equal(f.store.get('shots',done.shots![0]!.shotId)!.aspectRatio,aspectRatio);
  assert.deepEqual(await f.call('scene.shots.create',input),ack);
});

test('format 4 refuses non-preset project geometry before storyboard acceptance', async t=>{
 const f=fixture(t,{canvas:true}),resultId=await f.detected();
 f.store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)')
  .run(randomUUID(),f.project.id,JSON.stringify({projectId:f.project.id,fps:30,width:1600,height:1000}));
 const input=f.input(resultId,{segments:[1]});
 const before=rows(f.store.db);
 let refusal: {code: string; message: string; details: unknown} | undefined;
 await assert.rejects(f.call('scene.shots.create',input),error=>{
  assert.ok(error instanceof Error && 'code' in error && typeof error.code==='string' && 'details' in error);
  refusal={code:error.code,message:error.message,details:error.details};
  return refused('SCENE_PROJECT_ASPECT_UNSUPPORTED','scene.shots.create',input)(error);
 });
 const client=createClient({
  env:{MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:'storyboard-test-token'},
  fetchImpl:async()=>new Response(JSON.stringify({ok:false,error:refusal}),{status:409}),
 });
 await assert.rejects(client.rpc('scene.shots.create',input),error=>{
  assert.match(String((error as {code?: string}).code),/^SCENE_PROJECT_ASPECT_UNSUPPORTED$/);
  assert.equal((error as {details?: {submissionMayHaveSucceeded?: boolean}}).details?.submissionMayHaveSucceeded,false);
  return true;
 });
 assert.equal(rows(f.store.db),before);
 assert.equal(f.decodes,0);
});

test('storyboards freeze each exact project frame ratio at acceptance and replay the original ratio', async t=>{
 const decoding=deferred(),continueDecode=deferred();
 const f=fixture(t,{canvas:true,decode:async input=>{decoding.resolve();await continueDecode.promise;return keyframes(input);}}),resultId=await f.detected();
 const setFrame=(presetId:string)=>{
  const preset=timelineOutputPreset(presetId);assert.ok(preset);
  const {fps,width,height}=preset;
  f.store.db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data')
   .run(randomUUID(),f.project.id,JSON.stringify({projectId:f.project.id,fps,width,height}));
 };
 setFrame('ultrawide_1080');
 const first=f.input(resultId,{segments:[1]}),wide=await f.call('scene.shots.create',first);
 try{
  await decoding.promise;
  assert.equal(wide.aspectRatio,'21:9');
  setFrame('portrait_3_4_720');
  assert.deepEqual(await f.call('scene.shots.create',first),wide);
 }finally{continueDecode.resolve();}
 const wideDone=await f.state(wide.id,'succeeded');
 assert.equal(wideDone.aspectRatio,'21:9');
 assert.equal(f.store.get('shots',wideDone.shots![0]!.shotId)!.aspectRatio,'21:9');
 for(const [presetId,ratio] of [['portrait_3_4_720','3:4'],['landscape_4_3_1080','4:3']]){
  setFrame(presetId!);
  const ack=await f.call('scene.shots.create',f.input(resultId,{segments:[1]})),done=await f.state(ack.id,'succeeded');
  assert.equal(ack.aspectRatio,ratio);
  assert.equal(f.store.get('shots',done.shots![0]!.shotId)!.aspectRatio,ratio);
 }
 assert.deepEqual(await f.call('scene.shots.create',first),wide);
 assert.equal(f.decodes,3);
});

test('cancelling a storyboard leaves no shots, images or staged files', async t=>{
 const started=deferred(),f=fixture(t,{decode:async input=>{
  input.beforeSpawn!(input.signal!);input.onFrame!({index:0,marks:[0],bytes:still(0)});(started.resolve)!();
  await new Promise((_,reject)=>input.signal!.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'MEDIA_CANCELLED'})),{once:true}));
 }}),resultId=await f.detected();
 // A detection held on another video keeps the storyboard queued.
 const other=f.video(),hold=deferred();f.holds.set(other.id,hold);
 const blocking=await f.call('scene.detect',{projectId:f.project.id,sourceAssetId:other.id,sourceHash:other.sha256,requestId:randomUUID()});
 await f.state(blocking.id,'running');
 const queued=await f.call('scene.shots.create',f.input(resultId)),control=f.control(queued),first=await f.call('scene.task.cancel',control);
 assert.deepEqual([first.kind,first.state,first.revision,first.started],['shots','cancelled_before_start',2,false]);
 assert.ok(isSceneMutationResponse('scene.task.cancel',control,first));
 assert.deepEqual(await f.call('scene.task.cancel',control),first);
 (hold.resolve)!();await f.state(blocking.id,'succeeded');
 const ack=await f.call('scene.shots.create',f.input(resultId));await started.promise;
 assert.deepEqual(staging(f.root),[`${ack.id}-0.png`]);
 const running=await f.get(ack.id);assert.deepEqual([running.state,running.progress],['running',{done:1,total:3}]);
 const cancelling=await f.call('scene.task.cancel',f.control(running));
 assert.deepEqual([cancelling.state,cancelling.revision],['cancelling',3]);
 const ended=await f.state(ack.id,'cancelled');
 assert.deepEqual([ended.revision,ended.shots,ended.errorCode],[4,null,null]);
 assert.deepEqual((f.shots() as unknown),[]);assert.deepEqual((f.images() as unknown),[]);assert.deepEqual((staging(f.root) as unknown),[]);
});

test('failures keep complete local artifacts and published files without partial asset or shot rows', async t=>{
 const outcomes: [NonNullable<Parameters<typeof open>[1]>, string, string][]=[
  [{decode:async input=>{input.beforeSpawn!(input.signal!);throw Object.assign(new Error('PRIVATE_SENTINEL none'),{code:'FRAME_NO_FRAME'});}},'failed','SCENE_KEYFRAME_UNAVAILABLE'],
  [{decode:async (input: DecodeSceneKeyframesOptions)=>keyframes(input,{image:index=>still(index,{width:W-2})})},'failed','SCENE_SHOTS_FAILED'],
  [{decode:async input=>{input.beforeSpawn!(input.signal!);throw new Error('PRIVATE_SENTINEL unknown');}},'failed','SCENE_SHOTS_FAILED'],
  [{fault:(stage: string)=>{if(stage==='before_shots_commit')throw new Error('PRIVATE_SENTINEL commit');}},'local_result_error','SCENE_STORAGE_FAILED'],
  [{fault:(stage: string)=>{if(stage==='after_media_publication')throw new Error('PRIVATE_SENTINEL publish');}},'local_result_error','SCENE_STORAGE_FAILED'],
 ];
 for(const [options,expected,errorCode] of outcomes){
  const f=fixture(t,options),resultId=await f.detected(),before=(f.store.get('projects',f.project.id))!.revision;
  const ack=await f.call('scene.shots.create',f.input(resultId)),ended=await f.state(ack.id,expected);
  assert.equal(ended.errorCode,errorCode);assert.equal(ended.shots,null);assert.doesNotMatch(JSON.stringify(ended),/PRIVATE_SENTINEL/);
  assert.deepEqual((f.shots() as unknown),[]);assert.deepEqual((f.images() as unknown),[]);
  assert.equal(staging(f.root).length,expected==='local_result_error'?3:0);
  const output=path.join(f.root,'生成');assert.equal(existsSync(output)?readdirSync(output).length:0,expected==='local_result_error'?3:0,'unclaimed published keyframes remain');
  assert.equal((f.store.get('projects',f.project.id))!.revision,before);
  // A failed storyboard frees the video for a retry.
  assert.equal((await f.call('scene.shots.create',f.input(resultId))).state,'queued');
 }
});

test('restart without a complete durable manifest stays interrupted and retains project files', async t=>{
 const f=fixture(t),resultId=await f.detected();await f.close();
 const reopened=f.reopen({autoRun:false}),queued=await reopened.call('scene.shots.create',f.input(resultId,{segments:[1]}));
 const second=(()=>{const bytes=mp4HeaderFixture('Second synthetic reference'),id=randomUUID();writeFileSync(path.join(f.root,`media/${id}.mp4`),bytes,{mode:0o600});
  return reopened.store.put('assets',{id,projectId:f.project.id,name:'Second.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath:`media/${id}.mp4`,width:W,height:H,duration:60,provenance:'user-import'});})();
 await reopened.close();
 // A detection result for the second video, then a storyboard left saving.
 const detecting=f.reopen();
 const detectAck=await detecting.call('scene.detect',{projectId:f.project.id,sourceAssetId:second.id,sourceHash:second.sha256,requestId:randomUUID()});
 const secondResult=((await until(async()=>{const value=await detecting.call('scene.task.get',{projectId:f.project.id,taskId:detectAck.id});return value.state==='succeeded'&&value;},'detected')) as unknown as SceneDetectTaskResponse).result!.id;
 await detecting.close();
 const writer=f.reopen({autoRun:false});
 const saving=await writer.call('scene.shots.create',{projectId:f.project.id,sourceAssetId:second.id,sourceHash:second.sha256,resultId:secondResult,segments:[1,2],requestId:randomUUID()});
 const row=writer.store.db.prepare('SELECT * FROM scene_tasks WHERE id=?').get(saving.id),snapshot=JSON.parse((row)!.snapshot as string),plan=sceneShotPlan(snapshot);
 const keyframesSaved=plan.map((item,index)=>({segment:item.segment,sourceFrame:item.sourceFrame,assetId:randomUUID(),sha256:digest(still(index)),width:W,height:H,byteLength:still(index).length}));
 const receipt={schemaVersion:1,projectId:f.project.id,taskId:saving.id,inputHash:(row)!.inputHash,sourceAssetId:second.id,sourceHash:second.sha256,profileId:'local-png-1024-v1',
  selectionRule:'first-pts-at-or-after-v1',fps:30,probe,keyframes:keyframesSaved};
 const at=new Date().toISOString();
 writer.store.db.prepare("UPDATE scene_tasks SET state='running',started=1,revision=2,updatedAt=? WHERE id=?").run(at,saving.id);
 writer.store.db.prepare("UPDATE scene_tasks SET state='persisting',stagedReceipt=?,revision=3,updatedAt=? WHERE id=?").run(canonicalSceneInput(receipt),at,saving.id);
 mkdirSync(path.join(f.root,'.mioon-store','tmp','scene-staging'),{mode:0o700});
 for(const index of [0,1])writeFileSync(path.join(f.root,'.mioon-store','tmp','scene-staging',`${saving.id}-${index}.png`),still(index),{mode:0o600});
 writeFileSync(path.join(f.root,'media',`${keyframesSaved[0].assetId}.png`),still(0),{mode:0o600});
 await writer.close();
 let decodes=0;
 const restarted=f.reopen({decode:async()=>{decodes++;assert.fail('restart decoded');}});
 const read=(id: string)=>restarted.services.handlers['scene.task.get']({projectId:f.project.id,taskId:id});
 assert.deepEqual([read(queued.id).state,read(queued.id).revision,read(queued.id).errorCode],['interrupted',2,'SCENE_INTERRUPTED']);
 assert.deepEqual([read(saving.id).state,read(saving.id).revision,read(saving.id).errorCode],['interrupted',4,'SCENE_INTERRUPTED']);
 assert.deepEqual(staging(f.root),[`${saving.id}-0.png`,`${saving.id}-1.png`]);assert.equal(existsSync(path.join(f.root,'media',`${keyframesSaved[0].assetId}.png`)),true);
 assert.deepEqual((restarted.store.list('shots',f.project.id) as unknown),[]);
 await pause(20);assert.equal(decodes,0);
 // Only the never-started one can still be cancelled.
 assert.equal(restarted.services.handlers['scene.task.cancel']({projectId:f.project.id,taskId:queued.id,expectedRevision:2,requestId:randomUUID()}).state,'cancelled_before_start');
 assert.throws(()=>restarted.services.handlers['scene.task.cancel']({projectId:f.project.id,taskId:saving.id,expectedRevision:4,requestId:randomUUID()}),code('SCENE_STATE_CONFLICT'));
});

for(const unavailable of ['origin','effect'] as const)test(`complete scene recovery releases its active slot while ${unavailable} is unavailable and resumes only local finalize`,async t=>{
 const f=fixture(t,{fault:phase=>{if(phase==='after_shots_receipt')throw Error('synthetic complete batch interruption');}}),resultId=await f.detected(),other=f.video();
 const accepted=await f.call('scene.shots.create',f.input(resultId));await f.state(accepted.id,'local_result_error');
 const manifestFile=path.join(f.root,'.mioon-store','tmp','scene-staging',`${accepted.id}.json`),manifest=readFileSync(manifestFile,'utf8'),saved=JSON.parse(manifest) as {keyframes:{assetId:string}[]};
 const runId=randomUUID(),stepId=randomUUID(),conversationId=randomUUID(),stamp=new Date().toISOString();
 // Real immutable origin rows reproduce service startup before Mio registers
 // its runner/gate. No schema or owner guard is disabled by this fixture.
 f.store.tx(()=>{
  f.store.db.prepare('INSERT INTO mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)').run(conversationId,f.project.id,stamp,stamp);
  f.store.db.prepare("INSERT INTO mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,createdAt,updatedAt) VALUES(?,?,?,?,?,'completed',1,5,5,1,'zh-Hans',?,?)").run(runId,f.project.id,conversationId,randomUUID(),'a'.repeat(64),stamp,stamp);
  f.store.db.prepare("INSERT INTO mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt) VALUES(?,?,?,1,'tool','completed',?,?)").run(stepId,runId,f.project.id,stamp,stamp);
  f.store.db.prepare("INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES('scene',?,?,?,?,?,'scene.shots.create')").run(accepted.id,runId,stepId,f.project.id,accepted.requestId);
 });
 await f.close();const recovered=f.reopen({decode:async()=>assert.fail('local recovery must not decode')});
 const read=()=>recovered.call('scene.task.get',{projectId:f.project.id,taskId:accepted.id});
 let removeOrigin:()=>void=()=>{};
 if(unavailable==='effect')removeOrigin=setAgentTaskJobOriginRunner(recovered.store.db,(_binding,callback)=>callback());
 const held=await until(async()=>{const value=await read();return !recovered.services.isBusy()&&['interrupted','local_result_error'].includes(value.state)&&value;},'released local recovery');
 assert.equal(held.state,unavailable==='origin'?'interrupted':'local_result_error');
 assert.equal(recovered.store.list('shots',f.project.id).length,0);assert.equal(recovered.decodes,0);
 resumeAgentTaskJobs(recovered.store.db,runId);assert.equal((await read()).state,held.state);assert.equal(recovered.services.isBusy(),false);
 const unrelated=await recovered.call('scene.detect',{projectId:f.project.id,sourceAssetId:other.id,sourceHash:other.sha256,requestId:randomUUID()});
 await until(async()=>{const value=await recovered.call('scene.task.get',{projectId:f.project.id,taskId:unrelated.id});return value.state==='succeeded'&&value;},'unrelated scene task while origin is held');
 if(unavailable==='origin')removeOrigin=setAgentTaskJobOriginRunner(recovered.store.db,(_binding,callback)=>callback());
 const removeGate=setAgentTaskEffectGate(recovered.store.db,()=>{});
 try{
  resumeAgentTaskJobs(recovered.store.db,runId);
  const done=await until(async()=>{const value=await read();return value.state==='succeeded'&&value;},'explicit origin resume local finalize');
  assert.deepEqual(done.shots!.map(item=>item.assetId),saved.keyframes.map(item=>item.assetId));assert.equal(recovered.decodes,0);
  assert.equal(recovered.store.list('shots',f.project.id).length,3);assert.equal(recovered.store.list('assets',f.project.id).filter(item=>item.provenance===SCENE_KEYFRAME_PROVENANCE).length,3);
  assert.equal(readFileSync(manifestFile,'utf8'),manifest);assert.equal(readdirSync(path.join(f.root,'生成')).length,3);
 }finally{removeGate();removeOrigin();}
});

for(const phase of ['after_shots_manifest','after_shots_receipt','after_keyframe_publication','before_shots_commit'])test(`complete durable batch recovers locally after ${phase} with one atomic outcome`,async t=>{
 const f=fixture(t,{fault:(stage,details)=>{if(stage===phase&&(stage!=='after_keyframe_publication'||details?.index===0))throw Error('PRIVATE_SENTINEL interrupted local publication');}}),resultId=await f.detected();
 const input=f.input(resultId),ack=await f.call('scene.shots.create',input),expected=phase==='after_shots_manifest'?'interrupted':'local_result_error';
 await f.state(ack.id,expected);
 const manifest=readFileSync(path.join(f.root,'.mioon-store','tmp','scene-staging',`${ack.id}.json`),'utf8');
 const saved=JSON.parse(manifest) as {keyframes:{assetId:string}[]};
 assert.equal(f.shots().length,0);assert.equal(f.images().length,0);assert.equal(f.decodes,1);
 const output=path.join(f.root,'生成'),beforeFiles=existsSync(output)?readdirSync(output):[];
 assert.equal(beforeFiles.length,phase==='after_keyframe_publication'?1:phase==='before_shots_commit'?3:0);
 await f.close();
 const recovered=f.reopen({decode:async()=>assert.fail('local reconciliation decoded the source')});
 const done=await until(async()=>{const value=await recovered.call('scene.task.get',{projectId:f.project.id,taskId:ack.id});return value.state==='succeeded'&&value;},'local storyboard publication');
 assert.equal(recovered.decodes,0);assert.deepEqual(done.shots!.map(item=>item.assetId),saved.keyframes.map(item=>item.assetId));
 assert.equal(recovered.store.list('shots',f.project.id).length,3);assert.equal(recovered.store.list('assets',f.project.id).filter(item=>item.provenance==='scene-keyframe').length,3);
 assert.equal(readdirSync(output).length,3);for(const name of beforeFiles)assert.ok(readdirSync(output).includes(name));
 assert.equal(readFileSync(path.join(f.root,'.mioon-store','tmp','scene-staging',`${ack.id}.json`),'utf8'),manifest);
 assert.deepEqual(await recovered.call('scene.shots.create',input),ack,'exact original acceptance remains immutable');
 for(const keyframe of saved.keyframes)assert.equal(createOwnedMediaGraphReader(recovered.store.db,f.project.id).asset(keyframe.assetId).id,keyframe.assetId);
});

test('a same-byte final replacement before the batch transaction keeps every asset and shot unregistered',async t=>{
 let changed:string|undefined,saved:Buffer|undefined;
 const f=fixture(t,{fault:phase=>{if(phase==='after_media_publication'){const directory=path.join(f.root,'生成');changed=path.join(directory,readdirSync(directory)[0]!);saved=readFileSync(changed);unlinkSync(changed);writeFileSync(changed,saved,{mode:0o600});}}}),resultId=await f.detected();
 const ack=await f.call('scene.shots.create',f.input(resultId));await f.state(ack.id,'local_result_error');
 assert.equal(f.shots().length,0);assert.equal(f.images().length,0);assert.equal(readdirSync(path.join(f.root,'生成')).length,3);
 assert.ok(changed&&saved);assert.deepEqual(readFileSync(changed),saved);
});

test('local batch reconciliation keeps published bytes when its frozen source changed',async t=>{
 const f=fixture(t,{fault:stage=>{if(stage==='after_keyframe_publication')throw Error('synthetic local interruption');}}),resultId=await f.detected();
 const ack=await f.call('scene.shots.create',f.input(resultId));await f.state(ack.id,'local_result_error');
 const output=path.join(f.root,'生成'),files=readdirSync(output),snapshots=files.map(name=>readFileSync(path.join(output,name)));
 writeFileSync(mediaFixturePath(f.root,f.store.get('assets',f.asset.id)),mp4HeaderFixture('Changed reference film'));
 await f.close();const reopened=f.reopen({decode:async()=>assert.fail('source change must not trigger decoding')});
 await until(async()=>{const task=await reopened.call('scene.task.get',{projectId:f.project.id,taskId:ack.id});return task.state==='local_result_error'&&task;},'source-fenced local failure');
 assert.equal(reopened.store.list('shots',f.project.id).length,0);assert.equal(reopened.store.list('assets',f.project.id).filter(item=>item.provenance==='scene-keyframe').length,0);
 assert.deepEqual(readdirSync(output),files);for(const [index,name] of files.entries())assert.deepEqual(readFileSync(path.join(output,name)),snapshots[index]);assert.equal(reopened.decodes,0);
});

test('undo removes the untouched shots and keeps the keyframes; any real change blocks it', async t=>{
 const f=fixture(t),resultId=await f.detected(),ack=await f.call('scene.shots.create',f.input(resultId)),done=await f.state(ack.id,'succeeded');
 const [one,two,three]=(done.shots)!.map((item: { shotId: string; })=>f.store.get('shots',item.shotId));
 // Moving and reordering are layout, not edits.
 f.store.put('shots',{...one,position:{x:-40,y:900},orderIndex:9,revision:(one)!.revision+1});
 f.store.put('shots',{...two,lastFrameAssetId:null,revision:(two)!.revision+1});
 assert.deepEqual((await f.get(ack.id)).undo,{available:true,blockers:[]});
 f.store.put('shots',{...two,prompt:'A changed description',duration:5,revision:(two)!.revision+2});
 const blocked=await f.get(ack.id);
 assert.deepEqual(blocked.undo,{available:false,blockers:[{segment:2,shotId:(two)!.id,reason:'EDITED',fields:['prompt','duration']}]});
 const attempt=f.control(done);
 await assert.rejects(f.call('scene.shots.undo',attempt),error=>refused('SCENE_UNDO_BLOCKED','scene.shots.undo',attempt)(error)&&JSON.stringify((error as {details: {blockers: unknown}}).details.blockers)===JSON.stringify((blocked.undo)!.blockers));
 f.store.put('shots',{...two,revision:(two)!.revision+3});
 const edge=f.store.put('edges',{id:randomUUID(),projectId:f.project.id,source:randomUUID(),target:(three)!.id,kind:'visual',createdAt:new Date().toISOString()});
 const job=f.store.put('jobs',{id:randomUUID(),projectId:f.project.id,shotId:(one)!.id,status:'queued'});
 assert.deepEqual(((await f.get(ack.id)).undo)!.blockers.map(item=>[item.segment,item.reason]),[[1,'GENERATED'],[3,'CONNECTED']]);
 f.store.db.prepare('DELETE FROM edges WHERE id=?').run(edge.id);f.store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
 // A second live connection is refused; a lost exact capability cannot undo.
 assert.throws(()=>openStore(f.root),{code:'PROJECT_LOCKED'});
 const observer=f.store,reader=f.services;
 Object.defineProperty(observer,'root',{value:`${f.root}/lost-owner`});assert.equal(ownsStoreLock(observer),false);
 const ownerRows=rows(f.store.db);
 assert.throws(()=>reader.handlers['scene.shots.undo'](f.control(done)),code('SCENE_OWNER_REQUIRED'));
 await assert.rejects(async()=>reader.handlers['scene.shots.create'](f.input(resultId)),code('SCENE_OWNER_REQUIRED'));
 assert.equal(rows(f.store.db),ownerRows);Object.defineProperty(observer,'root',{value:f.root});
 const projectRevision=(f.store.get('projects',f.project.id))!.revision,undoInput=f.control(done),undone=await f.call('scene.shots.undo',undoInput);
 assert.ok(isSceneMutationResponse('scene.shots.undo',undoInput,undone));
 assert.deepEqual([undone.state,undone.revision,undone.undo],['undone',5,null]);
 assert.deepEqual(undone.shots,done.shots,'the batch it created stays on record');
 assert.deepEqual((f.shots() as unknown),[]);
 assert.equal(f.images().length,3,'keyframe images stay in the library');
 for(const item of (done.shots)!)assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(item.assetId).id,item.assetId);
 assert.equal((f.store.get('projects',f.project.id))!.revision,projectRevision+1);
 assert.deepEqual(await f.call('scene.shots.undo',undoInput),undone,'exact replay');
 assert.deepEqual(((await f.call('scene.request.get',{projectId:f.project.id,requestId:undoInput.requestId})))!.response,undone);
 await assert.rejects(f.call('scene.shots.undo',f.control(undone)),code('SCENE_STATE_CONFLICT'));
 await assert.rejects(f.call('scene.shots.undo',f.control({id:((await f.call('scene.task.list',{projectId:f.project.id})).items.find((item: { kind: string; })=>item.kind==='detect'))!.id,revision:3})),code('SCENE_STATE_CONFLICT'));
 assert.equal((await f.get(ack.id)).state,'undone');
 assert.equal((await f.call('scene.shots.create',f.input(resultId))).state,'queued','the video can be storyboarded again');
});

test('storyboard appends after the live order and undo keeps a later archived shot and its original receipt', async t=>{
 const f=fixture(t,{canvas:true}),resultId=await f.detected(),projectId=f.project.id;
 const oldId=randomUUID(),at='2026-11-13T00:00:00.000Z';
 const archive=(shotId:string)=>f.store.tx(()=>f.store.db.prepare(
  "UPDATE project.shots SET archivedAt=?,archiveBatchId=?,archiveReason='user-delete' WHERE id=?").run(at,randomUUID(),shotId));
 f.store.put('shots',{id:oldId,projectId,orderIndex:500,revision:1});
 archive(oldId);
 const input=f.input(resultId),accepted=await f.call('scene.shots.create',input),done=await f.state(accepted.id,'succeeded');
 const ids=done.shots!.map(shot=>shot.shotId);
 assert.deepEqual(ids.map(id=>f.store.get('shots',id)?.orderIndex),[0,1,2]);
 const [shotId,moved]=ids;
 assert.ok(shotId&&moved&&isProjectStore(f.store));
 const canvas=createCanvasEditing(f.store);
 const history=canvasEditingResponses['canvas.history.get'].parse(canvas.call('canvas.history.get',{projectId}));
 canvas.call('canvas.apply',{projectId,operation:'move',historyRevision:history.revision,requestId:createCanvasRequestId(history.requestEpoch,randomUUID()),
  moves:[{kind:'shot',id:moved,revision:readMioTargetRevision(f.store.db,projectId,'shot',moved),position:{x:100,y:200}}]});
 archive(shotId);
 const current=await f.get(done.id);
 assert.deepEqual(current.undo,{available:false,blockers:[{segment:1,shotId,reason:'MISSING'},{segment:2,shotId:moved,reason:'CANVAS_HISTORY'}]});
 const undo=f.control(current);
 await assert.rejects(f.call('scene.shots.undo',undo),refused('SCENE_UNDO_BLOCKED','scene.shots.undo',undo));
 assert.ok(f.store.get('shots',shotId));
 assert.deepEqual(await f.call('scene.shots.create',input),accepted);
 assert.deepEqual(current.shots,done.shots);
});

test('storyboard undo may remove shots used only in the canvas order snapshot', async t=>{
 const f=fixture(t,{canvas:true}),resultId=await f.detected(),projectId=f.project.id;
 const ack=await f.call('scene.shots.create',f.input(resultId)),done=await f.state(ack.id,'succeeded');
 const storyboard=done.shots!.map(shot=>shot.shotId);
 const anchorId=randomUUID(),archivedId=randomUUID();
 f.store.put('shots',{id:anchorId,projectId,orderIndex:storyboard.length,revision:1});
 f.store.put('shots',{id:archivedId,projectId,orderIndex:storyboard.length+1,revision:1});
 assert.ok(isProjectStore(f.store));
 const canvas=createCanvasEditing(f.store);
 const history=canvasEditingResponses['canvas.history.get'].parse(canvas.call('canvas.history.get',{projectId}));
 canvas.call('canvas.apply',{projectId,operation:'archive',historyRevision:history.revision,requestId:createCanvasRequestId(history.requestEpoch,randomUUID()),
  targets:[{kind:'shot',id:archivedId,revision:readMioTargetRevision(f.store.db,projectId,'shot',archivedId)}]});
 assert.deepEqual((await f.get(done.id)).undo,{available:true,blockers:[]});
 assert.equal((await f.call('scene.shots.undo',f.control(done))).state,'undone');
 for(const id of storyboard)assert.equal(f.store.get('shots',id),null);
 assert.ok(f.store.get('shots',anchorId));
 assert.ok(f.store.get('shots',archivedId));
 const current=canvasEditingResponses['canvas.history.get'].parse(canvas.call('canvas.history.get',{projectId}));
 assert.throws(()=>canvas.call('canvas.history.undo',{projectId,historyRevision:current.revision,
  requestId:createCanvasRequestId(current.requestEpoch,randomUUID())}),{code:'CANVAS_EDIT_CONFLICT'});
});

test('the PNG stream splitter and keyframe targets are exact', ()=>{
 const images=[still(0),still(1),png({width:8,height:4,rgba:false,tagged:false})],joined=Buffer.concat(images),seen: unknown[]=[];
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
async function film(f: ReturnType<typeof fixture>,{rate=30,frames=150,name='Three shots.mp4'}={}){
 const id=randomUUID(),relativePath=`media/${id}.mp4`,file=path.join(f.root,relativePath),small='s=320x180';
 const graph=`testsrc2=${small}:r=${rate},trim=end_frame=${frames}[a];perlin=${small}:r=${rate}:octaves=4:persistence=0.6:tscale=0.3:random_mode=seed:seed=3,format=gbrp[b];`+
  `smptehdbars=${small}:r=${rate},noise=alls=12:allf=t+u[c];[a][b]overlay=shortest=1:enable='between(n,45,99)'[ab];[ab][c]overlay=shortest=1:enable='gte(n,100)',setsar=1[v]`;
 await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex',graph,'-map','[v]','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',file],{timeout:60000});
 const bytes=await readFile(file);
 return f.store.put('assets',{id,projectId:f.project.id,name,mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:320,height:180,duration:frames/rate,provenance:'user-import'});
}
const capture=async(f: ReturnType<typeof fixture>,asset: ReturnType<ReturnType<typeof fixture>['video']>,requestedFrame: number)=>{
 const managed=validateManagedSource(f.root,asset,{maxBytes:SCENE_LIMITS.sourceBytes});
 return (await decodeManagedFrame({root:f.root,asset,file:managed.file,info:managed.info as unknown as Record<string, unknown>,requestedFrame})).bytes;
};

test('real storyboard keyframes are byte-identical to frame capture at the same marks', async t=>{
 const f=fixture(t,{real:true}),asset=await film(f);
 const detect=await f.call('scene.detect',{projectId:f.project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,requestId:randomUUID()});
 const result=((await f.state(detect.id,'succeeded')) as unknown as SceneDetectTaskResponse).result;
 const saved=await f.call('scene.result.get',{projectId:f.project.id,assetId:asset.id});
 assert.deepEqual((saved.result)!.cuts.map(cut=>cut.frame),[45,100]);
 const ack=await f.call('scene.shots.create',{projectId:f.project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,resultId:(result)!.id,segments:[1,2,3],requestId:randomUUID()});
 const done=await f.state(ack.id,'succeeded');
 const marks=sceneShotPlan({titlePrefix:'参考',origin:{x:0,y:0},segments:[[1,0,45],[2,45,100],[3,100,(result)!.frameCount]]}).map(item=>item.sourceFrame);
 const hashes=(done.shots)!.map((item: { assetId: string; })=>(f.store.get('assets',item.assetId))!.sha256);
 assert.equal(new Set(hashes).size,3,'three different shots');
 for(const [index,mark] of marks.entries())assert.equal(hashes[index],digest(await capture(f,asset,mark)),`segment ${index+1}`);
 assert.deepEqual((staging(f.root) as unknown),[]);
});

test('real keyframe decoding answers marks between two source frames with one image', async t=>{
 const f=fixture(t,{real:true}),asset=await film(f,{rate:10,frames:20,name:'Ten fps.mp4'});
 const managed=validateManagedSource(f.root,asset,{maxBytes:SCENE_LIMITS.sourceBytes}),frames: Parameters<NonNullable<DecodeSceneKeyframesOptions['onFrame']>>[0][]=[];
 const decoded=await decodeSceneKeyframes({root:f.root,asset,file:managed.file,info:managed.info as unknown as Record<string, unknown>,marks:[1,2,3,4],onFrame:frame=>frames.push(frame)});
 assert.deepEqual(decoded.frameOf,[0,0,0,1]);assert.deepEqual(frames.map(frame=>frame.marks),[[0,1,2],[3]]);
 assert.deepEqual([decoded.width,decoded.height,decoded.sourceHash],[320,180,asset.sha256]);
 assert.equal(digest(frames[0].bytes),digest(await capture(f,asset,1)));
 assert.equal(digest(frames[1].bytes),digest(await capture(f,asset,4)));
});
