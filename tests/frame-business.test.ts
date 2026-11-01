import type {FrameServicesOptions} from '../packages/business/src/frames.ts';
import type {DecodeManagedFrameOptions, DecodedManagedFrame} from '../packages/business/src/frame-decoder.ts';
type FixtureFrameInput = DecodeManagedFrameOptions & {requestedFrame:number;asset:{sha256:string};beforeSpawn:(signal:AbortSignal)=>void;signal:AbortSignal};
type FixtureFrameOptions = Omit<FrameServicesOptions,'decode'> & {lock?:boolean; decode?:(input:FixtureFrameInput)=>Promise<Pick<DecodedManagedFrame,'bytes'|'provenance'>>};
import type {DatabaseSync} from 'node:sqlite';
import type {TypedCall} from './helpers/strict-service-responses.ts';
import type {TypedFrameServices, TypedFrameCall} from './helpers/strict-timeline-audio-factory-types.ts';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,statSync,unlinkSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createFrameServices} from '../packages/business/src/frames.ts';
import {validatePng} from '../packages/business/src/images/png.ts';
import {FRAME_LIMITS,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,isFrameTaskResponse,isFrameRequestResponse,isFrameListResponse} from '../packages/contracts/src/frame-extraction.ts';
import {schemaObjects} from './helpers/project-database.ts';
import type { BinaryLike } from 'crypto';

const digest=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const error=(code: string)=>(cause: { code: string; })=>cause.code===code&&!JSON.stringify(cause).includes('PRIVATE_SENTINEL');
const deferred=<T = unknown>()=>{let resolve!: (value?: T | PromiseLike<T>) => void;const promise=new Promise<T>(yes=>{resolve=(yes as (value?: T | PromiseLike<T>) => void);});return {promise,resolve};};
function png(width=4,height=2){
 const chunk=(name: string,data: Buffer<ArrayBuffer>)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);let crc=0xffffffff;for(const byte of out.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const bytes=png();
const outcome=(input: FixtureFrameInput)=>({bytes,provenance:{profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,sourceFrame:input.requestedFrame,fps:30,sourceHash:input.asset.sha256,
 probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:4,height:2,rotation:0,sarNumerator:1,sarDenominator:1}}});
