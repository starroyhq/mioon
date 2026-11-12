
import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import type {OrdinaryLocalDelivery,OrdinaryDeliveryEnvelope} from './helpers/strict-timeline-audio-draft-types.ts';
import type {LocalDeliveryOptions,LocalDeliveryGuards} from '../packages/business/src/local-delivery.ts';
import type {LocalDeliveryPrepare,LocalDeliveryRenderInput} from '@mioon/contracts/local-delivery';
import type {OutputLocale} from '../packages/contracts/src/output-locale.ts';
import {outputLocaleFor} from '../packages/business/src/output-asset-names.ts';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,symlinkSync,linkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {createTimelineRecoveryBoundary,readTimelineReceipt, type TimelineRecoveryInput} from '../packages/business/src/timeline-recovery.ts';
import {createLocalDelivery,LOCAL_DELIVERY_FILENAME} from '@mioon/business/local-delivery';
import {LOCAL_DELIVERY_LIMITS,createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import {schemas,isTimelineMutationResponse,hasRequestNotAppliedProof,publicValue,AppError} from '@mioon/contracts';

import {schemaObjects,withoutForeignKeys} from './helpers/project-database.ts';
import {writeStubMediaFixture} from './helpers/media-reference-fixtures.ts';
const contract=createLocalDeliverySchemas(value=>schemas['timeline.render'].safeParse(value).success);
const code=(value: string)=>(error: { code: string; message: string|string[]; })=>error.code===value&&!error.message.includes('PRIVATE');
const authority=(value: Pick<OrdinaryDeliveryEnvelope, 'workspaceScope'|'instanceId'|'projectId'>)=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId});
const action=(value:OrdinaryDeliveryEnvelope)=>({...authority(value),intentId:value.intent!.intentId,expectedIntentRevision:value.intentRevision});
const deferred=<T=void>()=>Promise.withResolvers<T>();
async function fixture(t: test.TestContext,{mimeType='image/png'}={}){
  const root=mkdtempSync(path.join(tmpdir(),'mioon-local-delivery-'));const open=openStore;let store=(open(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices),delivery:OrdinaryLocalDelivery,fault:(point:string)=>void=()=>{},render:LocalDeliveryGuards['render'],extraGuards:Partial<LocalDeliveryGuards>={};let calls: (unknown)[]=[];
  const project=await services.call('project.create',{name:'Local delivery'}),assetId=randomUUID();
  const media=writeStubMediaFixture(root,assetId,mimeType);
  store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType,duration:mimeType.startsWith('video/')?3:0,width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',...media,createdAt:new Date().toISOString()});
  const asset=store.get('assets',assetId);assert.ok(asset);
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  const originalRender=(input: unknown, outputLocale?: OutputLocale)=>(services as unknown as ReturnType<typeof createServices>).call('timeline.render',input,{outputLocale});render=originalRender;
  const guards=()=>({ownsLock:()=>ownsStoreLock(store),
    readTimeline:(id: unknown)=>createTimelineRecoveryBoundary(store.db,({projectId:id} as unknown as Parameters<typeof createTimelineRecoveryBoundary>[1])).read({sourceSemantics:false}),
    isRenderInput:(value: unknown)=>schemas['timeline.render'].safeParse(value).success,
    isRenderResponse:(input: unknown,value: unknown)=>isTimelineMutationResponse('timeline.render',input,value),
    isNotApplied:(input: unknown,error: unknown)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
    readReceipt:(input: TimelineRecoveryInput)=>{const saved=readTimelineReceipt(store.db,input,'timeline.render');if(!saved)return null;if(saved.requestHash!==hash({operation:'timeline.render',input}))throw Error('PRIVATE bad hash');return publicValue(createTimelineRecoveryBoundary(store.db,input).replay('timeline.render',saved.response!));},
    render:(input:LocalDeliveryRenderInput,outputLocale?:OutputLocale)=>{calls.push(structuredClone(input));return render(input,outputLocale);},...extraGuards});
  const localRoot=()=>isProjectStore(store)?store.localDir:root;
  const kernel=()=>{assert.ok(isProjectStore(store));return store;};
  const start=(options:Partial<LocalDeliveryOptions>={})=>delivery=(createLocalDelivery({store:kernel(),guards:guards(),fault:(point:string)=>fault(point),...options})) as OrdinaryLocalDelivery;start();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const get=()=>delivery.get({projectId:project.id});
  const put=(value=get(),name='Draft title')=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,raw:{deliveryName:name}});
  const prepare=(value=get(),patch:Record<string,unknown>={}):LocalDeliveryPrepare&{input:LocalDeliveryRenderInput}=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,
    draft:value.draft?{draftId:value.draft.draftId,revision:value.draftRevision,raw:value.draft.raw}:null,
    input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(value.draft?.raw.deliveryName?{deliveryName:value.draft.raw.deliveryName}:{})},...patch});
  return {root:localRoot(),file:path.join(localRoot(),LOCAL_DELIVERY_FILENAME),project,asset,timeline,get,put,prepare,start,originalRender,get store(){return store;},get services(){return services;},get delivery(){return delivery;},get calls(){return calls;},
    setFault(fn: (point:string)=>void){fault=fn;},setRender(fn: (input:LocalDeliveryRenderInput)=>Promise<unknown>){render=fn;},setExportInspect(inspect: { (): Promise<{ status: string; code: string; }>; (): Promise<{ status: string; code: string; }>; (): Promise<{ status: string; code: string; }>; }){services=(createServices(store,new Map(),{exportOptions:{inspect}}) as TypedServices);},setGuards(value: Partial<Pick<import('../packages/business/src/local-delivery.ts').LocalDeliveryGuards,'ownsLock'>>){extraGuards=value;start();},
    restart(){store.close();store=(open(root) as TypedStore);services=(createServices(store,new Map()) as TypedServices);start();},
    draftState(){return JSON.stringify(store.db.prepare('SELECT * FROM local_delivery_drafts ORDER BY ordinal').all());},
    draftRows(){return store.db.prepare('SELECT data FROM local_delivery_drafts ORDER BY ordinal').all().map(row=>JSON.parse(String(row.data))) as {intent:{outcome:{status:string}};draftRevision:number}[];},
    snapshot(){return JSON.stringify(schemaObjects(store.db).map(({name,sql})=>({name,sql})))+'\n'+JSON.stringify(['projects','assets','timelines','timeline_requests','timeline_history','edit_tasks','exports'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
    counts():number[]{return ['exports','timeline_requests','edit_tasks'].map(table=>store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n as number);},
  };
}

test('GET and draft-only writes are bounded, private, noncreating reads with unchanged project/business rows and schemas',async t=>{
  const f=await fixture(t),before=f.snapshot(),empty=f.get();assert.ok(contract.envelope.safeParse(empty).success);assert.equal(existsSync(f.file),false);assert.equal(empty.draftTargetStatus,'unset');
  const input=f.put(empty,' \nraw\u0000title '),saved=f.delivery.put(input);assert.equal(saved.draft!.raw.deliveryName,input.raw.deliveryName);assert.equal(saved.draftRevision,1);assert.equal(existsSync(f.file),false);assert.equal(f.draftRows()[0].draftRevision,1);assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
  assert.deepEqual(f.delivery.put(input),saved);const next=f.delivery.put(f.put(saved,'Second'));assert.throws(()=>f.delivery.put(input),code('LOCAL_DELIVERY_CONFLICT'));
  const remove={...authority(next),expectedDraftRevision:next.draftRevision,draftId:next.draft!.draftId};assert.equal(f.delivery.discard(remove).draft,null);assert.equal(f.get().draftRevision,3);assert.equal(f.snapshot(),before);
});

test('immutable preparation precedes dispatch; one pending reservation rejects competing windows',async t=>{
  const f=await fixture(t),draft=f.delivery.put(f.put()),before=f.snapshot(),input=f.prepare(draft),prepared=f.delivery.prepare(input);
  assert.equal(prepared.intent!.outcome.status,'pending');assert.deepEqual(prepared.intent!.input,input.input);assert.equal(prepared.intentRevision,1);assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);
  assert.deepEqual(f.delivery.prepare(input),prepared);assert.throws(()=>f.delivery.prepare(f.prepare(prepared)),code('LOCAL_DELIVERY_CONFLICT'));
  assert.throws(()=>f.delivery.prepare({...input,intentId:randomUUID()}),code('LOCAL_DELIVERY_CONFLICT'));assert.ok(contract.envelope.safeParse(f.get()).success);
});

test('actual shared render accepts once, atomically clears only its captured draft and retains exact original receipt',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved)),inputBytes=JSON.stringify(prepared.intent!.input),before=f.counts();
  const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.equal(result.envelope.draft,null);assert.equal(result.envelope.draftRevision,saved.draftRevision+1);assert.equal(result.envelope.intentRevision,2);assert.ok(contract.execution.safeParse(result).success);
  assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.calls[0]),inputBytes);assert.equal(f.counts()[0],before[0]!+1);assert.equal(f.counts()[1],before[1]!+1);assert.equal(f.counts()[2],before[2]);
  const receipt=readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response;assert.equal(JSON.parse(receipt!).snapshot.deliveryName,'Draft title');
  assert.deepEqual(await f.delivery.recover(action(result.envelope)),result);assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response,receipt);
  assert.throws(()=>f.delivery.execute(action(prepared)),code('LOCAL_DELIVERY_CONFLICT'));
});

