import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openOpacityCandidateStore, getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createServices} from '../packages/business/src/services.mjs';
import {createTimelineServices} from '../packages/business/src/timeline.mjs';
import {createTimelineExportAdmissionServices} from '../packages/business/src/timeline-export-admission.mjs';
import {isOpacityRenderRecord} from '../packages/contracts/src/timeline-opacity-render-candidate.ts';
import {resolveTimelineExportDelivery} from '../packages/contracts/src/index.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';

const stamp='2026-10-16T00:00:00.000Z';
const curve=()=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]});
const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex');
function fixture(t, fields={opacityEnvelope:curve()}) {
  const root=mkdtempSync(path.join('/private/tmp','mioon-opacity-render-admission-'));
  const ids=Object.fromEntries(['project','asset','timeline','track','clip'].map(key=>[key,randomUUID()]));
  const data={project:{id:ids.project,name:'Synthetic candidate render',revision:1,createdAt:stamp,updatedAt:stamp},
    asset:{id:ids.asset,projectId:ids.project,name:'Synthetic metadata only',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:true,sha256:'a'.repeat(64),relativePath:'media/never-opened.mp4',createdAt:stamp}};
  data.timeline={id:ids.timeline,projectId:ids.project,revision:1,fps:30,width:720,height:1280,tracks:[{id:ids.track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:ids.clip,trackId:ids.track,assetId:ids.asset,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...fields}],durationFrames:30,createdAt:stamp,updatedAt:stamp};
  let store, services, providers=0;
  const media=[],off=onMediaProcess(event=>media.push(event));
  function open(){store=openOpacityCandidateStore(root);services=createServices(store,new Proxy(new Map(),{get(){providers++;throw Error('No candidate provider access');}}));}
  open();store.put('projects',data.project);store.put('assets',data.asset);store.put('timelines',data.timeline);
  const f={root,ids,data,get store(){return store;},get services(){return services;},
    input(purpose='preview'){return {projectId:ids.project,requestId:randomUUID(),expectedRevision:1,purpose};},
    async close(){await services.drain();store.close();},
    async reopen(){await f.close();open();},open,
  };
  t.after(async()=>{try{await f.close();assert.equal(providers,0);assert.deepEqual(media,[]);}finally{off();rmSync(root,{recursive:true,force:true});}});
  return f;
}
const contents=store=>JSON.stringify(['exports','timeline_requests','workspace_restore_export_origins'].filter(name=>store.db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name)).map(name=>[name,store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

test('actual candidate services persist raw planned preview/export ACKs and replay exact receipts after reopen',async t=>{
  const f=fixture(t);
  for(const purpose of ['preview','export']) {
    const input=f.input(purpose),result=await f.services.call('timeline.render',input);
    assert.equal(isOpacityRenderRecord(result,input),true);
    assert.deepEqual(result.snapshot.timeline.clips[0].opacityEnvelope,curve());
    assert.equal(result.snapshot.opacityPlan.profileId,'mioon-clip-opacity-render-v1');
    assert.equal(result.snapshot.opacityPlan.clips[0].assetSha256,f.data.asset.sha256);
    assert.deepEqual(f.store.get('exports',result.id),result);
    assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,JSON.stringify(result));
    assert.equal(f.store.db.isTransaction,false);
    const before=contents(f.store);assert.deepEqual(await f.services.call('timeline.render',input),result);assert.equal(contents(f.store),before);
    await f.reopen();assert.deepEqual(await f.services.call('timeline.render',input),result);
  }
});

test('candidate render preserves absent/null fields and refuses stale preflight before writes or media',async t=>{
  for(const fields of [{},{opacityEnvelope:null}]) {
    const f=fixture(t,fields),input=f.input(),result=await f.services.call('timeline.render',input);
    assert.equal(Object.hasOwn(result.snapshot.timeline.clips[0],'opacityEnvelope'),Object.hasOwn(fields,'opacityEnvelope'));
    assert.equal(Object.hasOwn(result.snapshot,'opacityPlan'),false);
    const before=contents(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
    await assert.rejects(f.services.call('timeline.render',{...f.input(),preflightSnapshotHash:'b'.repeat(64)}),{code:'PREFLIGHT_STALE'});
    assert.equal(contents(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  }
});

test('render replay binds persisted export/rawsnapshot and current source identity',async t=>{
  const f=fixture(t),input=f.input(),result=await f.services.call('timeline.render',input);
  f.store.put('assets',{...f.data.asset,sha256:'b'.repeat(64)});
  await assert.rejects(f.services.call('timeline.render',input),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
  f.store.put('assets',f.data.asset);
  const changed=structuredClone(result);changed.snapshot.timeline.clips[0].opacityEnvelope.points[0].opacity=.5;
  assert.throws(()=>f.store.put('exports',changed),/timeline render snapshots are immutable/);
  assert.deepEqual(await f.services.call('timeline.render',input),result);
});

test('candidate custom delivery reuses two-phase existing admission and CAS around a pure bounded-check stand-in',async t=>{
  const f=fixture(t),assembly=getOpacityCandidateAssembly(f.store);
  const input={...f.input('export'),exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}},deliveryName:'Synthetic output',exportRange:{startFrame:5,endFrame:20}};
  let checks=0,capturedFence;
  const admission=createTimelineExportAdmissionServices(f.store,{hash,inspect:async(delivery,{beforeEffect})=>{
    checks++;capturedFence=beforeEffect;assert.equal(f.store.db.isTransaction,false);beforeEffect?.();assert.equal(delivery.exportSettings.profileId,'mp4_h264_v1');
    return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};
  }});
  t.after(()=>admission.drain());
  await assert.rejects(admission.inspect({},{}),{code:'RESTORE_OPERATION_UNAVAILABLE'});assert.equal(checks,0);
  const timeline=createTimelineServices(f.store,{required:(table,id)=>f.store.get(table,id),check:(record,revision)=>assert.equal(record.revision,revision),hash,now:()=>stamp,exportAdmission:admission});
  const run=()=>assembly.withInvocation('timeline.render',assembly.freezeInput(input),{},frozen=>timeline.handlers['timeline.render'](frozen));
  const result=await run();assert.equal(checks,1);assert.equal(isOpacityRenderRecord(result,input),true);
  assert.throws(()=>capturedFence(),{code:'RESTORE_OPERATION_UNAVAILABLE'},'completion revokes the registered admission fence');
  assert.deepEqual(result.snapshot.exportRange,input.exportRange);assert.equal(result.snapshot.deliveryName,input.deliveryName);
  assert.deepEqual(result.snapshot.timeline.clips[0].opacityEnvelope,curve());
  assert.deepEqual(await run(),result);assert.equal(checks,1,'exact ACK replay does not repeat capability inspection');
});

test('candidate delivery admission rechecks source metadata after await and commits no stale export or receipt',async t=>{
  const f=fixture(t),assembly=getOpacityCandidateAssembly(f.store),input={...f.input('export'),exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}};
  const admission=createTimelineExportAdmissionServices(f.store,{hash,inspect:async()=>{
    assert.equal(f.store.db.isTransaction,false);f.store.put('assets',{...f.data.asset,duration:2});
    return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};
  }});
  t.after(()=>admission.drain());
  const timeline=createTimelineServices(f.store,{required:(table,id)=>f.store.get(table,id),check:(record,revision)=>assert.equal(record.revision,revision),hash,now:()=>stamp,exportAdmission:admission});
  const before=contents(f.store);
  await assert.rejects(assembly.withInvocation('timeline.render',assembly.freezeInput(input),{},frozen=>timeline.handlers['timeline.render'](frozen)),{code:'EXPORT_CAPABILITY_STALE'});
  assert.equal(contents(f.store),before);assert.equal(f.store.db.isTransaction,false);
});

