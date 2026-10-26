import type {OpacityServices} from './helpers/strict-opacity-fixture-types.ts';
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempPortable} from './helpers/temp-root.ts';
import type { BinaryLike } from 'crypto';
import type { ServiceStore } from '../packages/business/src/services.ts';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('candidate preflight uses actual owned SQL/source/hash lifecycle with only codec transport mocked', () => {
    const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',fileURLToPath(import.meta.url)],
      {encoding:'utf8',timeout:60000,maxBuffer:1024*1024,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT'))});
    assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/pass 14\b/u);
  });
} else {
  const runtime=await import('../packages/business/src/media-runtime.ts');
  const probeOutput=()=>JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,duration:'1'}],format:{duration:'1'}});
  let probeCalls=0,behavior=async()=>{};
  mock.module('../packages/business/src/media-runtime.ts',{namedExports:{...runtime,
    run:async(binary: unknown,argv: string|string[],options: { beforeSpawn: () => void; beforeEffect: () => void; })=>{
      assert.equal(binary,'ffprobe');assert.ok(argv.includes('-show_streams'));options.beforeSpawn?.();options.beforeEffect?.();
      probeCalls++;await behavior();options.beforeEffect?.();return probeOutput();
    },runStreaming:()=>{throw Error('No external streaming media is permitted');},
  }});
  const {openOpacityCandidateStore,getOpacityCandidateAssembly}=await import('../packages/business/src/opacity-candidate-store.ts');
  const {installWorkspaceRestoreSchemaV43}=await import('../packages/business/src/workspace-restore-schema-v43.ts');
  const {createServices}=await import('../packages/business/src/services.ts');
  const {createTimelinePreflightServices,timelineSnapshotHash}=await import('../packages/business/src/timeline-preflight.ts');
  const {createOpacityCandidateDomain}=await import('../packages/business/src/opacity-candidate-domain.ts');
  const {createOpacityCandidatePreflightRuntime}=await import('../packages/business/src/opacity-candidate-preflight.ts');
  const {isExportPreflightResponse,EXPORT_PREFLIGHT_LIMITS}=await import('../packages/contracts/src/index.ts');
  const {onMediaProcess}=await import('../packages/business/src/media-processes.ts');
  const stamp='2026-10-16T00:00:00.000Z';
  const digest=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
  const deferred=()=>{let resolve: ((value?:unknown)=>void)|undefined;return {promise:new Promise(r=>{resolve=r;}),resolve};};
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  function fixture(t: test.TestContext){
    const root=mkdtempPortable('mioon-opacity-preflight-'),ids=Object.fromEntries(['project','asset','timeline','track','clip'].map(key=>[key,randomUUID()]));
    const bytes=Buffer.from('synthetic private source; actual hash and inode'),events: unknown[]=[],off=onMediaProcess(event=>events.push(event));
    let store!: import('./helpers/strict-timeline-core-types.ts').FixtureStore,services: OpacityServices;behavior=async()=>{};const open=()=>{store=(openOpacityCandidateStore(root) as unknown as import('./helpers/strict-timeline-core-types.ts').FixtureStore);services=(createServices(store,new Proxy(new Map(),{get(){throw Error('No provider access');}})) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityServices);};open();
    writeFileSync(path.join(root,'media/source.mp4'),bytes,{mode:0o600});
    store.put('projects',{id:ids.project,name:'Synthetic',revision:1,createdAt:stamp,updatedAt:stamp});
    store.put('assets',{id:ids.asset,projectId:ids.project,name:'Source',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:false,
      relativePath:'media/source.mp4',sha256:digest(bytes),createdAt:stamp});
    store.put('timelines',{id:ids.timeline,projectId:ids.project,revision:1,fps:30,width:720,height:1280,
      tracks:[{id:ids.track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
      clips:[{id:ids.clip,trackId:ids.track,assetId:ids.asset,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
        opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]}}],durationFrames:30,createdAt:stamp,updatedAt:stamp});
    const f={root,ids,bytes,get store(){return store;},get services(){return services;},input:(extra={})=>({projectId:ids.project,expectedRevision:1,...extra}),
      writes:()=>store.db.prepare('SELECT total_changes() AS n').get()!.n,
      async check(extra={},context={}){const input=f.input(extra),result=await services.call('timeline.export.preflight',input,context);assert.ok(isExportPreflightResponse(result,input),JSON.stringify(result));return result;},
      async close(){await services.drain();store.close();},
      async restore(){await f.close();const db=new DatabaseSync(path.join(root,'workbench.sqlite')),metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp};
        try{db.exec('PRAGMA foreign_keys=ON');installWorkspaceRestoreSchemaV43(db,metadata);}finally{db.close();}open();return metadata;},
    };
    t.after(async()=>{behavior=async()=>{};try{await f.close();assert.deepEqual(events,[]);}finally{off();rmSync(root,{recursive:true,force:true});}});return f;
  }

  test('actual42 preflight hashes raw curves and derived plans exactly as preview and export admission without writes',async t=>{
    const f=fixture(t),writes=f.writes(),before=probeCalls;
    for(const purpose of ['preview','export'] as const){
      const report=await f.check({purpose});assert.equal(report.status,'ready');assert.equal(report.checks.bytesHashed,f.bytes.length);assert.equal(f.writes(),(writes! as number)+(purpose==='export'?2:0));
      const raw=(createOpacityCandidateDomain(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityDomain).readPreflightSnapshot(f.input({purpose})).snapshot;
      assert.ok(raw!.timeline.clips[0].opacityEnvelope);assert.ok(raw!.opacityPlan);assert.equal(report.snapshotHash,timelineSnapshotHash(raw));
      const result=await f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose,preflightSnapshotHash:report.snapshotHash});
      assert.equal(result.status,'queued');assert.equal(timelineSnapshotHash(result.snapshot),report.snapshotHash);
    }
    assert.equal(probeCalls,before+2);
  });

  test('candidate missing, empty, stale and invalid-range reports stop before source probes',async t=>{
    const f=fixture(t),before=probeCalls,original=f.store.get('timelines',f.ids.timeline);
    assert.equal((await f.check({expectedRevision:2})).status,'stale');
    const range=await f.check({exportRange:{startFrame:0,endFrame:31}});assert.equal(range.issues[0].code,'EXPORT_RANGE_BOUNDS');assert.equal(range.snapshotHash,null);
    f.store.put('timelines',{...original,clips:[],durationFrames:0});assert.equal((await f.check()).issues[0].code,'EMPTY_TIMELINE');
    f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(f.ids.timeline);assert.equal((await f.check()).issues[0].code,'TIMELINE_MISSING');assert.equal(probeCalls,before);
  });

  test('invalid curves and unsupported preview delivery cannot reach source preparation',async t=>{
    const f=fixture(t),before=probeCalls,original=f.store.get('timelines',f.ids.timeline);
    const corrupt={...original,clips:[{...original!.clips[0],opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:2}]}}]};
    f.store.put('timelines',corrupt);const report=await f.check();assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'INVALID_TIMELINE_SNAPSHOT');
    await assert.rejects(f.check({purpose:'preview',exportRange:{startFrame:0,endFrame:1}}));assert.equal(probeCalls,before);
  });

  test('owned LUT binding refusal preserves the actual enqueue reason before any source probe',async t=>{
    const f=fixture(t),before=probeCalls,timeline=f.store.get('timelines',f.ids.timeline),asset=f.store.get('assets',f.ids.asset);
    timeline!.clips[0].colour={profileId:'mioon-rec709-sdr-clip-v1',
      source:{assetSha256:asset!.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},
      look:{resourceId:randomUUID(),resourceSha256:'c'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
    f.store.put('timelines',timeline!);const report=await f.check();assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'TIMELINE_COLOUR_LOOK_UNAVAILABLE');
    await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export'}),{code:'TIMELINE_COLOUR_LOOK_UNAVAILABLE'});assert.equal(probeCalls,before);
  });

  test('saved source duration and fade refusals share the actual render admission code',async t=>{
    const f=fixture(t),before=probeCalls,asset=f.store.get('assets',f.ids.asset),timeline=f.store.get('timelines',f.ids.timeline);
    f.store.put('assets',{...asset,duration:.5});assert.equal((await f.check()).issues[0].code,'SOURCE_BOUNDS');
    await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export'}),{code:'SOURCE_BOUNDS'});
    f.store.put('assets',asset!);f.store.put('timelines',{...timeline,clips:[{...timeline!.clips[0],fadeInFrames:1}]});
    assert.equal((await f.check()).issues[0].code,'FADE_AUDIO_UNSUPPORTED');
    await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export'}),{code:'FADE_AUDIO_UNSUPPORTED'});assert.equal(probeCalls,before);
  });

  test('actual source hash and inode changes report sanitized blocking reasons and never ready',async t=>{
    const f=fixture(t),file=path.join(f.root,'media/source.mp4');behavior=async()=>{writeFileSync(file,Buffer.from('different secret source'));};
    const report=await f.check();assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'PREFLIGHT_SOURCE_CHANGED');assert.equal(report.issues[0].assetId,f.ids.asset);assert.ok(!JSON.stringify(report).includes('secret'));assert.ok(!JSON.stringify(report).includes(f.root));
  });

  test('earlier source replacement during the second probe is caught by the all-assets final identity fence',async t=>{
    const f=fixture(t),secondId=randomUUID(),first=f.store.get('assets',f.ids.asset),timeline=f.store.get('timelines',f.ids.timeline);
    writeFileSync(path.join(f.root,'media/second.mp4'),f.bytes);f.store.put('assets',{...first,id:secondId,relativePath:'media/second.mp4'});
    f.store.put('timelines',{...timeline,clips:[...timeline!.clips,{...timeline!.clips[0],id:randomUUID(),assetId:secondId,startFrame:30}],durationFrames:60});
    let calls=0;behavior=async()=>{if(++calls===2){const replacement=path.join(f.root,'media/replacement.mp4');writeFileSync(replacement,f.bytes);renameSync(replacement,path.join(f.root,'media/source.mp4'));}};
    const report=await f.check();assert.equal(calls,2);assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'PREFLIGHT_SOURCE_CHANGED');
  });

  test('raw curve or source metadata drift during await invalidates the exact preflight digest',async t=>{
    const f=fixture(t);behavior=async()=>{const timeline=f.store.get('timelines',f.ids.timeline);(timeline!.clips[0].opacityEnvelope!.points[0] as unknown as {opacity:number}).opacity=.25;f.store.put('timelines',timeline!);};
    const report=await f.check();assert.equal(report.status,'stale');assert.equal(report.issues[0].code,'PREFLIGHT_STALE');
    await assert.rejects(f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'export',preflightSnapshotHash:report.snapshotHash}),{code:'PREFLIGHT_STALE'});
  });

  test('candidate shares budget, busy admission, caller deadline and exact outstanding preparation ownership',async t=>{
    const f=fixture(t),assembly=(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null),gate=deferred(),entered=deferred();
    const limited=createTimelinePreflightServices(f.store,{limits:{...EXPORT_PREFLIGHT_LIMITS,sourceBytes:1}});
    const invoke=(service: ReturnType<typeof createTimelinePreflightServices>,input=f.input())=>assembly!.withInvocation('timeline.export.preflight',input,{},frozen=>service.handlers['timeline.export.preflight'](frozen));
    assert.equal((await invoke(limited)).issues[0].code,'PREFLIGHT_BUDGET');await limited.drain();
    behavior=async()=>{entered.resolve!();await gate.promise;};
    const bounded=createTimelinePreflightServices(f.store);let pending;
    t.mock.timers.enable({apis:['setTimeout']});
    try{pending=invoke(bounded);await entered.promise;assert.equal((await invoke(bounded)).issues[0].code,'PREFLIGHT_BUSY');
      t.mock.timers.tick(EXPORT_PREFLIGHT_LIMITS.timeoutMs);
      const report=await pending;assert.equal(report.status,'incomplete');assert.equal(report.issues[0].code,'PREFLIGHT_TIMEOUT');
      assert.equal((await invoke(bounded)).issues[0].code,'PREFLIGHT_BUSY');gate.resolve!();
    }finally{gate.resolve!();t.mock.timers.reset();await pending?.catch(()=>{});await bounded.drain();}
  });

  test('candidate helper requires an exact privately read snapshot and live fixed invocation regardless of callbacks',async t=>{
    const f=fixture(t),assembly=(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null),helper=createOpacityCandidatePreflightRuntime(f.store),input=f.input();
    const denied=(error: { code: string; })=>['RESTORE_OPERATION_UNAVAILABLE','INVALID_TIMELINE_SNAPSHOT'].includes((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code);
    assert.throws(()=>helper!.readSnapshot(input),denied);
    const initial=assembly!.withInvocation('timeline.export.preflight',input,{},()=>helper!.readSnapshot(input));
    let probes=0;const options={budget:{sourceBytes:1e6,totalBytes:1e6,bytesHashed:0},beforeEffect(){},onChecked(){},probe(){probes++;throw Error('No codec should be reached');}};
    await assert.rejects(helper!.prepare(initial,input,options),denied);
    await assert.rejects(assembly!.withInvocation('timeline.export.preflight',input,{},()=>helper!.prepare(initial,input,options)),denied);
    await assert.rejects(assembly!.withInvocation('timeline.export.preflight',input,{},()=>helper!.prepare(structuredClone(initial),input,options)),denied);
    assert.throws(()=>helper!.assertPrepared(initial,input,new Map(),()=>{}),denied);assert.equal(probes,0);
    assert.equal(createOpacityCandidatePreflightRuntime({...f.store}),null);
  });

  test('restored43 preflight requires explicit current origin and preserves held records and read-only tables',async t=>{
    const f=fixture(t),old=await f.services.call('timeline.render',{...f.input(),requestId:randomUUID(),purpose:'preview'}),metadata=await f.restore(),before=probeCalls;
    const holds=f.store.db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all(),rows=f.store.db.prepare('SELECT * FROM exports').all(),writes=f.writes();
    await assert.rejects(f.check(),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
    await assert.rejects(f.check({}, {expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
    const report=await f.check({purpose:'preview'},{expectedWorkspaceOrigin:metadata.workspaceOrigin});assert.equal(report.status,'ready');assert.equal(probeCalls,before+1);assert.equal(f.writes(),writes);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all(),holds);assert.deepEqual(f.store.db.prepare('SELECT * FROM exports').all(),rows);assert.equal(f.store.get('exports',old.id)!.status,'queued');
  });

  test('caller cancellation revokes the read invocation while drain waits for its exact codec await',async t=>{
    const f=fixture(t),gate=deferred(),entered=deferred(),controller=new AbortController();behavior=async()=>{entered.resolve!();await gate.promise;};
    const pending=f.check({}, {signal:controller.signal}),rejected=assert.rejects(pending,error=>['OPERATION_CANCELLED','RESTORE_OPERATION_UNAVAILABLE'].includes((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code));
    await entered.promise;controller.abort();await rejected;
    let drained=false;const draining=f.services.drain().then(()=>{drained=true;});await tick();assert.equal(drained,false);gate.resolve!();await draining;assert.equal(drained,true);
    assert.deepEqual(readFileSync(path.join(f.root,'media/source.mp4')),f.bytes);
  });

  test('initial and final coherent reads preserve candidate invocation revocation instead of returning invalid or stale reports',async t=>{
    for(const target of [1,2] as const){
      const f=fixture(t),controller=new AbortController(),prepare=f.store.db.prepare.bind(f.store.db);let reads=0;
      const patched=t.mock.method(f.store.db,'prepare',(function(this:typeof f.store.db,sql: Parameters<typeof f.store.db.prepare>[0]){
        if(sql.includes('FROM timelines WHERE projectId=')&&++reads===target)controller.abort();return prepare(sql);
      } as unknown as typeof f.store.db.prepare));
      try{await assert.rejects(f.check({}, {signal:controller.signal}),{code:'RESTORE_OPERATION_UNAVAILABLE'});assert.equal(reads,target);}
      finally{patched.mock.restore();}
    }
  });

  test('genuine store root revocation during initial or final read remains an authority failure through bounded drain',{timeout:10000},async t=>{
    for(const target of [1,2] as const){
      const f=fixture(t),prepare=f.store.db.prepare.bind(f.store.db);let reads=0;
      const patched=t.mock.method(f.store.db,'prepare',(function(this:typeof f.store.db,sql: Parameters<typeof f.store.db.prepare>[0]){
        const statement=prepare(sql);
        if(sql.includes('FROM timelines WHERE projectId=')&&++reads===target)(f.store as unknown as {root:string}).root=path.join(f.root,'revoked-root');
        return statement;
      } as unknown as typeof f.store.db.prepare));
      try{
        await assert.rejects(f.check(),{code:'RESTORE_STORE_UNVERIFIED'});assert.equal(reads,target);
        assert.throws(()=>(getOpacityCandidateAssembly(f.store) as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityAssembly|null),{code:'RESTORE_STORE_UNVERIFIED'});
      }finally{patched.mock.restore();await f.services.drain();}
    }
  });
}