test('a failed delivery keeps its original receipt while a fresh export of the same timeline succeeds',async t=>{
  const f=await fixture(t);
  const store=f.store;
  assert.ok(isProjectStore(store));
  const projectId=f.project.id,expectedRevision=f.timeline.revision;
  async function submitCheckedExport(){
    const report=await f.services.call('timeline.export.preflight',{projectId,expectedRevision});
    assert.equal(report.status,'ready');
    assert.ok(report.snapshotHash);
    const intent=f.prepare();
    const input={...intent.input,preflightSnapshotHash:report.snapshotHash};
    const prepared=f.delivery.prepare({...intent,input});
    const result=await f.delivery.execute(action(prepared));
    assert.equal(result.envelope.intent?.outcome.status,'accepted');
    assert.ok(result.response);
    return {input,exportId:result.response.id};
  }
  async function renderQueuedExport(){
    const worker=startWorker(store,f.services,new Map());
    try {await worker.tick();} finally {await worker.stop();}
  }

  const first=await submitCheckedExport();
  const originalReceipt=readTimelineReceipt(store.db,first.input,'timeline.render')?.response;
  assert.ok(originalReceipt);
  const removeFailure=setProjectOutputPublicationTestHooks(store,{fault(point,proof){
    if(point==='after_intent'&&proof.owner.kind==='export'&&proof.owner.id===first.exportId) throw new AppError('INVALID_MEDIA','Injected publication failure',409);
  }});
  try {await renderQueuedExport();} finally {removeFailure();}
  const failed=await f.services.call('export.get',{exportId:first.exportId});
  assert.equal(failed.status,'failed');
  assert.equal(failed.error?.code,'INVALID_MEDIA');
  assert.equal(failed.error?.retryable,true);
  assert.equal(failed.assetId,null);

  const second=await submitCheckedExport();
  assert.notEqual(second.input.requestId,first.input.requestId);
  assert.notEqual(second.exportId,first.exportId);
  assert.equal(second.input.expectedRevision,first.input.expectedRevision);
  assert.equal(second.input.preflightSnapshotHash,first.input.preflightSnapshotHash);
  await renderQueuedExport();
  const completed=await f.services.call('export.get',{exportId:second.exportId});
  assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));
  const output=await f.services.call('export.output.get',{projectId,exportId:second.exportId});
  assert.equal(output.assetId,completed.assetId);
  assert.ok(output.sizeBytes>0);
  assert.deepEqual(await f.services.call('export.get',{exportId:first.exportId}),failed);
  assert.equal(readTimelineReceipt(store.db,first.input,'timeline.render')?.response,originalReceipt);
  assert.deepEqual(f.calls,[first.input,second.input]);
});

