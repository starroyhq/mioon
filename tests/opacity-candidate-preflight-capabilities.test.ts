import type {OpacityServices} from './helpers/strict-opacity-fixture-types.ts';
import type {OpacityServices as FixtureServices} from './helpers/strict-opacity-fixture-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {openOpacityCandidateStore,getOpacityCandidateAssembly,OPACITY_CANDIDATE_ADVISORY_OPERATIONS,OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from '../packages/business/src/opacity-candidate-domain.ts';
import {createTimelineExportAdmissionServices} from '../packages/business/src/timeline-export-admission.ts';
import {createServices, type OrdinaryServices} from '../packages/business/src/services.ts';
import {OPACITY_CANDIDATE_PREFLIGHT_MESSAGES} from '../packages/business/src/opacity-candidate-preflight.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {isTimelineExportCapabilitiesResponse} from '../packages/contracts/src/index.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

const stamp='2026-10-16T00:00:00.000Z';
const operation='timeline.export.capabilities';
const available=()=>({status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'} as const);
const deferred=()=>{let resolve: ((value?:unknown)=>void)|undefined;return {promise:new Promise(done=>{resolve=done;}),resolve};};
const settings=()=>({profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}});
const contents=(store: { db: { prepare: (arg0: string) => { (): unknown; new(): unknown; all: { (): { name: unknown; }[]; new(): unknown; }; }; }; })=>JSON.stringify(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({name})=>[name,store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const denied=(error: unknown)=>['RESTORE_OPERATION_UNAVAILABLE','RESTORE_STORE_UNVERIFIED'].includes((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure)?.code);
function fixture(t: test.TestContext,{empty=false}={}) {
  const root=mkdtempPortable('mioon-opacity-preflight-capabilities-');
  const ids=Object.fromEntries(['project','otherProject','asset','timeline','track','clip'].map(key=>[key,randomUUID()]));
  const data=({project:{id:ids.project,name:'Synthetic capability',revision:1,createdAt:stamp,updatedAt:stamp},
    asset:{id:ids.asset,projectId:ids.project,name:'Synthetic metadata only',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:false,
      sha256:'a'.repeat(64),relativePath:'media/never-opened.mp4',createdAt:stamp}} as unknown as Pick<import('./helpers/strict-opacity-fixture-types.ts').OpacityMetadata,'project'|'asset'|'timeline'>);
  data.timeline={id:ids.timeline,projectId:ids.project,revision:1,fps:30,width:720,height:1280,tracks:[{id:ids.track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:ids.clip,assetId:ids.asset,trackId:ids.track,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
      opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]}}],durationFrames:30,createdAt:stamp,updatedAt:stamp};
  let store: import('./helpers/strict-timeline-core-types.ts').FixtureStore,services: OpacityServices;const media: unknown[]=[],off=onMediaProcess(event=>media.push(event)),admissions: ReturnType<typeof createTimelineExportAdmissionServices>[]=[];
  function open(){store=(openOpacityCandidateStore(root) as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureStore);services=(createServices(store,new Proxy(new Map(),{get(){throw Error('No provider access');}})) as unknown as FixtureServices);}
  open();store!.put('projects',data.project);store!.put('projects',{...data.project,id:ids.otherProject});if(!empty){store!.put('assets',data.asset);store!.put('timelines',data.timeline);}
  const f={root,ids,data,get store(){return store;},get services(){return services;},
    input(extra={}){return {projectId:ids.project,expectedRevision:1,exportSettings:settings(),...extra};},
    admission(inspect: NonNullable<NonNullable<Parameters<typeof createTimelineExportAdmissionServices>[1]>['inspect']>=async()=>available()){const result=createTimelineExportAdmissionServices(store!,{inspect});admissions.push(result);return result;},
    run(admission: ReturnType<typeof createTimelineExportAdmissionServices>,input: import('../packages/business/src/timeline-recovery.ts').TimelineRecoveryInput=f.input(),context: {signal?:AbortSignal;expectedWorkspaceOrigin?:string}={}){const assembly=(getOpacityCandidateAssembly(store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null);if(assembly!.getRestoreContext())assembly!.assertOrigin(context);
      return assembly!.withInvocation(operation,assembly!.freezeInput(input),{signal:context.signal},frozen=>admission.handlers[operation](frozen,{signal:context.signal}));},
    async close(){await Promise.all(admissions.splice(0).map(value=>value.drain()));await services.drain();store!.close();},
    async restore(){await f.close();const info={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'c'.repeat(64),sourceDbHash:'d'.repeat(64),createdAt:stamp};
      const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{db.exec('PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,info);}finally{db.close();}open();return info;},
  };
  t.after(async()=>{try{await f.close();assert.deepEqual(media,[]);}finally{off();rmSync(root,{recursive:true,force:true});}});return f;
}

test('candidate custom delivery capability uses the raw render freezer and existing bounded admission without writes',async t=>{
  const f=fixture(t),input=f.input(),expected=(createOpacityCandidateDomain(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDomain).readPreflightSnapshot(input),before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  let checks=0,capturedFence: (()=>unknown)|undefined;
  const admission=f.admission(((async(delivery: {effective:{width:number}},{beforeEffect,capabilityWorkRoot}: Parameters<NonNullable<NonNullable<Parameters<typeof createTimelineExportAdmissionServices>[1]>['inspect']>>[1])=>{
    checks++;assert.equal(f.store.db.isTransaction,false);assert.equal(capabilityWorkRoot,f.root);capturedFence=beforeEffect;beforeEffect!();
    assert.deepEqual(delivery,expected.snapshot!.delivery);assert.equal(delivery!.effective.width,360);return available();
  }) as unknown as Parameters<typeof f.admission>[0]));
  const report=await f.run(admission,input);
  assert.equal(report.status,'available');assert.ok(isTimelineExportCapabilitiesResponse(report,input));assert.deepEqual(report.delivery,expected.snapshot!.delivery);
  assert.equal(checks,1);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  assert.throws(capturedFence!,denied);assert.ok(!JSON.stringify(report).includes(f.root));
});

test('candidate capabilities RPC is actually assembled, strict and read-only even before any tool check',async t=>{
  const f=fixture(t,{empty:true}),before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),input=f.input();
  const report=await f.services.call(operation,input);assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'TIMELINE_MISSING');
  assert.ok(isTimelineExportCapabilitiesResponse(report,input));assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);
  for(const extra of [{purpose:'preview'},{requestId:randomUUID()},{snapshot:{}},{argv:[]},{exportRange:{startFrame:0,endFrame:1}}] as const)
    await assert.rejects(f.services.call(operation,{...input,...extra}),{code:'INVALID_OPACITY_RENDER_CANDIDATE'});
  assert.equal(OPACITY_CANDIDATE_ADVISORY_OPERATIONS.includes(operation),true);
  assert.equal(OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes(operation),false);
});

test('candidate capability admission cannot be invoked with a forged fence or borrowed invocation',async t=>{
  const f=fixture(t),other=fixture(t);let checks=0;
  const admission=f.admission(async()=>{checks++;return available();}),input=f.input(),assembly=(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null);
  await assert.rejects(admission.inspect({}, (({beforeEffect:()=>{}}) as unknown as NonNullable<Parameters<typeof admission.inspect>[1]>)),denied);
  await assert.rejects(admission.handlers[operation](input),denied);
  await (getOpacityCandidateAssembly(other.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null)!.withInvocation(operation,other.input(),{},async()=>{
    await assert.rejects(admission.handlers[operation](input),denied);
    assert.throws(()=>f.run(admission,input),denied);
  });
  let expired: (()=>Promise<unknown>)|undefined;
  await assembly!.withInvocation(operation,input,{},async()=>{expired=()=>admission.handlers[operation](input);});
  await assert.rejects(expired!(),denied);assert.equal(checks,0);
});

test('candidate capability report becomes stale on raw opacity, source metadata, ownership and content drift',async t=>{
  for(const kind of ['opacity','revision','metadata','sha256','assetOwner','timelineOwner'] as const)await t.test(kind,async t=>{
    const f=fixture(t),entered=deferred(),gate=deferred(),admission=f.admission(((async(_delivery: {effective:{width:number}},{beforeEffect}: Parameters<NonNullable<NonNullable<Parameters<typeof createTimelineExportAdmissionServices>[1]>['inspect']>>[1])=>{beforeEffect!();entered.resolve!();await gate.promise;beforeEffect!();return available();}) as unknown as Parameters<typeof f.admission>[0]));
    const pending=f.run(admission);await entered.promise;
    if(kind==='opacity'){const updated=structuredClone(f.data.timeline);(updated.clips[0].opacityEnvelope!.points[0] as unknown as {opacity:number}).opacity=.4;f.store.put('timelines',updated);}
    if(kind==='revision')f.store.put('timelines',{...f.data.timeline,revision:2});
    if(kind==='metadata')f.store.put('assets',{...f.data.asset,width:1280,height:720});
    if(kind==='sha256')f.store.put('assets',{...f.data.asset,sha256:'b'.repeat(64)});
    if(kind==='assetOwner')f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.ids.otherProject,f.ids.asset);
    if(kind==='timelineOwner')f.store.db.prepare('UPDATE timelines SET projectId=? WHERE id=?').run(f.ids.otherProject,f.ids.timeline);
    const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;gate.resolve!();
    const report=await pending;assert.equal(report.status,'stale');assert.equal(report.issues[0].code,'EXPORT_CAPABILITY_STALE');assert.ok(isTimelineExportCapabilitiesResponse(report,f.input()));
    assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  });
});

test('candidate ownership and invalid raw opacity are blocked before capability work',async t=>{
  for(const kind of ['assetOwner','opacity'] as const)await t.test(kind,async t=>{
    const f=fixture(t);let checks=0;const admission=f.admission(async()=>{checks++;return available();});
    if(kind==='assetOwner')f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.ids.otherProject,f.ids.asset);
    if(kind==='opacity'){const updated=structuredClone(f.data.timeline);(updated.clips[0].opacityEnvelope!.points[0] as unknown as {opacity:number}).opacity=2;
      f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(updated),f.ids.timeline);}
    const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),report=await f.run(admission);assert.equal(report.status,'blocked');
    assert.equal(report.issues[0].code,kind==='opacity'?'INVALID_TIMELINE_SNAPSHOT':'TIMELINE_SOURCE_UNAVAILABLE');assert.equal(checks,0);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);
    assert.ok(isTimelineExportCapabilitiesResponse(report,f.input()));assert.ok(!JSON.stringify(report).includes(f.root));
  });
});

