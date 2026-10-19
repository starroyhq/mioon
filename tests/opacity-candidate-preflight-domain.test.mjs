import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openOpacityCandidateStore, getOpacityCandidateAssembly, OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateDomain} from '../packages/business/src/opacity-candidate-domain.ts';
import {captureOpacityPreflightInput, captureOpacityCapabilitiesInput} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createServices} from '../packages/business/src/services.mjs';
import {timelineSnapshotHash} from '../packages/business/src/timeline-preflight.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {schemas} from '../packages/contracts/src/index.mjs';

const stamp='2026-10-16T00:00:00.000Z';
const curve=()=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]});
const denied=error=>['RESTORE_OPERATION_UNAVAILABLE','RESTORE_STORE_UNVERIFIED'].includes(error?.code);
function fixture(t) {
  const root=mkdtempSync('/private/tmp/mioon-opacity-preflight-domain-');
  const ids=Object.fromEntries(['project','asset','timeline','track','clip'].map(key=>[key,randomUUID()]));
  const data={project:{id:ids.project,name:'Synthetic preflight',revision:1,createdAt:stamp,updatedAt:stamp},
    asset:{id:ids.asset,projectId:ids.project,name:'Synthetic metadata only',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:false,
      sha256:'a'.repeat(64),relativePath:'media/never-created.mp4',createdAt:stamp}};
  data.timeline={id:ids.timeline,projectId:ids.project,revision:1,fps:30,width:720,height:1280,tracks:[{id:ids.track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:ids.clip,assetId:ids.asset,trackId:ids.track,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,opacityEnvelope:curve()}],durationFrames:30,createdAt:stamp,updatedAt:stamp};
  let store,services;const media=[],off=onMediaProcess(event=>media.push(event));
  const open=()=>{store=openOpacityCandidateStore(root);services=createServices(store,new Proxy(new Map(),{get(){throw Error('No provider access');}}));};open();
  store.put('projects',data.project);store.put('assets',data.asset);store.put('timelines',data.timeline);
  const f={ids,data,root,get store(){return store;},get services(){return services;},
    input(extra={}){return {projectId:ids.project,expectedRevision:1,...extra};},
    domain(){return createOpacityCandidateDomain(store);},
    async close(){await services.drain();store.close();},
    async restore(){await f.close();const info={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'c'.repeat(64),sourceDbHash:'d'.repeat(64),createdAt:stamp};
      const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{db.exec('PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,info);}finally{db.close();}open();return info;},
  };
  t.after(async()=>{try{await f.close();assert.deepEqual(media,[]);}finally{off();rmSync(root,{recursive:true,force:true});}});return f;
}
const contents=store=>JSON.stringify(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

test('candidate-only preflight grammar retains historical public schema and applies preview render restrictions',()=>{
  const input={projectId:randomUUID(),expectedRevision:1};
  assert.deepEqual(captureOpacityPreflightInput(input),input);
  assert.deepEqual(captureOpacityPreflightInput({...input,purpose:'preview'}),{...input,purpose:'preview'});
  assert.equal(schemas['timeline.export.preflight'].safeParse({...input,purpose:'preview'}).success,false);
  for(const extra of [{requestId:'forbidden'},{preflightSnapshotHash:'a'.repeat(64)},{purpose:'other'},{purpose:'preview',deliveryName:'Not preview'},
    {purpose:'preview',exportRange:{startFrame:0,endFrame:1}},{purpose:'preview',exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}}])
    assert.throws(()=>captureOpacityPreflightInput({...input,...extra}),{code:'INVALID_OPACITY_RENDER_CANDIDATE'});
  let reads=0;assert.throws(()=>captureOpacityPreflightInput(Object.defineProperty({...input},'purpose',{enumerable:true,get(){reads++;return 'preview';}})));
  assert.equal(reads,0);
  const capability={...input,exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}};
  assert.deepEqual(captureOpacityCapabilitiesInput(capability),capability);
  for(const extra of [{purpose:'export'},{requestId:'forbidden'},{preflightSnapshotHash:'a'.repeat(64)},{deliveryName:'forbidden'}])
    assert.throws(()=>captureOpacityCapabilitiesInput({...capability,...extra}),{code:'INVALID_OPACITY_RENDER_CANDIDATE'});
});

test('actual owned reads produce the same raw opacity snapshot hash as preview/export acceptance and no writes',async t=>{
  const f=fixture(t),domain=f.domain(),before=contents(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const selected={purpose:'export',deliveryName:'Synthetic output',exportRange:{startFrame:5,endFrame:20},exportSettings:{profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}}};
  for(const extra of [{},{purpose:'preview'},selected]) {
    const input=f.input(extra),result=domain.readPreflightSnapshot(input),reader=domain.boundary(input);
    const frozen=domain.freezeRenderSnapshot(result.timeline,reader.sources(result.timeline),input.exportSettings,{...input,purpose:input.purpose??'export'});
    assert.deepEqual(result.snapshot,frozen);assert.equal(timelineSnapshotHash(result.snapshot),timelineSnapshotHash(frozen));
    assert.deepEqual(result.snapshot.timeline.clips[0].opacityEnvelope,curve());assert.ok(result.snapshot.opacityPlan);
    assert.equal(Object.hasOwn(result.legacyValidationSnapshot,'opacityPlan'),false);
    assert.equal(Object.hasOwn(result.legacyValidationSnapshot.timeline.clips[0],'opacityEnvelope'),false);
    assert.notEqual(timelineSnapshotHash(result.snapshot),timelineSnapshotHash(result.legacyValidationSnapshot));
    assert.equal(Object.isFrozen(result.snapshot.timeline.clips[0].opacityEnvelope.points),true);
    assert.equal(f.store.db.isTransaction,false);
  }
  assert.equal(contents(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  for(const purpose of ['preview','export']) {
    const report=domain.readPreflightSnapshot(f.input({purpose}));
    const accepted=await f.services.call('timeline.render',{...f.input({purpose}),requestId:randomUUID(),preflightSnapshotHash:timelineSnapshotHash(report.snapshot)});
    assert.deepEqual(accepted.snapshot,report.snapshot);
  }
});

test('raw opacity changes invalidate old digest without any render/receipt write; projection digest never authorizes',async t=>{
  const f=fixture(t),domain=f.domain(),report=domain.readPreflightSnapshot(f.input()),hash=timelineSnapshotHash(report.snapshot);
  const changed=structuredClone(f.data.timeline);changed.clips[0].opacityEnvelope.points[0].opacity=.5;f.store.put('timelines',changed);
  const before=contents(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  for(const digest of [hash,timelineSnapshotHash(report.legacyValidationSnapshot)])
    await assert.rejects(f.services.call('timeline.render',{...f.input({purpose:'preview'}),requestId:randomUUID(),preflightSnapshotHash:digest}),{code:'PREFLIGHT_STALE'});
  assert.equal(contents(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
});

test('bounded read rejects cross-project source ownership and exact LUT ownership before source IO',async t=>{
  const f=fixture(t),domain=f.domain();
  f.store.put('assets',{...f.data.asset,projectId:randomUUID()});
  assert.throws(()=>domain.readPreflightSnapshot(f.input()),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
  f.store.put('assets',f.data.asset);
  const modified=structuredClone(f.data.timeline);modified.clips[0].colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:f.data.asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},
    look:{resourceId:randomUUID(),resourceSha256:'b'.repeat(64),resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
  f.store.put('timelines',modified);
  assert.throws(()=>domain.readPreflightSnapshot(f.input()),{code:'TIMELINE_COLOUR_LOOK_UNAVAILABLE'});
  assert.equal(f.store.db.isTransaction,false);
});

test('actual reverse owner graph cannot disguise a generated version as a bare imported asset',t=>{
  const f=fixture(t),domain=f.domain(),otherProject=randomUUID();
  f.store.put('projects',{...f.data.project,id:otherProject});
  // The exact same asset still belongs to the requested project. Only its
  // reverse version owner is foreign; the fixed graph reader must detect it.
  const versionId=randomUUID(),jobId=randomUUID(),shotId=randomUUID();
  f.store.put('shots',{id:shotId,projectId:otherProject});
  f.store.put('jobs',{id:jobId,projectId:otherProject,shotId,versionId});
  f.store.put('versions',{id:versionId,projectId:otherProject,jobId,shotId,assetId:f.ids.asset});
  assert.throws(()=>domain.readPreflightSnapshot(f.input()),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
  assert.equal(f.store.db.isTransaction,false);
});

test('42 preflight invocation expires and never enters task/mutation authority; cancelled observer cannot start a check',async t=>{
  const f=fixture(t),assembly=getOpacityCandidateAssembly(f.store),input=f.input();let fence;
  assert.equal(OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes('timeline.export.preflight'),false);
  assert.equal(OPACITY_CANDIDATE_RESTORE_LOCAL_OPERATIONS.includes('timeline.export.capabilities'),false);
  assert.throws(()=>assembly.refuseOperation('timeline.export.preflight',input),denied);
  await assembly.withInvocation('timeline.export.preflight',input,{},async frozen=>{
    assembly.refuseOperation('timeline.export.preflight',frozen);fence=assembly.effectFence();assert.doesNotThrow(fence);
    assert.throws(()=>assembly.refuseOperation('timeline.render',{...input,requestId:randomUUID(),purpose:'preview'}),denied);
  });
  assert.throws(fence,denied);
  const controller=new AbortController();controller.abort();const before=contents(f.store);
  await assert.rejects(f.services.call('timeline.export.preflight',input,{signal:controller.signal}),denied);
  assert.equal(contents(f.store),before);
});

test('43 service preflight requires this origin and preserves captured exports/history/receipts',async t=>{
  const f=fixture(t),captured=await f.services.call('timeline.render',{...f.input(),purpose:'preview',requestId:randomUUID()}),info=await f.restore(),before=contents(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.services.call('timeline.export.preflight',f.input()),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.services.call('timeline.export.preflight',f.input(),{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  const report=await f.services.call('timeline.export.preflight',f.input(),{expectedWorkspaceOrigin:info.workspaceOrigin});
  assert.equal(report.status,'blocked');assert.equal(report.issues[0].code,'PREFLIGHT_SOURCE_INVALID');
  assert.ok(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(captured.id));
  assert.deepEqual(f.store.get('exports',captured.id),captured);assert.equal(contents(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
});