test('overlapping execute/recover shares one promise while a newer title survives the exact accepted callback',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved)),gate=deferred();f.setRender(async (input: unknown)=>{await gate.promise;return f.originalRender(input);});
  const first=f.delivery.execute(action(prepared)),second=f.delivery.recover(action(prepared));assert.equal(first,second);await Promise.resolve();assert.equal(f.calls.length,1);
  const newer=f.delivery.put(f.put(f.get(),'Newer title'));gate.resolve();const result=await first;assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.deepEqual(result.envelope.draft,newer.draft);assert.equal(result.envelope.draftRevision,newer.draftRevision);assert.equal(f.calls.length,1);
});

test('lost response after actual shared acceptance reconciles from original receipt without another render',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.setRender(async (input: unknown)=>{await f.originalRender(input);throw Error('PRIVATE lost response');});
  const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.equal(Object.hasOwn(result.response!.snapshot,'deliveryName'),false);assert.equal(Object.hasOwn(result.response!.snapshot,'delivery'),false);assert.equal(Object.hasOwn(f.calls[0] as object,'exportSettings'),false);
  f.restart();const found=f.get(),bytes=readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response;assert.equal(found.intent!.outcome.status,'accepted');assert.equal((await f.delivery.recover(action(found))).response!.id,result.response!.id);assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response,bytes);
});