const rows=(db: DatabaseSync)=>JSON.stringify(schemaObjects(db).filter(({type})=>type==='table').map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const count=(db: DatabaseSync,table: string)=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
const total=(db: DatabaseSync)=>db.prepare('SELECT total_changes() AS n').get()!.n;
function privateFree(value: { projectId: string; requestId: string; operation: "frame.extract"|"frame.task.cancelQueued"|"frame.task.recoverResult"; response?: unknown; }|null){assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SENTINEL|"(?:relativePath|snapshot|stagedReceipt|canonicalInput|bytes|path)"\s*:/);}
async function until<T>(fn: () => T | Promise<T>,label: unknown){const deadline=Date.now()+10000;while(Date.now()<deadline){const result=await fn();if(result)return result;await pause(5);}assert.fail(`Timed out: ${label}`);}
function fixture(t: test.TestContext,{autoRun=false,decode,fault,lock=true}: FixtureFrameOptions={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-frame-business-')),store=(openStore(root,{lock}) as TypedStore);
 const project=store.put('projects',{id:randomUUID(),name:'Frame source project'}),other=store.put('projects',{id:randomUUID(),name:'Other project'});
 const sourceBytes=Buffer.from('Synthetic managed source bytes PRIVATE_SENTINEL'),id=randomUUID(),relativePath=`media/${id}.mp4`;
 writeFileSync(path.join(root,relativePath),sourceBytes,{mode:0o600});
 const asset=store.put('assets',{id,projectId:project.id,name:'Managed original.mp4',mimeType:'video/mp4',sha256:digest(sourceBytes),sizeBytes:sourceBytes.length,relativePath,width:4,height:2,duration:1,provenance:'user-import'});
 let calls=0;
 const services=(createFrameServices(store,{autoRun,fault,decode:async (input: FixtureFrameInput)=>{calls++;if(decode)return decode(input);input!.beforeSpawn!(input!.signal!);return outcome(input);}} as unknown as FrameServicesOptions) as TypedFrameServices);
 t.after(async()=>{try{await services.drain();}finally{store.close();rmSync(root,{recursive:true,force:true});}});
 const call=((async(op: string,input: unknown)=>services.handlers[op](input)) as unknown as TypedCall);
 return {root,store,services,project,other,asset,call,get calls(){return calls;},input:(patch?: Record<string, unknown>)=>({projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,sourceFrame:0,requestId:randomUUID(),...patch}),
  get:(id: string)=>call('frame.task.get',{projectId:project.id,taskId:id}),control:(value: { id: unknown; revision: unknown; },patch?: Record<string, unknown>)=>({projectId:project.id,taskId:value.id,expectedRevision:value.revision,requestId:randomUUID(),...patch})};
}
const state=(f: Awaited<ReturnType<typeof fixture>>,id: string,expected: string)=>until(async()=>{const value=await f.get(id);return value.state===expected&&value;},expected);

test('exact original ACK wins over stale CAS and changed keys, with no replay decode or write',async t=>{
 const f=fixture(t),input=f.input(),ack=await f.call('frame.extract',input);assert.ok(isFrameTaskResponse(ack));assert.equal(ack.state,'queued');assert.equal(f.calls,0);
 const control=f.control(ack),cancelled=await f.call('frame.task.cancelQueued',control),before=rows(f.store.db),changes=total(f.store.db);
 assert.equal(cancelled.state,'cancelled_before_start');assert.equal(cancelled.revision,2);
 assert.deepEqual(await f.call('frame.extract',input),ack);assert.deepEqual(await f.call('frame.task.cancelQueued',control),cancelled);
 const receipt=await f.call('frame.request.get',{projectId:f.project.id,requestId:input.requestId});assert.ok(isFrameRequestResponse(receipt));assert.deepEqual(receipt!.response,ack);
 assert.equal(await f.call('frame.request.get',{projectId:f.other.id,requestId:input.requestId}),null);
 for(const patch of [{sourceFrame:1},{sourceHash:'a'.repeat(64)},{projectId:f.other.id}])await assert.rejects(f.call('frame.extract',{...input,...patch}),error('FRAME_REQUEST_CONFLICT'));
 await assert.rejects(f.call('frame.task.cancelQueued',{...control,requestId:input.requestId}),error('FRAME_REQUEST_CONFLICT'));
 await assert.rejects(f.call('frame.task.cancelQueued',{...control,requestId:randomUUID()}),error('FRAME_REVISION_CONFLICT'));
 for(const taskId of [ack.id,randomUUID()])for(const op of ['frame.task.get','frame.task.cancelQueued','frame.task.recoverResult']){
  const args={projectId:f.other.id,taskId,...(op.endsWith('.get')?{}:{expectedRevision:1,requestId:randomUUID()})};await assert.rejects(f.call(op,args),error('FRAME_NOT_FOUND'));
 }
 assert.equal(rows(f.store.db),before);assert.equal(total(f.store.db),changes);assert.equal(f.calls,0);privateFree(receipt);
});

test('bounded PNG publication owns a new asset and preserves original, legacy history and ACK',async t=>{
 const f=fixture(t,{autoRun:true}),original=JSON.stringify(f.store.get('assets',f.asset.id)),source=readFileSync(path.join(f.root,f.asset.relativePath));
 const job=f.store.put('jobs',{id:randomUUID(),projectId:f.project.id,state:'legacy-byte-sentinel'}),input=f.input({sourceFrame:1}),ack=await f.call('frame.extract',input),result=await state(f,ack.id,'succeeded');
 assert.equal(f.calls,1);assert.notEqual(result.result.assetId,f.asset.id);assert.equal(result.revision,4);assert.equal(result.started,true);
 const asset=f.store.get('assets',result.result.assetId)!,file=path.join(f.root,asset.relativePath);assert.equal(asset.provenance,'extracted-frame');assert.deepEqual(readFileSync(file),bytes);assert.equal(statSync(file).mode&0o777,0o600);
 assert.deepEqual(await validatePng(readFileSync(file),{width:4,height:2}),{mimeType:'image/png',width:4,height:2,byteLength:bytes.length,sha256:digest(bytes)});
 assert.equal(JSON.stringify(f.store.get('assets',f.asset.id)),original);assert.deepEqual(readFileSync(path.join(f.root,f.asset.relativePath)),source);assert.deepEqual(f.store.get('jobs',job.id),job);
 assert.equal(count(f.store.db,'versions'),0);assert.equal(count(f.store.db,'image_versions'),0);assert.deepEqual(await f.call('frame.extract',input),ack);assert.equal(f.calls,1);
 assert.ok(!rows(f.store.db).includes(bytes.toString('base64')));privateFree(result);
});

test('nonowner GET/list/request reads perform zero writes or storage creation',async t=>{
 const f=fixture(t),ack=await f.call('frame.extract',f.input());
 // A second connection to the project opens only once the owner has closed it.
 await f.services.drain();f.store.close();
 const observer=(openStore(f.root,{lock:false}) as TypedStore),services=(createFrameServices(observer,{decode:()=>assert.fail('read spawned decode')}) as TypedFrameServices);
 t.after(async()=>{await services.drain();observer.close();});assert.equal(ownsStoreLock(observer),false);
 const before=rows(observer.db),changes=total(observer.db),files=readdirSync(f.root).sort();
 for(const [op,input] of [['frame.task.get',{projectId:f.project.id,taskId:ack.id}],['frame.task.list',{projectId:f.project.id}],['frame.request.get',{projectId:f.project.id,requestId:ack.requestId}]] as const)privateFree(await services.handlers[op](input));
 for(const [op,input] of [['frame.extract',f.input()],['frame.task.cancelQueued',f.control(ack)],['frame.task.recoverResult',f.control(ack)]] as const)await assert.rejects(Promise.resolve().then(()=>services.handlers[op](input)),error('FRAME_OWNER_REQUIRED'));
 assert.equal(rows(observer.db),before);assert.equal(total(observer.db),changes);assert.deepEqual(readdirSync(f.root).sort(),files);assert.equal(f.calls,0);
});

test('strict input and source limits reject foreign or missing identity without decoding',async t=>{
 const f=fixture(t),before=rows(f.store.db);
 for(const patch of [{decode:'x'},{path:'/PRIVATE_SENTINEL'},{profileId:FRAME_PROFILE_ID},{sourceFrame:-1},{sourceFrame:0.5},{requestId:'short'},{sourceHash:'x'.repeat(64)}])await assert.rejects(f.call('frame.extract',f.input(patch)),error('VALIDATION_ERROR'));
 for(const sourceAssetId of [f.asset.id,randomUUID()])await assert.rejects(f.call('frame.extract',f.input({projectId:f.other.id,sourceAssetId})),error('FRAME_NOT_FOUND'));
 await assert.rejects(f.call('frame.extract',f.input({sourceHash:'a'.repeat(64)})),error('FRAME_SOURCE_CHANGED'));
 await assert.rejects(f.call('frame.extract',f.input({sourceFrame:30})),error('FRAME_SOURCE_INVALID'));
 assert.equal(rows(f.store.db),before);assert.equal(f.calls,0);
});

test('queue and retained capacity fail closed without evicting original receipts',async t=>{
 const f=fixture(t),first=await f.call('frame.extract',f.input()),second=await f.call('frame.extract',f.input());
 const before=rows(f.store.db);await assert.rejects(f.call('frame.extract',f.input()),error('FRAME_QUEUE_FULL'));assert.equal(rows(f.store.db),before);
 await f.call('frame.task.cancelQueued',f.control(first));await f.call('frame.task.cancelQueued',f.control(second));
 for(let i=2;i<FRAME_LIMITS.tasksPerProject;i++){const ack=await f.call('frame.extract',f.input());await f.call('frame.task.cancelQueued',f.control(ack));}
 assert.equal(count(f.store.db,'frame_tasks'),FRAME_LIMITS.tasksPerProject);const retained=rows(f.store.db);
 await assert.rejects(f.call('frame.extract',f.input()),error('FRAME_CAPACITY'));assert.equal(rows(f.store.db),retained);assert.equal(f.calls,0);
 assert.deepEqual((await f.call('frame.request.get',{projectId:f.project.id,requestId:first.requestId}))!.response,first);
});

test('HMAC cursor binds project, limit and stable order; pages and absent reads do not create rows',async t=>{
 const f=fixture(t);for(let i=0;i<4;i++){const ack=await f.call('frame.extract',f.input());await f.call('frame.task.cancelQueued',f.control(ack));}
 const before=rows(f.store.db),changes=total(f.store.db),input={projectId:f.project.id,limit:2},first=await f.call('frame.task.list',input);
 assert.ok(isFrameListResponse('frame.task.list',input,first));assert.ok(first.nextCursor);const next=await f.call('frame.task.list',{...input,cursor:first.nextCursor});assert.equal(next.items.length,2);assert.equal(next.nextCursor,null);
 assert.equal(new Set([...first.items,...next.items].map(value=>value.id)).size,4);
 for(const patch of [{projectId:f.other.id},{limit:1},{cursor:first.nextCursor.slice(0,-1)+'!'}])await assert.rejects(f.call('frame.task.list',{...input,cursor:first.nextCursor,...patch}),error('INVALID_CURSOR'));
 assert.deepEqual(await f.call('frame.task.list',{projectId:f.other.id}),{projectId:f.other.id,items:[],nextCursor:null});assert.equal(rows(f.store.db),before);assert.equal(total(f.store.db),changes);
});

test('cancel can win before first spawn, but never after the durable start fence',async t=>{
 const entered=deferred(),release=deferred(),f=fixture(t,{autoRun:true,decode:async (input: FixtureFrameInput)=>{entered.resolve!();await release.promise;input.beforeSpawn(input.signal);return outcome(input);}});
 const ack=await f.call('frame.extract',f.input());await entered.promise;const cancelled=await f.call('frame.task.cancelQueued',f.control(ack));release.resolve!();await pause(20);
 assert.equal((await f.get(ack.id)).state,'cancelled_before_start');assert.equal(cancelled.started,false);assert.equal(count(f.store.db,'assets'),1);
});

for(const variant of ['deleted-lock','replaced-lock','source-project','project-identity','source-hash','source-path','source-size','source-duration','source-geometry','source-bytes'])test(`await fence refuses late publication after ${variant}`,async t=>{
 const entered=deferred(),release=deferred(),f=fixture(t,{autoRun:true,decode:async (input: FixtureFrameInput)=>{input.beforeSpawn(input.signal);entered.resolve!();await release.promise;return outcome(input);}});
 const ack=await f.call('frame.extract',f.input());await entered.promise;const running=await f.get(ack.id);await assert.rejects(f.call('frame.task.cancelQueued',f.control(running)),error('FRAME_STATE_CONFLICT'));
 if(variant.includes('lock')){unlinkSync(path.join(f.root,'server.lock'));if(variant==='replaced-lock')writeFileSync(path.join(f.root,'server.lock'),'2147483000',{mode:0o600});}
 else if(variant==='project-identity')f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({id:f.other.id,name:'Changed owner'}),f.project.id);
 else if(variant==='source-bytes')writeFileSync(path.join(f.root,f.asset.relativePath),Buffer.from('changed managed bytes'),{mode:0o600});
 else{const patch=variant==='source-project'?{projectId:f.other.id}:variant==='source-hash'?{sha256:'b'.repeat(64)}:variant==='source-path'?{relativePath:'media/elsewhere.mp4'}:variant==='source-size'?{sizeBytes:9}:variant==='source-duration'?{duration:2}:{width:8};f.store.put('assets',{...f.asset,...patch});}
 const before=count(f.store.db,'assets');release.resolve!();await pause(30);assert.equal(count(f.store.db,'assets'),before);assert.equal(readdirSync(path.join(f.root,'media')).filter(name=>name.endsWith('.png')).length,0);
 assert.equal(f.calls,1);
});