test('43 fresh render requires the exact origin and captured render receipts stay held',async t=>{
  const f=fixture(t),capturedInput=f.input(),captured=await f.services.call('timeline.render',capturedInput);
  await f.close();const info={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'c'.repeat(64),sourceDbHash:'d'.repeat(64),createdAt:stamp};
  const db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
  try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,info);}finally{db.close();}
  f.open();const input=f.input(),context={expectedWorkspaceOrigin:info.workspaceOrigin},before=contents(f.store);
  let forgedChecks=0;
  const guardedAdmission=createTimelineExportAdmissionServices(f.store,{hash,inspect:async()=>{forgedChecks++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};}});
  t.after(()=>guardedAdmission.drain());
  const delivery=resolveTimelineExportDelivery(f.data.timeline,{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}});
  await assert.rejects(guardedAdmission.inspect(delivery, {}, ()=>{}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(forgedChecks,0,'a caller callback cannot start the bounded checker or confer restored origin');
  await assert.rejects(f.services.call('timeline.render',input),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.services.call('timeline.render',input,{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  assert.ok(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(captured.id));
  await assert.rejects(f.services.call('timeline.render',capturedInput,context),error=>['RESTORED_RECORD_HELD','RESTORE_OPERATION_UNAVAILABLE'].includes(error.code));
  assert.equal(contents(f.store),before);
  const result=await f.services.call('timeline.render',input,context);
  assert.equal(isOpacityRenderRecord(result,input),true);
  const origin=f.store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(result.id);
  assert.equal(origin.workspaceOrigin,info.workspaceOrigin);assert.equal(origin.requestScope,'timeline.render');assert.equal(origin.requestId,input.requestId);
  assert.deepEqual(f.store.get('exports',captured.id),captured);
  assert.deepEqual(await f.services.call('timeline.render',input,context),result);
  await f.reopen();assert.deepEqual(await f.services.call('timeline.render',input,context),result);
});
