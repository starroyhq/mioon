import type {FrameFault} from '../packages/business/src/frames.ts';
interface RecoveryDecodeInput{beforeSpawn(signal:AbortSignal):unknown;signal:AbortSignal;asset:{sha256:string};requestedFrame:number}
type RecoveryDecoder=(input:RecoveryDecodeInput)=>Promise<{bytes:Buffer;provenance:ReturnType<typeof provenance>}>;
import type {DatabaseSync} from 'node:sqlite';
import type {TypedCall} from './helpers/strict-service-responses.ts';
import type {TypedFrameServices} from './helpers/strict-timeline-audio-factory-types.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,unlinkSync,existsSync,symlinkSync,chmodSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createFrameServices,safeFrameServiceError, type FrameStore} from '../packages/business/src/frames.ts';
import {AppError} from '@mioon/contracts';
import {spawnMedia,hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.ts';
import {FRAME_PROFILE_ID,FRAME_SELECTION_RULE,FRAME_LIMITS,canonicalFrameInput} from '../packages/contracts/src/frame-extraction.ts';
import {schemaObjects} from './helpers/project-database.ts';
import type { BinaryLike } from 'crypto';

const digest=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex'),error=(code: string)=>(cause: { code: string; })=>cause.code===code&&!JSON.stringify(cause).includes('PRIVATE_SENTINEL');
const deferred=<T = unknown>()=>{let resolve!: (value?: T | PromiseLike<T>) => void;const promise=new Promise<T>(yes=>{resolve=(yes as (value?: T | PromiseLike<T>) => void);});return {promise,resolve};};
function png(){
 const chunk=(name: string,data: Buffer<ArrayBuffer>)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);let crc=0xffffffff;for(const byte of out.subarray(4,-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(26))),chunk('IEND',Buffer.alloc(0))]);
}
const bytes=png();
const provenance=(asset: { sha256: unknown; },requestedFrame: number)=>({profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,sourceFrame:requestedFrame,fps:30,sourceHash:asset.sha256,
 probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:4,height:2,rotation:0,sarNumerator:1,sarDenominator:1}});