test('ambiguous transport remains pending through reload and only explicit recover executes original input',async t=>{
  const f=await fixture(t),preparation=f.prepare(f.get(),{outputLocale:'ja'}),prepared=f.delivery.prepare(preparation);f.setRender(async()=>{throw Error('PRIVATE before service');});
  assert.equal(prepared.intent!.outputLocale,'ja');
  assert.throws(()=>f.delivery.prepare({...preparation,outputLocale:'en'}),code('LOCAL_DELIVERY_CONFLICT'));
  const first=await f.delivery.execute(action(prepared));assert.equal(first.envelope.intent!.outcome.status,'pending');assert.equal(first.response,null);assert.equal(f.calls.length,1);f.restart();assert.equal(f.get().intent!.outcome.status,'pending');assert.equal(f.calls.length,1);
  f.setRender(f.originalRender);const result=await f.delivery.recover(action(f.get()));assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.deepEqual(f.calls[0],f.calls[1]);
  assert.deepEqual(f.calls[1],preparation.input);
  assert.equal(outputLocaleFor(f.store.db,String(result.response!.id)),'ja');
});

test('actual shared revision rejection is terminal, never retried after timeline restoration, and permits exact new-intent CAS',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved));
  f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});const rejected=await f.delivery.execute(action(prepared));assert.equal(rejected.envelope.intent!.outcome.status,'not_applied');assert.equal(rejected.envelope.intent!.outcome.code,'REVISION_CONFLICT');assert.deepEqual(rejected.envelope.draft,saved.draft);
  f.store.put('timelines',f.timeline);const oldCalls=f.calls.length;assert.equal((await f.delivery.recover(action(f.get()))).envelope.intent!.outcome.status,'not_applied');assert.equal(f.calls.length,oldCalls);
  const next=f.delivery.prepare(f.prepare(f.get()));assert.notEqual(next.intent!.intentId,prepared.intent!.intentId);assert.throws(()=>f.delivery.recover(action(rejected.envelope)),code('LOCAL_DELIVERY_CONFLICT'));
});

for(const point of ['beforePersist','beforeCommit','afterCommit','afterPersist','beforeConfirm','afterConfirm'])test(`prepare failure at ${point} produces zero render calls`,async t=>{
  const f=await fixture(t),input=f.prepare(),before=f.snapshot();f.setFault((label: string)=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.delivery.prepare(input),code(['beforePersist','beforeCommit'].includes(point)?'LOCAL_DELIVERY_STORAGE_UNAVAILABLE':'LOCAL_DELIVERY_SAVE_UNCERTAIN'));assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);f.setFault(()=>{});
  if(f.get().intent){assert.equal(f.get().intent!.outcome.status,'pending');assert.equal(f.calls.length,0);}
});

