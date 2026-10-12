import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,copyFileSync,symlinkSync,linkSync,chmodSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';
import {createTimelineRecoveryBoundary,readTimelineReceipt} from '../packages/business/src/timeline-recovery.mjs';
import {createLocalDelivery,LOCAL_DELIVERY_FILENAME} from '@mioon/business/local-delivery';
import {LOCAL_DELIVERY_LIMITS,createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import {schemas,isTimelineMutationResponse,hasRequestNotAppliedProof,publicValue,AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
const contract=createLocalDeliverySchemas(value=>schemas['timeline.render'].safeParse(value).success);
const code=value=>error=>error.code===value&&!error.message.includes('PRIVATE');
const authority=value=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId});
const action=value=>({...authority(value),intentId:value.intent.intentId,expectedIntentRevision:value.intentRevision});
const deferred=()=>Promise.withResolvers();
async function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'mioon-local-delivery-'));let store=openStore(root),services=createServices(store,new Map()),delivery,fault=()=>{},render,extraGuards={};let calls=[];
  const project=await services.call('project.create',{name:'Local delivery'}),assetId=randomUUID();
  const asset=store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${assetId}.png`,createdAt:new Date().toISOString()});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  const originalRender=input=>services.call('timeline.render',input);render=originalRender;
  const guards=()=>({ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),
    readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read({sourceSemantics:false}),
    isRenderInput:value=>schemas['timeline.render'].safeParse(value).success,
    isRenderResponse:(input,value)=>isTimelineMutationResponse('timeline.render',input,value),
    isNotApplied:(input,error)=>hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),
    readReceipt:input=>{const saved=readTimelineReceipt(store.db,input,'timeline.render');if(!saved)return null;if(saved.requestHash!==hash({operation:'timeline.render',input}))throw Error('PRIVATE bad hash');return publicValue(createTimelineRecoveryBoundary(store.db,input).replay('timeline.render',saved.response));},
    render:input=>{calls.push(structuredClone(input));return render(input);},...extraGuards});
  const start=(options={})=>delivery=createLocalDelivery({root,storage,guards:guards(),fault:point=>fault(point),...options});start();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const get=()=>delivery.get({projectId:project.id});
  const put=(value=get(),name='Draft title')=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,raw:{deliveryName:name}});
  const prepare=(value=get(),patch={})=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,
    draft:value.draft?{draftId:value.draft.draftId,revision:value.draftRevision,raw:value.draft.raw}:null,
    input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(value.draft?.raw.deliveryName?{deliveryName:value.draft.raw.deliveryName}:{})},...patch});
  return {root,file:path.join(root,LOCAL_DELIVERY_FILENAME),project,asset,timeline,get,put,prepare,start,originalRender,get store(){return store;},get services(){return services;},get delivery(){return delivery;},get calls(){return calls;},
    setFault(fn){fault=fn;},setRender(fn){render=fn;},setExportInspect(inspect){services=createServices(store,new Map(),{exportOptions:{inspect}});},setGuards(value){extraGuards=value;start();},
    restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
    snapshot(){return JSON.stringify(store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all())+'\n'+JSON.stringify(['projects','assets','timelines','timeline_requests','timeline_history','edit_tasks','exports'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
    counts(){return ['exports','timeline_requests','edit_tasks'].map(table=>store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);},
  };
}

test('GET and draft-only writes are bounded, private, noncreating reads with unchanged SQLite bytes and schemas',async t=>{
  const f=await fixture(t),before=f.snapshot(),empty=f.get();assert.ok(contract.envelope.safeParse(empty).success);assert.equal(existsSync(f.file),false);assert.equal(empty.draftTargetStatus,'unset');
  const input=f.put(empty,' \nraw\u0000title '),saved=f.delivery.put(input);assert.equal(saved.draft.raw.deliveryName,input.raw.deliveryName);assert.equal(saved.draftRevision,1);assert.equal(statSync(f.file).mode&0o777,0o600);assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
  assert.deepEqual(f.delivery.put(input),saved);const next=f.delivery.put(f.put(saved,'Second'));assert.throws(()=>f.delivery.put(input),code('LOCAL_DELIVERY_CONFLICT'));
  const remove={...authority(next),expectedDraftRevision:next.draftRevision,draftId:next.draft.draftId};assert.equal(f.delivery.discard(remove).draft,null);assert.equal(f.get().draftRevision,3);assert.equal(f.snapshot(),before);
});

test('immutable preparation precedes dispatch; one pending reservation rejects competing windows',async t=>{
  const f=await fixture(t),draft=f.delivery.put(f.put()),before=f.snapshot(),input=f.prepare(draft),prepared=f.delivery.prepare(input);
  assert.equal(prepared.intent.outcome.status,'pending');assert.deepEqual(prepared.intent.input,input.input);assert.equal(prepared.intentRevision,1);assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);
  assert.deepEqual(f.delivery.prepare(input),prepared);assert.throws(()=>f.delivery.prepare(f.prepare(prepared)),code('LOCAL_DELIVERY_CONFLICT'));
  assert.throws(()=>f.delivery.prepare({...input,intentId:randomUUID()}),code('LOCAL_DELIVERY_CONFLICT'));assert.ok(contract.envelope.safeParse(f.get()).success);
});

test('actual shared render accepts once, atomically clears only its captured draft and retains exact original receipt',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved)),inputBytes=JSON.stringify(prepared.intent.input),before=f.counts();
  const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'accepted');assert.equal(result.envelope.draft,null);assert.equal(result.envelope.draftRevision,saved.draftRevision+1);assert.equal(result.envelope.intentRevision,2);assert.ok(contract.execution.safeParse(result).success);
  assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.calls[0]),inputBytes);assert.equal(f.counts()[0],before[0]+1);assert.equal(f.counts()[1],before[1]+1);assert.equal(f.counts()[2],before[2]);
  const receipt=readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response;assert.equal(JSON.parse(receipt).snapshot.deliveryName,'Draft title');
  assert.deepEqual(await f.delivery.recover(action(result.envelope)),result);assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response,receipt);
  assert.throws(()=>f.delivery.execute(action(prepared)),code('LOCAL_DELIVERY_CONFLICT'));
});

test('overlapping execute/recover shares one promise while a newer title survives the exact accepted callback',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved)),gate=deferred();f.setRender(async input=>{await gate.promise;return f.originalRender(input);});
  const first=f.delivery.execute(action(prepared)),second=f.delivery.recover(action(prepared));assert.equal(first,second);await Promise.resolve();assert.equal(f.calls.length,1);
  const newer=f.delivery.put(f.put(f.get(),'Newer title'));gate.resolve();const result=await first;assert.equal(result.envelope.intent.outcome.status,'accepted');assert.deepEqual(result.envelope.draft,newer.draft);assert.equal(result.envelope.draftRevision,newer.draftRevision);assert.equal(f.calls.length,1);
});

test('lost response after actual shared acceptance reconciles from original receipt without another render',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.setRender(async input=>{await f.originalRender(input);throw Error('PRIVATE lost response');});
  const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'accepted');assert.equal(Object.hasOwn(result.response.snapshot,'deliveryName'),false);assert.equal(Object.hasOwn(result.response.snapshot,'delivery'),false);assert.equal(Object.hasOwn(f.calls[0],'exportSettings'),false);
  f.restart();const found=f.get(),bytes=readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response;assert.equal(found.intent.outcome.status,'accepted');assert.equal((await f.delivery.recover(action(found))).response.id,result.response.id);assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response,bytes);
});

test('ambiguous transport remains pending through reload and only explicit recover executes original input',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.setRender(async()=>{throw Error('PRIVATE before service');});
  const first=await f.delivery.execute(action(prepared));assert.equal(first.envelope.intent.outcome.status,'pending');assert.equal(first.response,null);assert.equal(f.calls.length,1);f.restart();assert.equal(f.get().intent.outcome.status,'pending');assert.equal(f.calls.length,1);
  f.setRender(f.originalRender);const result=await f.delivery.recover(action(f.get()));assert.equal(result.envelope.intent.outcome.status,'accepted');assert.deepEqual(f.calls[0],f.calls[1]);
});

test('actual shared revision rejection is terminal, never retried after timeline restoration, and permits exact new-intent CAS',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),prepared=f.delivery.prepare(f.prepare(saved));
  f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});const rejected=await f.delivery.execute(action(prepared));assert.equal(rejected.envelope.intent.outcome.status,'not_applied');assert.equal(rejected.envelope.intent.outcome.code,'REVISION_CONFLICT');assert.deepEqual(rejected.envelope.draft,saved.draft);
  f.store.put('timelines',f.timeline);const oldCalls=f.calls.length;assert.equal((await f.delivery.recover(action(f.get()))).envelope.intent.outcome.status,'not_applied');assert.equal(f.calls.length,oldCalls);
  const next=f.delivery.prepare(f.prepare(f.get()));assert.notEqual(next.intent.intentId,prepared.intent.intentId);assert.throws(()=>f.delivery.recover(action(rejected.envelope)),code('LOCAL_DELIVERY_CONFLICT'));
});

for(const point of ['beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync'])test(`prepare failure at ${point} produces zero render calls`,async t=>{
  const f=await fixture(t),input=f.prepare(),before=f.snapshot();f.setFault(label=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.delivery.prepare(input),code(point==='beforePersist'?'LOCAL_DELIVERY_STORAGE_UNAVAILABLE':'LOCAL_DELIVERY_SAVE_UNCERTAIN'));assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);f.setFault(()=>{});
  if(existsSync(f.file)){assert.equal(f.get().intent.outcome.status,'pending');assert.equal(f.calls.length,0);}
});

for(const point of ['beforeOutcomePersist','beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync'])test(`outcome failure at ${point} never permits a fresh intent; explicit recovery uses original receipt`,async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());let outcome=false;
  f.setFault(label=>{if(label==='beforeOutcomePersist')outcome=true;if(outcome&&label===point)throw Error('PRIVATE outcome fault');});
  await assert.rejects(f.delivery.execute(action(prepared)));assert.equal(f.calls.length,1);f.setFault(()=>{});const found=f.get();assert.equal(found.intent.outcome.status,'pending');assert.throws(()=>f.delivery.prepare(f.prepare(found)),code('LOCAL_DELIVERY_CONFLICT'));
  const result=await f.delivery.recover(action(found));assert.equal(result.envelope.intent.outcome.status,'accepted');assert.equal(f.calls.length,1);
});

test('postrename not-applied uncertainty rechecks its terminal marker without ever calling render again',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.store.put('timelines',{...f.timeline,revision:f.timeline.revision+1});let outcome=false;
  f.setFault(point=>{if(point==='beforeOutcomePersist')outcome=true;if(outcome&&point==='afterPersist')throw Error('PRIVATE fault');});await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});
  assert.equal(f.get().intent.outcome.status,'pending');f.store.put('timelines',f.timeline);const result=await f.delivery.recover(action(f.get()));assert.equal(result.envelope.intent.outcome.status,'not_applied');assert.equal(f.calls.length,1);
});

test('foreign or malformed proof and forged acknowledgement cannot release pending reservation',async t=>{
  for(const mode of ['wrong-request','wrong-project','unauthorized','fake-ack']){
    const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());
    f.setRender(async input=>{if(mode==='fake-ack')return {id:randomUUID(),status:'queued'};throw new AppError('REVISION_CONFLICT','PRIVATE',mode==='unauthorized'?403:409,{mutationOutcome:'not_applied',requestId:mode==='wrong-request'?randomUUID():input.requestId,projectId:mode==='wrong-project'?randomUUID():input.projectId,operation:'timeline.render'});});
    const result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'pending',mode);assert.equal(result.response,null);assert.equal(f.counts()[0],0);
  }
});

test('late original timeline replacement, source-owner transfer and lease loss cannot save terminal outcome',async t=>{
  for(const mode of ['timeline','source','lease']){
    const f=await fixture(t),prepared=f.delivery.prepare(f.prepare()),gate=deferred(),entered=deferred();f.setRender(async input=>{const accepted=await f.originalRender(input);entered.resolve();await gate.promise;return accepted;});
    const pending=f.delivery.execute(action(prepared));await entered.promise;
    if(mode==='timeline'){const changed={...f.timeline,id:randomUUID()};f.store.db.prepare('UPDATE timelines SET id=?,data=? WHERE id=?').run(changed.id,JSON.stringify(changed),f.timeline.id);}
    if(mode==='source'){const foreign={...f.project,id:randomUUID()};f.store.put('projects',foreign);f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign.id,f.asset.id);}
    if(mode==='lease'){unlinkSync(path.join(f.root,'server.lock'));writeFileSync(path.join(f.root,'server.lock'),'0',{mode:0o600});}
    gate.resolve();await assert.rejects(pending);assert.equal(JSON.parse(readFileSync(f.file)).entries[0].intent.outcome.status,'pending');
  }
});

test('reentrant before-persist edit trips full-file CAS and preserves the newer draft',async t=>{
  const f=await fixture(t),initial=f.get(),input=f.put(initial,'Outer'),inner=f.put(initial,'Inner');let entered=false;
  f.setFault(point=>{if(point==='beforePersist'&&!entered){entered=true;f.delivery.put(inner);}});
  assert.throws(()=>f.delivery.put(input),code('LOCAL_DELIVERY_CONFLICT'));f.setFault(()=>{});assert.equal(f.get().draft.raw.deliveryName,'Inner');
});

test('restart, copied scope, other build channel, strict input and unsafe files all fail closed without repair',async t=>{
  const f=await fixture(t),saved=f.delivery.put(f.put()),old=f.put(saved);f.restart();assert.notEqual(f.get().instanceId,saved.instanceId);assert.throws(()=>f.delivery.put(old),code('LOCAL_DELIVERY_STALE_INSTANCE'));
  const bytes=readFileSync(f.file);f.start({channel:'production'});assert.throws(f.get,code('LOCAL_DELIVERY_SCOPE_MISMATCH'));assert.deepEqual(readFileSync(f.file),bytes);f.start();
  const foreign=await fixture(t);copyFileSync(f.file,foreign.file);chmodSync(foreign.file,0o600);assert.throws(foreign.get,code('LOCAL_DELIVERY_SCOPE_MISMATCH'));
  let touched=0;const input=f.put();const getter={...input};Object.defineProperty(getter,'raw',{enumerable:true,get(){touched++;return input.raw;}});
  for(const bad of [getter,new Proxy(input,{}),{...input,path:'/PRIVATE'},{...input,raw:{deliveryName:'x'.repeat(513)}},{...f.prepare(),operation:'project.delete'}])assert.throws(()=>f.delivery.put(bad),code('LOCAL_DELIVERY_VALIDATION'));assert.equal(touched,0);assert.deepEqual(readFileSync(f.file),bytes);
  for(const value of ['{','null',JSON.stringify({version:2,workspaceScope:saved.workspaceScope,entries:[]}),Buffer.from([0xff]),'x'.repeat(LOCAL_DELIVERY_LIMITS.envelopeBytes+1)]){writeFileSync(f.file,value);assert.throws(f.get,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),Buffer.from(value));}
  rmSync(f.file);const target=path.join(f.root,'private-target');writeFileSync(target,'PRIVATE',{mode:0o600});symlinkSync(target,f.file);assert.throws(f.get,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));rmSync(f.file);linkSync(target,f.file);assert.throws(f.get,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));rmSync(f.file);writeFileSync(f.file,bytes,{mode:0o644});assert.throws(f.get,code('LOCAL_DELIVERY_STORAGE_UNAVAILABLE'));assert.equal(statSync(f.file).mode&0o777,0o644);
});

test('restored mode returns unsupported before touching sidecar, lock, timeline or render',async()=>{
  const never=()=>{throw Error('PRIVATE should never run');},delivery=createLocalDelivery({root:'/unread',storage:{validatePrivateDirectory:never,validateManagedFile:never,readPrivateFile:never,writePrivateFileAtomic:never},guards:{ownsLock:never,isRestored:()=>true,readTimeline:never,readReceipt:never,isRenderInput:never,isRenderResponse:never,isNotApplied:never,render:never}});
  for(const method of ['get','put','discard','prepare'])assert.deepEqual(delivery[method]({}),{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'});
  for(const method of ['execute','recover'])assert.deepEqual(await delivery[method]({}),{envelope:{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'},response:null});
});

test('historical receipt recovery survives later source duration metadata without changing the original receipt',async t=>{
  const f=await fixture(t);f.store.put('assets',{...f.asset,mimeType:'video/mp4',duration:3,hasAudio:true});
  const prepared=f.delivery.prepare(f.prepare());f.setFault(point=>{if(point==='afterDispatch')throw Error('PRIVATE dropped response');});
  await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});
  const bytes=readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response;
  f.store.put('assets',{...f.asset,mimeType:'video/mp4',duration:0.1,hasAudio:false});
  const found=f.get();assert.equal(found.intent.outcome.status,'pending');const result=await f.delivery.recover(action(found));assert.equal(result.envelope.intent.outcome.status,'accepted');assert.equal(f.calls.length,1);assert.equal(readTimelineReceipt(f.store.db,prepared.intent.input,'timeline.render').response,bytes);
});

test('a failed pre-dispatch fence makes zero service calls and keeps the reservation pending',async t=>{
  const f=await fixture(t),prepared=f.delivery.prepare(f.prepare());f.setFault(point=>{if(point==='beforeDispatch')throw Error('PRIVATE stop');});
  await assert.rejects(f.delivery.execute(action(prepared)));f.setFault(()=>{});assert.equal(f.calls.length,0);assert.equal(f.get().intent.outcome.status,'pending');
});

test('late abort or restored-profile transition cannot publish an ordinary terminal sidecar',async t=>{
  for(const mode of ['abort','restored']){
    const f=await fixture(t),controller=new AbortController();let restored=false;
    f.setGuards({isRestored:()=>restored});if(mode==='abort')f.start({signal:controller.signal});
    const prepared=f.delivery.prepare(f.prepare()),gate=deferred(),entered=deferred();f.setRender(async input=>{const result=await f.originalRender(input);entered.resolve();await gate.promise;return result;});
    const pending=f.delivery.execute(action(prepared));await entered.promise;if(mode==='abort')controller.abort();else restored=true;gate.resolve();await assert.rejects(pending);
    assert.equal(JSON.parse(readFileSync(f.file)).entries[0].intent.outcome.status,'pending');if(mode==='restored')assert.equal(f.get().supported,false);
  }
});

test('capacity counts retained tombstones without eviction and wrong deletion identity never receives an ACK',async t=>{
  const f=await fixture(t),empty=f.get();
  const entries=Array.from({length:LOCAL_DELIVERY_LIMITS.slots},()=>({projectId:randomUUID(),draftRevision:1,draft:null,intentRevision:0,intent:null}));
  writeFileSync(f.file,JSON.stringify({version:1,workspaceScope:empty.workspaceScope,entries}),{mode:0o600});const bytes=readFileSync(f.file);
  assert.throws(()=>f.delivery.put(f.put(empty)),code('LOCAL_DELIVERY_CAPACITY'));assert.deepEqual(readFileSync(f.file),bytes);rmSync(f.file);
  const saved=f.delivery.put(f.put(empty)),remove={...authority(saved),expectedDraftRevision:saved.draftRevision,draftId:saved.draft.draftId};f.delivery.discard(remove);
  assert.throws(()=>f.delivery.discard({...remove,draftId:randomUUID()}),code('LOCAL_DELIVERY_CONFLICT'));assert.throws(()=>f.delivery.discard(remove),code('LOCAL_DELIVERY_CONFLICT'));assert.equal(f.get().draft,null);
});


test('actual shared asynchronous capability admission is single-flight and preserves exact optional settings',async t=>{
  const f=await fixture(t),gate=deferred(),entered=deferred();let checks=0;
  f.setExportInspect(async()=>{checks++;entered.resolve();await gate.promise;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};});
  const settings={profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'bitrate',targetKbps:4000}},input=f.prepare();input.input.exportSettings=settings;
  const prepared=f.delivery.prepare(input),first=f.delivery.execute(action(prepared));await entered.promise;
  const second=f.delivery.recover(action(prepared));assert.equal(first,second);assert.equal(checks,1);assert.equal(f.calls.length,1);assert.equal(f.get().intent.outcome.status,'pending');
  gate.resolve();const result=await first;assert.equal(result.envelope.intent.outcome.status,'accepted');assert.deepEqual(result.response.snapshot.delivery.exportSettings,settings);assert.deepEqual(f.calls[0],input.input);assert.equal(Object.hasOwn(f.calls[0],'preflightSnapshotHash'),false);assert.equal(f.counts()[0],1);
});

test('actual shared capability rejection is a fixed terminal proof and explicit recovery does not retry it',async t=>{
  const f=await fixture(t);let checks=0;f.setExportInspect(async()=>{checks++;return {status:'incomplete',code:'EXPORT_CAPABILITY_BUSY'};});
  const input=f.prepare();input.input.exportSettings={profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
  const prepared=f.delivery.prepare(input),result=await f.delivery.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'not_applied');assert.equal(result.envelope.intent.outcome.code,'EXPORT_CAPABILITY_BUSY');assert.equal(checks,1);assert.equal(f.counts()[0],0);
  f.setExportInspect(async()=>{checks++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};});assert.equal((await f.delivery.recover(action(f.get()))).envelope.intent.outcome.status,'not_applied');assert.equal(checks,1);assert.equal(f.calls.length,1);
});
