import type {SceneCall, SceneServices, SceneHandlerService} from './helpers/strict-scene-types.ts';
import type {SceneServicesOptions} from '../packages/business/src/scene-tasks.ts';
import type {SceneDetectTaskResponse} from '@mioon/contracts';
import type {DatabaseSync} from 'node:sqlite';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import {createServices} from '../packages/business/src/services.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {RESTORE_DENIED_OPERATIONS,RESTORE_READ_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {SCENE_LIMITS,SCENE_MUTATION_OPERATIONS,SCENE_DETECTION_DEFAULTS,schemas,descriptions,operationEffect,isSceneTaskResponse,isSceneResultResponse,
 isSceneRequestResponse,isSceneListResponse,isSceneMutationResponse,canonicalSceneInput} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';
import type { BinaryLike } from 'crypto';
import type { DetectManagedScenesOptions } from '@mioon/business/scene-detection-decoder';

const digest=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const code=(expected: string,check: ((arg0: { code: string; }) => unknown)|undefined=()=>true)=>(error: unknown)=>(error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} }).code===expected&&!JSON.stringify((error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} })).includes('PRIVATE_SENTINEL')&&check((error as { code: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}} }));
const proven=(operation: string,input: {projectId: string; requestId: string})=>(error: unknown)=>{

 const proof=(error as {code?: string; details?: {sceneOutcome?: {status: string; operation: string; projectId: string; requestId: string; inputHash: string}}}).details?.sceneOutcome;
 return proof?.status==='not_accepted'&&proof.operation===operation&&proof.projectId===input.projectId&&proof.requestId===input.requestId&&proof.inputHash===digest(canonicalSceneInput(input));
};
const deferred=()=>{let resolve!: (value?: unknown) => void;const promise=new Promise<unknown>(yes=>{resolve=yes;});return {promise,resolve};};
async function until<T>(read: () => T | false | Promise<T | false>, label: string): Promise<T>{const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(5);}assert.fail(`Timed out: ${label}`);}
const cutsOf=(...frames: number[])=>frames.map((frame,index)=>({frame,score:Number((0.3+index/100).toFixed(4))}));
const detection=(input: DetectManagedScenesOptions,{cuts=cutsOf(30,60),frameCount=90}={}): Awaited<ReturnType<NonNullable<SceneServicesOptions['detect']>>>=>({profileId:'scene-cuts-v1',fps:30,frameCount,options:input.options as Awaited<ReturnType<NonNullable<SceneServicesOptions['detect']>>>['options'],cuts,segments:[],
 sourceHash:(input.asset as {sha256: string}).sha256,analysis:{width:256,height:144,decodedFrames:frameCount}});
const cancelled=()=>Object.assign(new Error('cancelled'),{code:'MEDIA_CANCELLED'});