for(const point of ['beforeOutcomePersist','beforePersist','beforeCommit','afterCommit','afterPersist','beforeConfirm','afterConfirm'])test(`outcome failure at ${point} never permits a fresh intent; explicit recovery uses original receipt`,async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());let outcome=false;
  f.setFault((label: string)=>{if(label==='beforeOutcomePersist')outcome=true;if(outcome&&label===point)throw Error('PRIVATE outcome fault');});
  await assert.rejects(f.delivery.execute(action(prepared)));assert.equal(f.calls.length,1);f.setFault(()=>{});const found=f.get();assert.equal(found.intent!.outcome.status,'pending');assert.throws(()=>f.delivery.prepare(f.prepare(found)),code('LOCAL_DELIVERY_CONFLICT'));
  const result=await f.delivery.recover(action(found));assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.equal(f.calls.length,1);
});

test('postcommit not-applied uncertainty rechecks its terminal marker without ever calling render again',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});let outcome=false;
  f.setFault((point: string)=>{if(point==='beforeOutcomePersist')outcome=true;if(outcome&&point==='afterPersist')throw Error('PRIVATE fault');});await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});
  assert.equal(f.get().intent!.outcome.status,'pending');f.store.put('timelines',f.timeline);const result=await f.delivery.recover(action(f.get()));assert.equal(result.envelope.intent!.outcome.status,'not_applied');assert.equal(f.calls.length,1);
});

test('foreign or malformed proof and forged acknowledgement cannot release pending reservation',async t=>{
  for(const mode of ['wrong-request','wrong-project','unauthorized','fake-ack']){
    const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());
    f.setRender(async (input: { requestId: unknown; projectId: unknown; })=>{if(mode==='fake-ack')return {id:randomUUID(),status:'queued'};throw new AppError('REVISION_CONFLICT','PRIVATE',mode==='unauthorized'?403:409,{mutationOutcome:'not_applied',requestId:mode==='wrong-request'?randomUUID():input.requestId,projectId:mode==='wrong-project'?randomUUID():input.projectId,operation:'timeline.render'});});
    const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent!.outcome.status,'pending',mode);assert.equal(result.response,null);assert.equal(f.counts()[0],0);
  }
});

test('late original timeline replacement, source-owner transfer and lease loss cannot save terminal outcome',async t=>{
  for(const mode of ['timeline','source','lease']){
    const f=await fixture(t),prepared=f.delivery.prepare(f.prepare()),gate=deferred(),entered=deferred();f.setRender(async (input: unknown)=>{const accepted=await f.originalRender(input);entered.resolve();await gate.promise;return accepted;});
    const pending=f.delivery.execute(action(prepared));await entered.promise;
    if(mode==='timeline'){const changed={...f.timeline,id:randomUUID()};f.store.db.prepare('UPDATE timelines SET id=?,data=? WHERE id=?').run(changed.id,JSON.stringify(changed),f.timeline.id);}
    if(mode==='source')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(randomUUID(),f.asset.id));
    if(mode==='lease')f.store.close();
    gate.resolve();await assert.rejects(pending);if(mode==='lease')f.restart();assert.equal(f.draftRows()[0].intent.outcome.status,'pending');
  }
});

test('reentrant before-persist edit trips full-file CAS and preserves the newer draft',async t=>{
  const f=await fixture(t),initial=f.get(),input=f.put(initial,'Outer'),inner=f.put(initial,'Inner');let entered=false;
  f.setFault((point: string)=>{if(point==='beforePersist'&&!entered){entered=true;f.delivery.put(inner);}});
  assert.throws(()=>f.delivery.put(input),code('LOCAL_DELIVERY_CONFLICT'));f.setFault(()=>{});assert.equal(f.get().draft!.raw.deliveryName,'Inner');
});