test('candidate capabilities preserves finite actual source/LUT refusal codes through the real service without inspection or writes',async t=>{
  for(const kind of ['lut','bounds','fade'] as const)await t.test(kind,async t=>{
    const f=fixture(t);let checks=0;const admission=f.admission(async()=>{checks++;throw Error('Must fail before local inspection');});
    const expected=kind==='lut'?'TIMELINE_COLOUR_LOOK_UNAVAILABLE':kind==='bounds'?'SOURCE_BOUNDS':'FADE_AUDIO_UNSUPPORTED';
    if(kind==='lut'){const updated=structuredClone(f.data.timeline);updated.clips[0].colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:f.data.asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},
      look:{resourceId:randomUUID(),resourceSha256:'b'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};f.store.put('timelines',updated);}
    if(kind==='bounds')f.store.put('assets',{...f.data.asset,duration:.5});
    if(kind==='fade'){const updated=structuredClone(f.data.timeline);updated.clips[0].fadeInFrames=1;f.store.put('timelines',updated);}
    const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const sanitized=(error: { code: unknown; status: unknown; message: unknown; details: unknown; })=>{
      assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code,expected);assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).status,409);assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).message,OPACITY_CANDIDATE_PREFLIGHT_MESSAGES[expected]);
      assert.deepEqual((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details,{});assert.ok(!JSON.stringify(error).includes(f.root));assert.ok(!JSON.stringify(error).includes(f.ids.asset));return true;
    };
    await assert.rejects(f.run(admission),sanitized);
    await assert.rejects(f.services.call(operation,f.input()),sanitized);
    await assert.rejects(f.services.call('timeline.render',{projectId:f.ids.project,requestId:randomUUID(),expectedRevision:1,purpose:'export'}),{code:expected});
    assert.equal(checks,0);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  });
});