function fixture(t: test.TestContext,{autoRun=false,detect,fault,lock=true,real=false}: Pick<SceneServicesOptions, 'autoRun' | 'fault'> & {detect?: (input: DetectManagedScenesOptions) => unknown} & {lock?: boolean; real?: boolean}={}){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-scene-tasks-'))),store=(openStore(root,{lock}) as unknown as TypedStore);
 const project=store.put('projects',{id:randomUUID(),name:'Scene source project'}),other=store.put('projects',{id:randomUUID(),name:'Other project'});
 const video=(patch: Record<string, unknown>={})=>{
  const bytes=Buffer.from(`Synthetic reference film ${randomUUID()} PRIVATE_SENTINEL`),id=randomUUID(),relativePath=`media/${id}.mp4`;
  writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
  return store.put('assets',{id,projectId:project.id,name:'Reference.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:320,height:180,duration:3,provenance:'user-import',...patch});
 };
 const asset=video();let calls=0,closed=false;
 const services=(createSceneServices(store,({autoRun,fault,...(real?{}:{detect:async input=>{calls++;if(detect)return detect(input);(input.beforeSpawn)!(input.signal!);return detection(input);}})} as SceneServicesOptions)) as SceneHandlerService<'detect'>);
 const close=async()=>{if(closed)return;closed=true;try{await services.drain();}finally{store.close();}};
 t.after(async()=>{try{await close();}finally{rmSync(root,{recursive:true,force:true});}});
 const call=(async(op: string,input: unknown)=>services.handlers[op]!(input)) as SceneCall<'detect'>;
 return {root,store,services,project,other,asset,video,call,close,get calls(){return calls;},
  input:(patch: Record<string, unknown>={})=>({projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,requestId:randomUUID(),...patch}),
  get:(id: string)=>call('scene.task.get',{projectId:project.id,taskId:id}),
  control:(value: { id: unknown; revision: unknown; },patch: Record<string, unknown>={})=>({projectId:project.id,taskId:value.id,expectedRevision:value.revision,requestId:randomUUID(),...patch}),
  result:(assetId: unknown=asset.id)=>call('scene.result.get',{projectId:project.id,assetId})};
}
const state=(f: ReturnType<typeof fixture>,id: string,expected: string)=>until(async()=>{const value=await f.get(id);return value.state===expected&&value;},expected);
const rows=(db: DatabaseSync)=>JSON.stringify(['scene_tasks','scene_requests','scene_results'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

test('schema58 gives ordinary workspaces the three scene tables', t=>{
 const f=fixture(t);
 assert.equal(readCurrentWorkspaceRole(f.store.db),'ordinary-62');
 assert.deepEqual(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'scene_*' ORDER BY name").all().map(row=>row.name),['scene_requests','scene_results','scene_tasks']);
 assert.equal((f.store.db.prepare('SELECT max(version) AS v FROM schema_version').get())!.v,62);
 // Rows outside the accepted shape cannot be written directly.
 assert.throws(()=>f.store.db.prepare("INSERT INTO scene_tasks(id,projectId,kind,sourceAssetId,requestId,inputHash,input,snapshot,state,revision,started,createdAt,updatedAt) VALUES(?,?,'detect',?,?,?,?,?,'running',1,1,'t','t')")
  .run(randomUUID(),f.project.id,f.asset.id,'direct-row-1','a'.repeat(64),'{}','{}'),/CHECK constraint failed|scene tasks must be accepted/);
});

test('operations are registered, described, effect-annotated, restore-classified and localized', ()=>{
 for(const operation of ['scene.detect','scene.request.get','scene.task.get','scene.task.list','scene.task.cancel','scene.result.get','scene.cuts.save'] as const){
  assert.ok(schemas[operation]&&descriptions[operation].length>30,operation);
  assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
  for(const locale of ['zh-Hant','en','ja'] as const)assert.ok(translate(locale,`operation.${operation}`).length>30,`${operation} ${locale}`);
  const mutation=(SCENE_MUTATION_OPERATIONS as readonly string[]).includes(operation),effect=operationEffect(operation);
  assert.equal(effect.readOnly,!mutation,operation);assert.equal(effect.paidGeneration,false);assert.equal(effect.externalIO,false);
  assert.ok((mutation?RESTORE_DENIED_OPERATIONS:RESTORE_READ_OPERATIONS).includes(operation),operation);
 }
});

test('the acceptance receipt is durable before decoding and replays exactly', async t=>{
 const f=fixture(t),input=f.input(),ack=await f.call('scene.detect',input);
 assert.ok(isSceneTaskResponse(ack));assert.ok(isSceneMutationResponse('scene.detect',input,ack));
 assert.deepEqual([ack.state,ack.revision,ack.started,ack.result,ack.progress],['queued',1,false,null,null]);
 assert.deepEqual(ack.options,SCENE_DETECTION_DEFAULTS);assert.equal(f.calls,0);
 const before=rows(f.store.db);
 assert.deepEqual(await f.call('scene.detect',input),ack);assert.equal(rows(f.store.db),before);
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:input.requestId});
 assert.ok(isSceneRequestResponse(receipt));assert.deepEqual((receipt)!.response,ack);
 assert.equal(await f.call('scene.request.get',{projectId:f.other.id,requestId:input.requestId}),null);
 for(const patch of [{options:{sensitivity:80}},{sourceHash:'a'.repeat(64)},{projectId:f.other.id}])
  await assert.rejects(f.call('scene.detect',{...input,...patch}),code('SCENE_REQUEST_CONFLICT'));
 await assert.rejects(f.call('scene.task.get',{projectId:f.other.id,taskId:ack.id}),code('SCENE_NOT_FOUND'));
 // A second detection of a video already queued is refused with a proof.
 const again=f.input();
 await assert.rejects(f.call('scene.detect',again),error=>code('SCENE_TASK_ACTIVE')(error)&&proven('scene.detect',again)(error));
 const other=f.video(),changed=f.input({sourceAssetId:other.id,sourceHash:'b'.repeat(64)});
 await assert.rejects(f.call('scene.detect',changed),error=>code('SCENE_SOURCE_CHANGED')(error)&&proven('scene.detect',changed)(error));
 const image=f.video({mimeType:'image/png',name:'Still.png'});
 await assert.rejects(f.call('scene.detect',f.input({sourceAssetId:image.id,sourceHash:image.sha256})),code('SCENE_SOURCE_INVALID'));
 await assert.rejects(f.call('scene.detect',f.input({options:{mode:'fast'}})),code('VALIDATION_ERROR'));
 assert.equal(rows(f.store.db),before);assert.equal(f.calls,0);
});

test('a completed run saves the newest detected result', async t=>{
 const f=fixture(t,{autoRun:true}),input=f.input({options:{sensitivity:72,minShotSeconds:0.5}}),ack=await f.call('scene.detect',input);
 const done=await state(f,ack.id,'succeeded');
 assert.equal(f.calls,1);assert.equal(done.revision,3);assert.equal(done.started,true);assert.equal(done.errorCode,null);
 assert.deepEqual(done.options,{mode:'adaptive',sensitivity:72,minShotSeconds:0.5});
 assert.deepEqual({frameCount:(done.result)!.frameCount,cutCount:(done.result)!.cutCount},{frameCount:90,cutCount:2});
 const saved=await f.result();
 assert.ok(isSceneResultResponse(saved));assert.equal(saved.current,true);assert.equal(saved.staleReason,null);
 assert.equal((saved.result)!.id,(done.result)!.id);assert.equal((saved.result)!.origin,'detected');assert.equal((saved.result)!.taskId,ack.id);
 assert.deepEqual((saved.result)!.cuts,cutsOf(30,60));assert.deepEqual((saved.result)!.options,done.options);
 const page=await f.call('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id});
 assert.ok(isSceneListResponse('scene.task.list',{projectId:f.project.id,sourceAssetId:f.asset.id},page));
 assert.deepEqual(page.items.map(item=>item.id),[ack.id]);
 assert.deepEqual(((await f.call('scene.task.list',{projectId:f.project.id,sourceAssetId:f.video().id})).items as unknown),[]);
 assert.deepEqual(await f.call('scene.detect',input),ack,'the original acknowledgement replays after success');
 assert.equal((await f.result(f.video().id)).result,null);
});

test('queued and running tasks can be cancelled; a running one saves nothing', async t=>{
 const f=fixture(t),queued=await f.call('scene.detect',f.input()),control=f.control(queued),first=await f.call('scene.task.cancel',control);
 assert.deepEqual([first.state,first.revision,first.started],['cancelled_before_start',2,false]);
 assert.deepEqual(await f.call('scene.task.cancel',control),first);
 await assert.rejects(f.call('scene.task.cancel',f.control(first)),code('SCENE_STATE_CONFLICT'));
 await assert.rejects(f.call('scene.task.cancel',f.control(queued)),code('SCENE_REVISION_CONFLICT'));

 const started=deferred(),g=fixture(t,{autoRun:true,detect:async input=>{
  input.beforeSpawn!(input.signal!);(started.resolve)!();
  await new Promise((_,reject)=>input.signal!.addEventListener('abort',()=>reject(cancelled()),{once:true}));
 }});
 const ack=await g.call('scene.detect',g.input());await started.promise;
 const running=await g.get(ack.id);assert.deepEqual([running.state,running.revision],['running',2]);
 const cancelling=await g.call('scene.task.cancel',g.control(running));
 assert.deepEqual([cancelling.state,cancelling.revision,cancelling.started],['cancelling',3,true]);
 const finished=await state(g,ack.id,'cancelled');assert.equal(finished.revision,4);assert.equal(finished.errorCode,null);
 assert.equal((await g.result()).result,null);
 // The freed slot accepts a new detection of the same video.
 assert.equal((await g.call('scene.detect',g.input())).state,'queued');
});

test('a cancel that lands after the decoder finished still wins', async t=>{
 let f!: ReturnType<typeof fixture>;
 f=fixture(t,{autoRun:true,fault:(stage: string)=>{
  if(stage!=='after_detection')return;
  const [task]=f.store.db.prepare("SELECT id FROM scene_tasks WHERE state='running'").all();
  const value=f.services.handlers['scene.task.get']({projectId:f.project.id,taskId:task.id});
  f.services.handlers['scene.task.cancel'](f.control(value));
 }});
 const ack=await f.call('scene.detect',f.input()),done=await state(f,ack.id,'cancelled');
 assert.equal(done.result,null);assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM scene_results').get())!.n,0);
});

test('restart reconciliation never resumes or reruns work', async t=>{
 const f=fixture(t),second=f.video(),queued=await f.call('scene.detect',f.input()),active=await f.call('scene.detect',f.input({sourceAssetId:second.id,sourceHash:second.sha256}));
 const now=new Date().toISOString();
 f.store.db.prepare("UPDATE scene_tasks SET state='running',started=1,revision=2,updatedAt=? WHERE id=?").run(now,active.id);
 f.store.db.prepare("UPDATE scene_tasks SET state='cancelling',revision=3,updatedAt=? WHERE id=?").run(now,active.id);
 await f.close();
 let calls=0;
 const store=(openStore(f.root) as unknown as TypedStore),services=(createSceneServices(store,({detect:async()=>{calls++;assert.fail('restart decoded');}} as SceneServicesOptions)) as SceneHandlerService<'detect'>);
 t.after(async()=>{await services.drain();store.close();});
 const read=(id: string)=>services.handlers['scene.task.get']({projectId:f.project.id,taskId:id});
 assert.deepEqual([read(queued.id).state,read(queued.id).revision,read(queued.id).errorCode],['interrupted',2,'SCENE_INTERRUPTED']);
 assert.deepEqual([read(active.id).state,read(active.id).revision,read(active.id).errorCode],['cancelled',4,null]);
 // An interrupted, never-started task can still be cancelled explicitly.
 const interrupted=read(queued.id),cancelledValue=services.handlers['scene.task.cancel']({projectId:f.project.id,taskId:queued.id,expectedRevision:interrupted.revision,requestId:randomUUID()});
 assert.equal(cancelledValue.state,'cancelled_before_start');
 await pause(20);assert.equal(calls,0);
});

test('manual cuts become a new result on top of the current one', async t=>{
 const f=fixture(t,{autoRun:true}),ack=await f.call('scene.detect',f.input()),done=await state(f,ack.id,'succeeded');
 const save={projectId:f.project.id,assetId:f.asset.id,sourceHash:f.asset.sha256,expectedResultId:(done.result)!.id,cuts:[30,75],requestId:randomUUID()};
 const summary=await f.call('scene.cuts.save',save);
 assert.ok(isSceneMutationResponse('scene.cuts.save',save,summary));
 assert.deepEqual([summary.origin,summary.basedOnResultId,summary.cutCount,summary.frameCount,summary.taskId],['manual',(done.result)!.id,2,90,null]);
 assert.deepEqual(await f.call('scene.cuts.save',save),summary,'exact replay');
 const saved=await f.result();
 assert.equal((saved.result)!.id,summary.id);assert.equal(saved.current,true);assert.equal((saved.result)!.options,null);
 assert.deepEqual((saved.result)!.cuts,[{frame:30,score:0.3},{frame:75,score:null}],'a kept cut keeps its score');
 const stale={...save,cuts:[10],requestId:randomUUID()};
 await assert.rejects(f.call('scene.cuts.save',stale),error=>code('SCENE_RESULT_CONFLICT')(error)&&proven('scene.cuts.save',stale)(error));
 await assert.rejects(f.call('scene.cuts.save',{...save,expectedResultId:summary.id,cuts:[90],requestId:randomUUID()}),code('SCENE_CUTS_INVALID'));
 await assert.rejects(f.call('scene.cuts.save',{...save,expectedResultId:summary.id,cuts:[40,20],requestId:randomUUID()}),code('VALIDATION_ERROR'));
 const cleared=await f.call('scene.cuts.save',{...save,expectedResultId:summary.id,cuts:[],requestId:randomUUID()});
 assert.equal(cleared.cutCount,0);assert.deepEqual((((await f.result()).result)!.cuts as unknown),[]);
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:save.requestId});
 assert.deepEqual(receipt,{projectId:f.project.id,requestId:save.requestId,operation:'scene.cuts.save',response:summary});
});

test('a changed source marks the result stale and blocks edits on it', async t=>{
 const f=fixture(t,{autoRun:true}),ack=await f.call('scene.detect',f.input()),done=await state(f,ack.id,'succeeded');
 f.store.put('assets',{...f.store.get('assets',f.asset.id),sha256:'c'.repeat(64)});
 const saved=await f.result();
 assert.deepEqual([saved.current,saved.staleReason,(saved.result)!.id],[false,'SOURCE_CHANGED',(done.result)!.id]);
 await assert.rejects(f.call('scene.cuts.save',{projectId:f.project.id,assetId:f.asset.id,sourceHash:'c'.repeat(64),expectedResultId:(done.result)!.id,cuts:[],requestId:randomUUID()}),code('SCENE_RESULT_STALE'));
 await assert.rejects(f.call('scene.cuts.save',{projectId:f.project.id,assetId:f.asset.id,sourceHash:f.asset.sha256,expectedResultId:(done.result)!.id,cuts:[],requestId:randomUUID()}),code('SCENE_SOURCE_CHANGED'));
});

test('decoder failures end as safe task errors without results', async t=>{
 const outcomes: [((input: DetectManagedScenesOptions) => ReturnType<typeof detection>), string][]=[[()=>{throw Object.assign(new Error('PRIVATE_SENTINEL profile'),{code:'SCENE_PROFILE_UNSUPPORTED'});},'SCENE_PROFILE_UNSUPPORTED'],
  [()=>{throw new Error('PRIVATE_SENTINEL unknown');},'SCENE_DETECTION_FAILED'],
  [(input: DetectManagedScenesOptions)=>detection(input,{cuts:Array.from({length:SCENE_LIMITS.cuts+1},(_,index)=>({frame:index+1,score:0.2})),frameCount:SCENE_LIMITS.cuts+10}),'SCENE_CUTS_LIMIT']];
 for(const [behave,expected] of outcomes){
  const f=fixture(t,{autoRun:true,detect:async input=>{input.beforeSpawn!(input.signal!);return behave(input);}});
  const ack=await f.call('scene.detect',f.input()),failed=await state(f,ack.id,'failed');
  assert.equal(failed.errorCode,expected);assert.equal(failed.result,null);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_SENTINEL/);
  assert.equal((await f.result()).result,null);
 }
});

test('live progress is reported only while the task runs', async t=>{
 const release=deferred(),reported=deferred(),f=fixture(t,{autoRun:true,detect:async (input: DetectManagedScenesOptions)=>{
  (input.beforeSpawn)!(input.signal!);(input.onProgress)!({frames:30,frameCount:90,cuts:[30]});(reported.resolve)!();await release.promise;return detection(input);
 }});
 const ack=await f.call('scene.detect',f.input());await reported.promise;
 const running=await f.get(ack.id);assert.deepEqual(running.progress,{frames:30,frameCount:90,cuts:1});assert.ok(isSceneTaskResponse(running));
 const page=await f.call('scene.task.list',{projectId:f.project.id});assert.deepEqual(page.items[0].progress,running.progress);
 (release.resolve)!();const done=await state(f,ack.id,'succeeded');assert.equal(done.progress,null);
 const receipt=await f.call('scene.request.get',{projectId:f.project.id,requestId:ack.requestId});assert.equal((receipt!.response as SceneDetectTaskResponse).progress,null);
});

test('a non-owner reads without writing and cannot mutate', async t=>{
 const f=fixture(t),ack=await f.call('scene.detect',f.input()),observer=(openStore(f.root,{lock:false}) as unknown as TypedStore),services=(createSceneServices(observer,({detect:()=>assert.fail('read spawned decode')} as SceneServicesOptions)) as SceneHandlerService<'detect'>);
 t.after(async()=>{await services.drain();observer.close();});assert.equal(ownsStoreLock(observer),false);
 const before=rows(observer.db);
 assert.deepEqual(services.handlers['scene.task.get']({projectId:f.project.id,taskId:ack.id}),ack);
 assert.equal(services.handlers['scene.task.list']({projectId:f.project.id}).items.length,1);
 assert.equal(services.handlers['scene.result.get']({projectId:f.project.id,assetId:f.asset.id}).result,null);
 for(const [op,input] of [['scene.detect',f.input()],['scene.task.cancel',f.control(ack)],['scene.cuts.save',{projectId:f.project.id,assetId:f.asset.id,sourceHash:f.asset.sha256,expectedResultId:randomUUID(),cuts:[],requestId:randomUUID()}]] as const)
  assert.throws(()=>services.handlers[op](input),code('SCENE_OWNER_REQUIRED'));
 assert.equal(rows(observer.db),before);
});

test('scene records survive backup and restore; the restored copy only reads them', async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-scene-restore-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),store=(openStore(source) as unknown as TypedStore),bytes=Buffer.from('Synthetic reference film for backup');
 const services=(createServices(store,new Map(),{sceneOptions:{detect:async input=>{(input.beforeSpawn)!(input.signal!);return detection(input);}}}) as unknown as SceneServices);
 const project=await services.call('project.create',{name:'Scene backup'}),id=randomUUID();
 writeFileSync(path.join(source,`media/${id}.mp4`),bytes,{mode:0o600});
 const asset=store.put('assets',{id,projectId:project.id,name:'Reference.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath:`media/${id}.mp4`,width:320,height:180,duration:3,provenance:'user-import'});
 const input={projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,requestId:randomUUID()},ack=await services.call('scene.detect',input);
 const done=await until(async()=>{const value=await services.call('scene.task.get',{projectId:project.id,taskId:ack.id});return value.state==='succeeded'&&value;},'succeeded');
 await services.drain();store.close();
 await createWorkspaceBackup({source,destination:path.join(root,'backup')});
 await restoreWorkspaceBackup({directory:path.join(root,'backup'),destination:path.join(root,'restored')});
 const restoredStore=(openStore(path.join(root,'restored')) as unknown as TypedStore),restored=(createServices(restoredStore,new Map()) as unknown as SceneServices);
 t.after(()=>restoredStore.close());
 assert.equal(readCurrentWorkspaceRole(restoredStore.db),'restored-63-evidence');
 assert.deepEqual(await restored.call('scene.task.get',{projectId:project.id,taskId:ack.id}),done);
 assert.equal(((await restored.call('scene.result.get',{projectId:project.id,assetId:asset.id})).result)!.id,(done.result)!.id);
 await assert.rejects(restored.call('scene.detect',{...input,requestId:randomUUID()}),code('RESTORE_OPERATION_UNAVAILABLE'));
 await assert.rejects(restored.call('scene.cuts.save',{projectId:project.id,assetId:asset.id,sourceHash:asset.sha256,expectedResultId:(done.result)!.id,cuts:[],requestId:randomUUID()}),code('RESTORE_OPERATION_UNAVAILABLE'));
});

// Real FFmpeg on a managed source: three shots with hard cuts at frames 45 and 100.
test('real detection through the service finds the hard cuts', async t=>{
 const f=fixture(t,{autoRun:true,real:true});
 const id=randomUUID(),relativePath=`media/${id}.mp4`,file=path.join(f.root,relativePath),small='s=320x180';
 const graph=`testsrc2=${small}:r=30,trim=end_frame=150[a];perlin=${small}:r=30:octaves=4:persistence=0.6:tscale=0.3:random_mode=seed:seed=3,format=gbrp[b];`+
  `smptehdbars=${small}:r=30,noise=alls=12:allf=t+u[c];[a][b]overlay=shortest=1:enable='between(n,45,99)'[ab];[ab][c]overlay=shortest=1:enable='gte(n,100)',setsar=1[v]`;
 await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex',graph,'-map','[v]','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',file],{timeout:60000});
 const bytes=await readFile(file);
 const asset=f.store.put('assets',{id,projectId:f.project.id,name:'Three shots.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:320,height:180,duration:5,provenance:'user-import'});
 const ack=await f.call('scene.detect',f.input({sourceAssetId:asset.id,sourceHash:asset.sha256})),done=await state(f,ack.id,'succeeded');
 const saved=await f.result(asset.id);
 assert.deepEqual((saved.result)!.cuts.map(cut=>cut.frame),[45,100]);assert.equal((saved.result)!.frameCount,(done.result)!.frameCount);
 assert.ok(Math.abs((done.result)!.frameCount-150)<=1);
});