test('restart, copied SQL scope and strict inputs fail closed while retired JSON is never read or repaired',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),old=f.put(saved);f.restart();assert.notEqual(f.get().instanceId,saved.instanceId);assert.throws(()=>f.delivery.put(old),code('LOCAL_DELIVERY_STALE_INSTANCE'));
  const bytes=f.draftState();f.start({channel:'production'});assert.throws(f.get,code('LOCAL_DELIVERY_SCOPE_MISMATCH'));assert.equal(f.draftState(),bytes);f.start();
  const foreign=await fixture(t);foreign.store.db.prepare('INSERT INTO local_draft_states(kind,workspaceScope) VALUES(?,?)').run('delivery',saved.workspaceScope);assert.throws(foreign.get,code('LOCAL_DELIVERY_SCOPE_MISMATCH'));assert.equal(foreign.store.db.prepare('SELECT count(*) n FROM local_delivery_drafts').get()!.n,0);
  let touched=0;const input=f.put();const getter={...input};Object.defineProperty(getter,'raw',{enumerable:true,get(){touched++;return input.raw;}});
  for(const bad of [getter,new Proxy(input,{}),{...input,path:'/PRIVATE'},{...input,raw:{deliveryName:'x'.repeat(513)}},{...f.prepare(),operation:'project.delete'}])assert.throws(()=>f.delivery.put(bad),code('LOCAL_DELIVERY_VALIDATION'));assert.equal(touched,0);assert.equal(f.draftState(),bytes);
  for(const value of ['{','null',JSON.stringify({version:2,workspaceScope:saved.workspaceScope,entries:[]}),Buffer.from([0xff]),'x'.repeat(LOCAL_DELIVERY_LIMITS.envelopeBytes+1)]){writeFileSync(f.file,value);assert.deepEqual(f.get().draft,saved.draft);assert.deepEqual(readFileSync(f.file),Buffer.from(value));assert.equal(f.draftState(),bytes);}
  rmSync(f.file);const target=path.join(f.root,'private-target');writeFileSync(target,'PRIVATE',{mode:0o600});symlinkSync(target,f.file);assert.deepEqual(f.get().draft,saved.draft);assert.equal(readFileSync(target,'utf8'),'PRIVATE');rmSync(f.file);linkSync(target,f.file);assert.deepEqual(f.get().draft,saved.draft);assert.equal(readFileSync(target,'utf8'),'PRIVATE');rmSync(f.file);writeFileSync(f.file,'retired',{mode:0o644});assert.deepEqual(f.get().draft,saved.draft);assert.equal(statSync(f.file).mode&0o777,0o644);assert.equal(f.draftState(),bytes);
});



test('historical receipt recovery survives later source duration metadata without changing the original receipt',async t=>{
  const f=await fixture(t,{mimeType:'video/mp4'});f.store.put('assets',{...f.asset,mimeType:'video/mp4',duration:3,hasAudio:true});
  const prepared=f.delivery.prepare(f.prepare());f.setFault((point: string)=>{if(point==='afterDispatch')throw Error('PRIVATE dropped response');});
  await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});
  const bytes=readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response;
  f.store.put('assets',{...f.asset,mimeType:'video/mp4',duration:0.1,hasAudio:false});
  const found=f.get();assert.equal(found.intent!.outcome.status,'pending');const result=await f.delivery.recover(action(found));assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent!.input,'timeline.render')!.response,bytes);
});

test('a failed pre-dispatch fence makes zero service calls and keeps the reservation pending',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.setFault((point: string)=>{if(point==='beforeDispatch')throw Error('PRIVATE stop');});
  await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});assert.equal(f.calls.length,0);assert.equal(f.get().intent!.outcome.status,'pending');
});

test('late abort cannot publish a terminal draft row',async t=>{
  for(const mode of ['abort']){
    const f=await fixture(t),controller=new AbortController();
    f.start({signal:controller.signal});
    const prepared=f.delivery.prepare(f.prepare()),gate=deferred(),entered=deferred();f.setRender(async (input: unknown)=>{const result=await f.originalRender(input);entered.resolve();await gate.promise;return result;});
    const pending=f.delivery.execute(action(prepared));await entered.promise;controller.abort();gate.resolve();await assert.rejects(pending);
    assert.equal(f.draftRows()[0].intent.outcome.status,'pending');
  }
});