test('global queue admission is bounded across projects and retained rows are never evicted',async t=>{
 const f=fixture(t),acks: (unknown)[]=[];
 for(let index=0;index<4;index++){
  const project=index===0?f.project:f.store.put('projects',{id:randomUUID(),name:`Queue project ${index}`});
  const asset=index===0?f.asset:f.store.put('assets',{...f.asset,id:randomUUID(),projectId:project.id});
  for(let n=0;n<2;n++)acks.push(await f.call('frame.extract',f.input({projectId:project.id,sourceAssetId:asset.id})));
 }
 const project=f.store.put('projects',{id:randomUUID(),name:'Ninth queued project'}),asset=f.store.put('assets',{...f.asset,id:randomUUID(),projectId:project.id});
 const before=rows(f.store.db);await assert.rejects(f.call('frame.extract',f.input({projectId:project.id,sourceAssetId:asset.id})),error('FRAME_QUEUE_FULL'));
 assert.equal(rows(f.store.db),before);assert.equal(acks.length,FRAME_LIMITS.queuedGlobal);assert.equal(f.calls,0);
});

test('concurrent identical keys share one admission; asynchronous preparation is bounded before hashing',async t=>{
 const f=fixture(t),input=f.input();const [first,second]=await Promise.all([f.call('frame.extract',input),f.call('frame.extract',input)]);assert.deepEqual(first,second);assert.equal(count(f.store.db,'frame_tasks'),1);
 await f.call('frame.task.cancelQueued',f.control(first));
 const results=await Promise.allSettled(Array.from({length:12},()=>f.call('frame.extract',f.input())));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,FRAME_LIMITS.queuedPerProject);
 for(const result of results.filter(result=>result.status==='rejected')){assert.equal(result.reason.code,'FRAME_QUEUE_FULL');assert.equal(result.reason.details.frameOutcome.status,'not_accepted');}
 assert.equal(count(f.store.db,'frame_tasks'),3);assert.equal(f.calls,0);
});