test('candidate capability failure results are validated and sanitized by existing admission',async t=>{
  for(const result of [{status:'unavailable',code:'EXPORT_CAPABILITY_UNSUPPORTED'}, {status:'incomplete',code:'EXPORT_CAPABILITY_TIMEOUT'},
    {status:'available',code:'forged',message:'/private/secret'}] as const) {
    const f=fixture(t),before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),report=await f.run(f.admission(async()=>result));
    assert.equal(report.status,result.code==='forged'?'incomplete':result.status);assert.ok(isTimelineExportCapabilitiesResponse(report,f.input()));
    assert.ok(!JSON.stringify(report).includes('/private/secret'));assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);
  }
});

test('43 capability service requires exact origin and leaves captured exports and receipts held',async t=>{
  const f=fixture(t),captured=await f.services.call('timeline.render',{projectId:f.ids.project,requestId:randomUUID(),expectedRevision:1,purpose:'preview'}),info=await f.restore();
  await assert.rejects(f.services.call(operation,f.input()),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.services.call(operation,f.input(),{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;let capturedFence: (()=>unknown)|undefined;
  const admission=f.admission(((async(_delivery: {effective:{width:number}},{beforeEffect}: Parameters<NonNullable<NonNullable<Parameters<typeof createTimelineExportAdmissionServices>[1]>['inspect']>>[1])=>{capturedFence=beforeEffect;beforeEffect!();return available();}) as unknown as Parameters<typeof f.admission>[0]));
  const report=await f.run(admission,f.input(),{expectedWorkspaceOrigin:info.workspaceOrigin});assert.equal(report.status,'available');assert.throws(capturedFence!,denied);
  assert.ok(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(captured.id));assert.deepEqual(f.store.get('exports',captured.id),captured);
  assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  // Actual service routing is exercised without ever reaching FFmpeg: stale
  // selection is a normal advisory response under this exact origin.
  const stale=await f.services.call(operation,f.input({expectedRevision:2}),{expectedWorkspaceOrigin:info.workspaceOrigin});assert.equal(stale.status,'stale');
});

test('43 cancelled capability invocation expires its fence and cannot publish an available report',async t=>{
  const f=fixture(t),info=await f.restore(),controller=new AbortController(),entered=deferred(),gate=deferred();let capturedFence: (()=>unknown)|undefined;
  const admission=f.admission(((async(_delivery: {effective:{width:number}},{beforeEffect}: Parameters<NonNullable<NonNullable<Parameters<typeof createTimelineExportAdmissionServices>[1]>['inspect']>>[1])=>{capturedFence=beforeEffect;beforeEffect!();entered.resolve!();await gate.promise;beforeEffect!();return available();}) as unknown as Parameters<typeof f.admission>[0]));
  const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),pending=f.run(admission,f.input(),{expectedWorkspaceOrigin:info.workspaceOrigin,signal:controller.signal});await entered.promise;controller.abort();gate.resolve!();
  await assert.rejects(pending,error=>denied(error)||(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code==='OPERATION_CANCELLED');assert.throws(capturedFence!,denied);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);
});

test('candidate capability read catches preserve real lease revocation before and after the inspector await',async t=>{
  for(const restored of [false,true] as const)for(const phase of ['initial','final'] as const)await t.test(`${restored?43:42} ${phase}`,async t=>{
    const f=fixture(t),info=restored?await f.restore():null,db=f.store.db,descriptor=Object.getOwnPropertyDescriptor(db,'prepare'),native=db.prepare;
    let reads=0,checks=0;const target=phase==='initial'?1:2,admission=f.admission(async()=>{checks++;return available();});
    const before=contents(((f.store) as unknown as Parameters<typeof contents>[0])),changes=db.prepare('SELECT total_changes() AS n').get()!.n;
    db.prepare=function(sql: string|string[],...args: unknown[]){
      const statement=Reflect.apply(native,this,[sql,...args]);
      if(sql.includes('FROM timelines WHERE projectId=? LIMIT 1')&&++reads===target)unlinkSync(path.join(f.root,'server.lock'));
      return statement;
    };
    try{
      await assert.rejects(f.run(admission,f.input(),info?{expectedWorkspaceOrigin:info.workspaceOrigin}:{}),{code:'RESTORE_STORE_UNVERIFIED'});
    }finally{if(descriptor)Object.defineProperty(db,'prepare',descriptor);else delete (db as unknown as Record<PropertyKey,unknown>).prepare;}
    assert.equal(reads,target);assert.equal(checks,phase==='initial'?0:1);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);
    assert.throws(()=>(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null),{code:'RESTORE_STORE_UNVERIFIED'});
  });
});

test('candidate capability read catches preserve a live cross-store authority refusal at both reads',async t=>{
  for(const phase of ['initial','final'] as const)await t.test(phase,async t=>{
    const f=fixture(t),other=fixture(t),foreign=(getOpacityCandidateAssembly(other.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null),db=f.store.db,descriptor=Object.getOwnPropertyDescriptor(db,'prepare'),native=db.prepare;
    let reads=0,checks=0;const target=phase==='initial'?1:2,admission=f.admission(async()=>{checks++;return available();}),before=contents(((f.store) as unknown as Parameters<typeof contents>[0]));
    db.prepare=function(sql: string|string[],...args: unknown[]){
      const statement=Reflect.apply(native,this,[sql,...args]);
      if(sql.includes('FROM timelines WHERE projectId=? LIMIT 1')&&++reads===target)foreign!.checkpoint();
      return statement;
    };
    try{await assert.rejects(f.run(admission),{code:'RESTORE_OPERATION_UNAVAILABLE'});}
    finally{if(descriptor)Object.defineProperty(db,'prepare',descriptor);else delete (db as unknown as Record<PropertyKey,unknown>).prepare;}
    assert.equal(reads,target);assert.equal(checks,phase==='initial'?0:1);assert.equal(contents(((f.store) as unknown as Parameters<typeof contents>[0])),before);
    assert.doesNotThrow(foreign!.checkpoint);assert.doesNotThrow(()=>(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null));
  });
});