test('single-project SQL rejects foreign slots and retained tombstones never reset CAS or acknowledge wrong deletion identity',async t=>{
  const f=await fixture(t),empty=f.get(),saved=f.delivery.put(f.put(empty)),remove={...authority(saved),expectedDraftRevision:saved.draftRevision,draftId:saved.draft!.draftId};f.delivery.discard(remove);
  const bytes=f.draftState(),foreign={projectId:randomUUID(),draftRevision:1,draft:null,intentRevision:0,intent:null};
  assert.throws(()=>f.store.db.prepare('INSERT INTO local_delivery_drafts(projectId,draftRevision,intentRevision,intentId,requestId,intentStatus,ordinal,data) VALUES(?,1,0,NULL,NULL,NULL,2,?)').run(foreign.projectId,JSON.stringify(foreign)),{message:'LOCAL_DRAFT_SQL_PROJECT'});
  assert.equal(f.draftState(),bytes);assert.equal(f.store.db.prepare('SELECT count(*) n FROM local_delivery_drafts').get()!.n,1);assert.equal(f.get().draftRevision,2);
  assert.throws(()=>f.delivery.discard({...remove,draftId:randomUUID()}),code('LOCAL_DELIVERY_CONFLICT'));assert.throws(()=>f.delivery.discard(remove),code('LOCAL_DELIVERY_CONFLICT'));assert.equal(f.get().draft,null);
  const newer=f.delivery.put(f.put(f.get()));assert.equal(newer.draftRevision,3);assert.equal(f.store.db.prepare('SELECT count(*) n FROM local_delivery_drafts').get()!.n,1);assert.equal(existsSync(f.file),false);
});


test('actual shared asynchronous capability admission is single-flight and preserves exact optional settings',async t=>{
  const f=await fixture(t),gate=deferred(),entered=deferred();let checks=0;
  f.setExportInspect(async()=>{checks++;entered.resolve();await gate.promise;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};});
  const settings={profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'bitrate',targetKbps:4000}},input=f.prepare();input.input.exportSettings=settings as NonNullable<LocalDeliveryRenderInput['exportSettings']>;
  const prepared=f.delivery.prepare(input),first=f.delivery.execute(action(prepared));await entered.promise;
  const second=f.delivery.recover(action(prepared));assert.equal(first,second);assert.equal(checks,1);assert.equal(f.calls.length,1);assert.equal(f.get().intent!.outcome.status,'pending');
  gate.resolve();const result=await first;assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.deepEqual(result.response!.snapshot.delivery!.exportSettings,settings);assert.deepEqual(f.calls[0],input.input);assert.equal(Object.hasOwn(f.calls[0],'preflightSnapshotHash'),false);assert.equal(f.counts()[0],1);
});

test('actual shared capability rejection is a fixed terminal proof and explicit recovery does not retry it',async t=>{
  const f=await fixture(t);let checks=0;f.setExportInspect(async()=>{checks++;return {status:'incomplete',code:'EXPORT_CAPABILITY_BUSY'};});
  const input=f.prepare();input.input.exportSettings={profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
  const prepared=f.delivery.prepare(input),result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent!.outcome.status,'not_applied');assert.equal(result.envelope.intent!.outcome.code,'EXPORT_CAPABILITY_BUSY');assert.equal(checks,1);assert.equal(f.counts()[0],0);
  f.setExportInspect(async()=>{checks++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};});assert.equal((await f.delivery.recover(action(f.get()))).envelope.intent!.outcome.status,'not_applied');assert.equal(checks,1);assert.equal(f.calls.length,1);
});


test('drain seals admission and waits through the full accepted outcome and finally',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare()),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  f.setRender(async (input)=>{entered.resolve();await gate.promise;return f.originalRender(input);});
  const flight=f.delivery.execute(action(prepared));await entered.promise;assert.equal(f.delivery.isBusy(),true);
  let completed=false;const draining=f.delivery.drain();assert.equal(f.delivery.drain(),draining);void draining.then(()=>{completed=true;});await Promise.resolve();assert.equal(completed,false);
  assert.throws(f.get,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));gate.resolve();const result=await flight;await draining;
  assert.equal(result.envelope.intent!.outcome.status,'accepted');assert.equal(f.delivery.isBusy(),false);assert.equal(completed,true);assert.equal(f.store.db.isOpen,true);assert.equal(f.calls.length,1);
  f.restart();assert.equal(f.get().intent!.outcome.status,'accepted');assert.equal(f.calls.length,1);
});