const count=(db: DatabaseSync,table: string)=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
const rows=(db: DatabaseSync)=>JSON.stringify(schemaObjects(db).filter(({type})=>type==='table').map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
async function until<T>(fn: () => T | Promise<T>,label: unknown){const end=Date.now()+10000;while(Date.now()<end){const result=await fn();if(result)return result;await pause(5);}assert.fail(`Timed out: ${label}`);}
function fixture(t:test.TestContext,{autoRun=true,decode}:{autoRun?:boolean;decode?:RecoveryDecoder}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-frame-recovery-'));let store:TypedStore,services: TypedFrameServices,calls=0,fault:FrameFault=()=>{};
 const decoder=async (input: RecoveryDecodeInput)=>{calls++;if(decode)return decode(input);input.beforeSpawn(input.signal);return {bytes,provenance:provenance(input.asset,input.requestedFrame)};};
 function start(){store=(openStore(root) as TypedStore);services=(createFrameServices(store,({autoRun,decode:decoder,fault:(label:string,context?:Record<string,unknown>)=>fault(label,context)} as unknown as Parameters<typeof createFrameServices>[1])) as TypedFrameServices);}
 start();const project=store!.put('projects',{id:randomUUID(),name:'Frame recovery project'}),sourceBytes=Buffer.from('synthetic private source'),id=randomUUID(),relativePath=`media/${id}.mp4`;
 writeFileSync(path.join(root,relativePath),sourceBytes,{mode:0o600});const asset=store!.put('assets',{id,projectId:project.id,name:'Original.mp4',mimeType:'video/mp4',sha256:digest(sourceBytes),sizeBytes:sourceBytes.length,relativePath,width:4,height:2,duration:1,provenance:'user-import'});
 t.after(async()=>{try{await services.drain();}finally{store.close();rmSync(root,{recursive:true,force:true});}});
 return {root,project,asset,get store(){return store;},get services(){return services;},get calls(){return calls;},setFault(fn: FrameFault){fault=fn;},
  input:()=>({projectId:project.id,sourceAssetId:asset.id,sourceHash:asset.sha256,sourceFrame:0,requestId:randomUUID()}),
  call:((async(op: string|number,input: unknown)=>services.handlers[op](input)) as unknown as TypedCall),get:async (taskId: unknown)=>services.handlers['frame.task.get']({projectId:project.id,taskId}),
  control:(value: { id: unknown; revision: unknown; })=>({projectId:project.id,taskId:value.id,expectedRevision:value.revision,requestId:randomUUID()}),
  async restart(){await services.drain();store.close();start();},async close(){await services.drain();store.close();},start};
}
const state=(f: Awaited<ReturnType<typeof fixture>>,id: unknown,expected: string)=>until(async()=>{const value=await f.get(id);return value.state===expected&&value;},expected);

test('pre-ACK failure rolls back task and request atomically without decoding or staging',async t=>{
 const f=fixture(t),before=rows(f.store.db),input=f.input();f.setFault((label: string)=>{if(label==='before_request_receipt')throw Error('synthetic admission failure');});
 await assert.rejects(f.call('frame.extract',input),error('FRAME_STORAGE_FAILED'));await pause(0);assert.equal(rows(f.store.db),before);assert.equal(f.calls,0);assert.equal(existsSync(path.join(f.root,'frame-staging')),false);
 assert.equal(await f.call('frame.request.get',{projectId:f.project.id,requestId:input.requestId}),null);
});

test('lost ACK lookup and replay never start extraction; restart only marks interrupted',async t=>{
 const f=fixture(t),input=f.input();f.setFault((label: string)=>{if(label==='after_acceptance')throw Error('synthetic lost ACK');});
 await assert.rejects(f.call('frame.extract',input),error('FRAME_STORAGE_FAILED'));f.setFault(()=>{});
 const receipt=await f.call('frame.request.get',{projectId:f.project.id,requestId:input.requestId}),before=rows(f.store.db);assert.equal(receipt!.response.state,'queued');
 assert.deepEqual(await f.call('frame.extract',input),receipt!.response);await pause(10);assert.equal(f.calls,0);assert.equal(rows(f.store.db),before);
 await f.restart();const current=await f.get(receipt!.response.id);assert.equal(current.state,'interrupted');assert.equal(current.started,false);assert.equal(current.revision,2);
 assert.deepEqual(await f.call('frame.extract',input),receipt!.response);assert.equal(f.calls,0);await assert.rejects(f.call('frame.task.recoverResult',f.control(current)),error('FRAME_STATE_CONFLICT'));
 const cancelled=await f.call('frame.task.cancelQueued',f.control(current));assert.equal(cancelled.state,'cancelled_before_start');assert.equal(f.calls,0);
});

for(const phase of ['after_result_manifest','after_result_receipt','after_media_publication','before_result_commit'])test(`${phase} retains exact local result; explicit recovery publishes without re-decoding`,async t=>{
 const f=fixture(t),input=f.input();f.setFault((label: string)=>{if(label===phase)throw Error('PRIVATE_SENTINEL checkpoint failure');});
 const ack=await f.call('frame.extract',input),failed=await state(f,ack.id,'local_result_error');assert.equal(failed.started,true);assert.equal(failed.result,null);assert.equal(f.calls,1);assert.equal(count(f.store.db,'assets'),1);
 const initialReceipt=readFileSync(path.join(f.root,'frame-staging',`${ack.id}.json`),'utf8');assert.ok(!JSON.stringify(failed).includes('PRIVATE_SENTINEL'));f.setFault(()=>{});await f.restart();
 const current=await f.get(ack.id),control=f.control(current),recovery=await f.call('frame.task.recoverResult',control);assert.equal(recovery.state,'persisting');assert.equal(recovery.revision,current.revision+1);
 assert.deepEqual(await f.call('frame.task.recoverResult',control),recovery);const result=await state(f,ack.id,'succeeded');assert.equal(f.calls,1);assert.equal(count(f.store.db,'assets'),2);assert.equal(result.result.assetId,JSON.parse(initialReceipt).assetId);
 assert.deepEqual(readFileSync(path.join(f.root,'media',`${result.result.assetId}.png`)),bytes);assert.equal(readFileSync(path.join(f.root,'frame-staging',`${ack.id}.json`),'utf8'),initialReceipt);
 assert.deepEqual(await f.call('frame.extract',input),ack);assert.deepEqual(await f.call('frame.task.recoverResult',control),recovery);await f.restart();assert.equal((await f.get(ack.id)).state,'succeeded');assert.equal(f.calls,1);
});

for(const damage of ['missing-manifest','partial-png','wrong-png','wrong-manifest','symlink-png','unsafe-directory'])test(`recovery refuses ${damage} without new receipt or decode`,async t=>{
 const f=fixture(t);f.setFault((label: string)=>{if(label==='after_result_manifest')throw Error('synthetic staged result');});
 const ack=await f.call('frame.extract',f.input()),failed=await state(f,ack.id,'local_result_error');f.setFault(()=>{});
 const pngFile=path.join(f.root,'frame-staging',`${ack.id}.png`),manifest=path.join(f.root,'frame-staging',`${ack.id}.json`);
 if(damage==='missing-manifest')unlinkSync(manifest);
 if(damage==='partial-png')writeFileSync(pngFile,bytes.subarray(0,30));
 if(damage==='wrong-png'){const wrong=Buffer.from(bytes);wrong[45]^=1;writeFileSync(pngFile,wrong);}
 if(damage==='wrong-manifest'){const receipt=JSON.parse(readFileSync(manifest,'utf8'));receipt.sourceFrame=1;writeFileSync(manifest,JSON.stringify(receipt));}
 if(damage==='symlink-png'){unlinkSync(pngFile);symlinkSync(path.join(f.root,f.asset.relativePath),pngFile);}
 if(damage==='unsafe-directory')chmodSync(path.dirname(pngFile),0o755);
 const before=rows(f.store.db);await assert.rejects(f.call('frame.task.recoverResult',f.control(failed)),error('FRAME_RESULT_INVALID'));assert.equal(rows(f.store.db),before);assert.equal(f.calls,1);assert.equal(count(f.store.db,'assets'),1);
});

test('result receipt budget retains all sixteen ACKs and fails closed on the next recovery',async t=>{
 const f=fixture(t);f.setFault((label: string)=>{if(label==='after_media_publication')throw Error('synthetic persistent publication failure');});
 const ack=await f.call('frame.extract',f.input());let failed=await state(f,ack.id,'local_result_error');
 for(let i=1;i<FRAME_LIMITS.requestsPerTask;i++){
  const control=f.control(failed),accepted=await f.call('frame.task.recoverResult',control);assert.equal(accepted.state,'persisting');failed=await state(f,ack.id,'local_result_error');assert.deepEqual(await f.call('frame.task.recoverResult',control),accepted);
 }
 assert.equal(count(f.store.db,'frame_requests'),16);const before=rows(f.store.db);await assert.rejects(f.call('frame.task.recoverResult',f.control(failed)),error('FRAME_CAPACITY'));assert.equal(rows(f.store.db),before);assert.equal(f.calls,1);
});

test('stopping aborts and fences a late decoder result; reopening never resumes it',async t=>{
 const entered=deferred(),release=deferred();const f=fixture(t,{decode:async (input: RecoveryDecodeInput)=>{input.beforeSpawn(input.signal);entered.resolve!();await release.promise;return {bytes,provenance:provenance(input.asset,input.requestedFrame)};}});
 const ack=await f.call('frame.extract',f.input());await entered.promise;const draining=f.services.drain();release.resolve!();await draining;
 const current=await f.get(ack.id);assert.equal(current.state,'interrupted');assert.equal(current.started,true);assert.equal(count(f.store.db,'assets'),1);await f.restart();assert.equal((await f.get(ack.id)).state,'interrupted');assert.equal(f.calls,1);
});

for(const phase of ['after_acceptance','after_start_fence','after_result_manifest','after_result_receipt','after_media_publication','before_result_commit'])test(`actual process crash at ${phase} is reconciled without startup decode`,async t=>{
 const f=fixture(t),input=f.input();await f.close();
 const business=fileURLToPath(new URL('../packages/business/src/',import.meta.url));
 const script=`import {openStore} from ${JSON.stringify(path.join(business,'db.ts'))};import {createFrameServices} from ${JSON.stringify(path.join(business,'frames.ts'))};
 const store=openStore(${JSON.stringify(f.root)});const service=createFrameServices(store,{decode:async input=>{input.beforeSpawn(input.signal);return {bytes:Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'),provenance:${JSON.stringify(provenance(f.asset,0))}};},fault:label=>{if(label===${JSON.stringify(phase)})process.exit(86);}});await service.handlers['frame.extract'](${JSON.stringify(input)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.setEncoding('utf8').on('data',value=>{stderr+=value;});const [exitCode]=await once(child,'close');assert.equal(exitCode,86,stderr);f.start();
 const receipt=await f.call('frame.request.get',{projectId:f.project.id,requestId:input.requestId}),current=await f.get(receipt!.response.id);assert.equal(current.state,'interrupted');assert.equal(current.started,phase!=='after_acceptance');assert.equal(f.calls,0);assert.equal(count(f.store.db,'assets'),1);
 assert.deepEqual(await f.call('frame.extract',input),receipt!.response);assert.equal(f.calls,0);
 if(phase==='after_acceptance'){await f.call('frame.task.cancelQueued',f.control(current));return;}
 if(phase==='after_start_fence'){await assert.rejects(f.call('frame.task.recoverResult',f.control(current)),error('FRAME_RESULT_INVALID'));return;}
 await f.call('frame.task.recoverResult',f.control(current));await state(f,current.id,'succeeded');assert.equal(f.calls,0);assert.equal(count(f.store.db,'assets'),2);
});

test('unconfirmed exact child close retains the active slot and bounded shutdown reports failure',async t=>{
 let child!:ReturnType<typeof spawnMedia>,realKill!:ReturnType<typeof spawnMedia>["kill"],attemptSignal!:AbortSignal;const entered=deferred();let invocations=0;
 const f=fixture(t,{decode:async (input: RecoveryDecodeInput)=>{
  invocations++;if(invocations>1){input.beforeSpawn(input.signal);return {bytes,provenance:provenance(input.asset,input.requestedFrame)};}
  attemptSignal=new AbortController().signal;input.beforeSpawn(attemptSignal);
  child=spawnMedia(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'},{kind:'frame-owned-test',signal:attemptSignal});realKill=child.kill.bind(child);await once(child,'spawn');child.kill=()=>true;entered.resolve!();
  throw Object.assign(Error('synthetic unconfirmed attempt'),{terminationUnconfirmed:true,code:'MEDIA_TERMINATION_UNCONFIRMED'});
 }});
 t.after(async()=>{if(child){child.kill=realKill;realKill('SIGKILL');await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode)resolve();else child.once('close',resolve);});}});
 const first=await f.call('frame.extract',f.input());await entered.promise;await state(f,first.id,'interrupted');const second=await f.call('frame.extract',f.input());await pause(30);assert.equal(f.calls,1);assert.equal((await f.get(second.id)).state,'queued');
 await assert.rejects(f.services.drain(),cause=>['MEDIA_TERMINATION_UNCONFIRMED','FRAME_STOP_TIMEOUT'].includes((cause as Failure).code));assert.equal(hasUnconfirmedMediaProcesses({signal:attemptSignal}),true);assert.equal(f.calls,1);
 child.kill=realKill;const close=once(child,'close');realKill('SIGKILL');await close;await pause(10);assert.equal(hasUnconfirmedMediaProcesses({signal:attemptSignal}),false);
 // A later drain can establish safety only after this exact child closed.
 await f.services.drain();
});


test('fresh missing checkpoint rejection carries only exact authoritative not-accepted proof',async t=>{
 const f=fixture(t);f.setFault((label: string)=>{if(label==='after_result_manifest')throw Error('synthetic staged failure');});
 const ack=await f.call('frame.extract',f.input()),failed=await state(f,ack.id,'local_result_error');f.setFault(()=>{});unlinkSync(path.join(f.root,'frame-staging',`${ack.id}.json`));
 const input=f.control(failed),before=rows(f.store.db),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
 await assert.rejects(f.call('frame.task.recoverResult',input),cause=>{
  assert.equal((cause as Failure).code,'FRAME_RESULT_INVALID');const proof={status:'not_accepted',projectId:f.project.id,operation:'frame.task.recoverResult',requestId:input.requestId,inputHash:digest(canonicalFrameInput(input))};
  assert.deepEqual((cause as Failure).details,{frameOutcome:proof});assert.deepEqual(safeFrameServiceError(cause).details,{frameOutcome:proof});return true;
 });
 assert.equal(rows(f.store.db),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.equal(f.calls,1);
});

test('committed lost ACK, foreign/reassigned scope and forged errors never prove not-accepted',async t=>{
 const f=fixture(t),input=f.input();f.setFault((label: string)=>{if(label==='after_acceptance')throw new AppError('FRAME_RESULT_INVALID','PRIVATE_SENTINEL postcommit fault',409,{frameOutcome:{status:'not_accepted',projectId:input.projectId,operation:'frame.extract',requestId:input.requestId,inputHash:digest(canonicalFrameInput(input))},unsafePath:'/PRIVATE_SENTINEL'});});
 await assert.rejects(f.call('frame.extract',input),cause=>{assert.equal((cause as Failure).code,'FRAME_RESULT_INVALID');assert.doesNotMatch(JSON.stringify(cause),/PRIVATE_SENTINEL|unsafePath/);assert.equal((cause as Failure).details?.frameOutcome,undefined);assert.equal(safeFrameServiceError(cause).details,undefined);return true;});f.setFault(()=>{});
 const receipt=await f.call('frame.request.get',{projectId:f.project.id,requestId:input.requestId}),ack=receipt!.response;
 const other=f.store.put('projects',{id:randomUUID(),name:'Foreign scope'});
 await assert.rejects(f.call('frame.task.recoverResult',{...f.control(ack),projectId:other.id}),cause=>{assert.equal((cause as Failure).details?.frameOutcome,undefined);return true;});
 f.store.put('assets',{...f.asset,projectId:other.id});
 await assert.rejects(f.call('frame.task.cancelQueued',f.control(ack)),cause=>{assert.equal((cause as Failure).details?.frameOutcome,undefined);return true;});
 const forged=new AppError('FRAME_RESULT_INVALID','Synthetic forged label',409);forged.details={frameOutcome:{status:'not_accepted',projectId:f.project.id,operation:'frame.extract',requestId:input.requestId,inputHash:digest(canonicalFrameInput(input))}};
 assert.equal(safeFrameServiceError(forged).details,undefined);assert.equal(f.calls,0);
});