test('drain joins an aborted in-flight callback and never dispatches a persisted idle pending intent',async t=>{
  const f=await fixture(t),controller=new AbortController();f.start({signal:controller.signal});const prepared=f.delivery.prepare(f.prepare()),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  f.setRender(async (input)=>{const result=await f.originalRender(input);entered.resolve();await gate.promise;return result;});const flight=f.delivery.execute(action(prepared));const rejected=assert.rejects(flight,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));await entered.promise;controller.abort();const draining=f.delivery.drain();gate.resolve();await rejected;await draining;
  assert.equal(f.delivery.isBusy(),false);assert.equal(f.store.db.isOpen,true);assert.equal(f.draftRows()[0].intent.outcome.status,'pending');assert.equal(f.calls.length,1);
  f.restart();assert.equal(f.delivery.isBusy(),false);assert.equal(f.get().intent!.outcome.status,'pending');await f.delivery.drain();assert.equal(f.calls.length,1);
});

test('Windows mutations reject before any SQL effect or business dispatch',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare()),put=f.put(f.get()),before=f.draftState(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n;
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
  try{Object.defineProperty(process,'platform',{value:'win32'});
    for(const invoke of [()=>f.delivery.put(put),()=>f.delivery.discard({...authority(prepared),expectedDraftRevision:1,draftId:randomUUID()}),()=>f.delivery.prepare({}),()=>f.delivery.execute(action(prepared)),()=>f.delivery.recover(action(prepared)),()=>f.delivery.removeProject(f.project.id)])assert.throws(invoke,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));
    assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(f.draftState(),before);assert.equal(f.calls.length,0);
  }finally{Object.defineProperty(process,'platform',platform);}
  assert.equal(f.get().intent!.outcome.status,'pending');
});


test('owner revocation inside the SQL transaction rolls back the first slot and scope state',async t=>{
  const f=await fixture(t);let held=true;f.setGuards({ownsLock:()=>held});const input=f.put(),before=f.snapshot(),drafts=f.draftState();
  f.setFault(point=>{if(point==='beforeCommit')held=false;});
  assert.throws(()=>f.delivery.put(input),code('LOCAL_DELIVERY_OWNER_REQUIRED'));assert.equal(f.draftState(),drafts);assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);assert.equal(existsSync(f.file),false);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM local_draft_states WHERE kind='delivery'").get()!.n,0);
  held=true;f.setFault(()=>{});assert.equal(f.delivery.put(input).draftRevision,1);assert.equal(f.get().draft!.draftId,input.draftId);
});


test('before-persist business changes with unchanged draft rows reject new drafts and prepare by exact conflict',async t=>{
  for(const operation of ['put','prepare']){
    const f=await fixture(t);if(operation==='prepare')f.delivery.put(f.put());
    const input=operation==='put'?f.put():f.prepare(),before=f.draftState();let entered=false;
    f.setFault(point=>{if(point==='beforePersist'&&!entered){entered=true;f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});}});
    assert.throws(()=>operation==='put'?f.delivery.put(input):f.delivery.prepare(input),code('LOCAL_DELIVERY_CONFLICT'));f.setFault(()=>{});
    assert.equal(entered,true);assert.equal(f.draftState(),before);assert.equal(f.get().intent,null);assert.equal(f.calls.length,0);assert.equal(existsSync(f.file),false);
  }
});

test('transaction rechecks preserve editing and explicit discard of an existing changed or missing target',async t=>{
  for(const status of ['changed','missing']){
    const f=await fixture(t),saved=f.delivery.put(f.put());let entered=false;
    f.setFault(point=>{if(point==='beforePersist'&&!entered){entered=true;if(status==='changed'){f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});}else{const value={...f.timeline,id:randomUUID()};f.store.db.prepare('UPDATE timelines SET id=?,data=? WHERE id=?').run(value.id,JSON.stringify(value),f.timeline.id);}}});
    const result=f.delivery.put(f.put(saved,'Later raw'));f.setFault(()=>{});assert.equal(entered,true);assert.equal(result.draftTargetStatus,status);assert.equal(result.draftRevision,saved.draftRevision+1);
    const discarded=f.delivery.discard({...authority(result),expectedDraftRevision:result.draftRevision,draftId:result.draft!.draftId});assert.equal(discarded.draft,null);assert.equal(discarded.draftRevision,result.draftRevision+1);assert.equal(f.calls.length,0);
  }
});
