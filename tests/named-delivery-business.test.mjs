import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS,isTimelineRenderRecord,isExportPreflightResponse} from '@mioon/contracts';
import {installCurrentWorkspaceRestoreSchema, openStore} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';
import {createTimelinePreflightServices,timelineSnapshotHash} from '../packages/business/src/timeline-preflight.mjs';
import {readTimelinePreflightSnapshot} from '../packages/business/src/timeline-sources.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {matchesRestoredExport,restoreExportIdentity} from '../packages/business/src/workspace-restore-exports.mjs';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';

const clone=value=>structuredClone(value),settings=()=>clone(TIMELINE_EXPORT_DEFAULT_SETTINGS);
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-named-delivery-'));let store=openStore(root),probes=0,inspect=async()=>{probes++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};},services=createServices(store,new Map(),{exportOptions:{inspect:(...args)=>inspect(...args)}});
 const f={root,get store(){return store;},get services(){return services;},get probes(){return probes;},setInspect(fn){inspect=fn;},input:()=>({projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'export'}),state:()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])),async restart({restore=false}={}){await services.drain();store.close();if(restore){f.metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()};const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{installCurrentWorkspaceRestoreSchema(db,f.metadata);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}f.context={expectedWorkspaceOrigin:f.metadata.workspaceOrigin};}store=openStore(root);services=createServices(store,new Map(),{exportOptions:{inspect:(...args)=>inspect(...args)}});}};
 f.project=await services.call('project.create',{name:'Original project'});f.timeline=await services.call('timeline.get',{projectId:f.project.id});
 const id=randomUUID(),bytes=Buffer.from('synthetic source bytes'),relativePath='media/source.mp4';await writeFile(path.join(root,relativePath),bytes);
 f.asset=store.put('assets',{id,projectId:f.project.id,name:'Video',mimeType:'video/mp4',sha256:createHash('sha256').update(bytes).digest('hex'),relativePath,width:720,height:1280,duration:1,hasAudio:false,sizeBytes:bytes.length,createdAt:new Date().toISOString()});
 f.timeline=await services.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),trackId:f.timeline.tracks[0].id,assetId:id,startFrame:0,durationFrames:30});
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}
async function fakeMedia(t,f){
 const binary=path.join(f.root,'synthetic-media.mjs'),old={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 const video={index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'30'},renderedVideo={...video,width:f.timeline.width,height:f.timeline.height},audio={index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2};
 await writeFile(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);if(args.includes('-show_streams')){const source=args.at(-1).endsWith('source.mp4');process.stdout.write(JSON.stringify({streams:source?[${JSON.stringify(video)}]:[${JSON.stringify(renderedVideo)},${JSON.stringify(audio)}],format:{duration:'1'}}));}else writeFileSync(args.at(-1),'synthetic rendered bytes',{flag:args.includes('-n')?'wx':'w'});\n`,{mode:0o700});
 process.env.MIOON_FFMPEG_PATH=binary;process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

test('fresh named title is independently frozen and hashed; exact replay survives rename, edit and restart',async t=>{
 for(const custom of [false,true])await t.test(custom?'custom encoding':'legacy encoding',async t=>{
  const f=await fixture(t),input={...f.input(),deliveryName:'  发布版 🎬  ',...(custom?{exportSettings:settings()}:{})},accepted=await f.services.call('timeline.render',input),wire=JSON.stringify(accepted),raw=f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);
  assert.equal(accepted.snapshot.deliveryName,input.deliveryName);assert.equal(Object.hasOwn(accepted.snapshot,'delivery'),custom);assert.equal(raw.requestHash,hash({operation:'timeline.render',input}));assert.equal(f.probes,custom?1:0);assert.ok(isTimelineRenderRecord(accepted,input));
  f.store.put('projects',{...f.project,name:'Renamed project',revision:f.project.revision+1});f.timeline=await f.services.call('timeline.track.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'});
  f.store.put('exports',{...f.store.get('exports',accepted.id),status:'failed',error:{code:'TEST_FAILED',message:'Synthetic previous output failure'},updatedAt:new Date().toISOString()});
  f.setInspect(async()=>{throw Error('Replay must not probe');});await f.restart();const before=f.state();
  assert.equal(JSON.stringify(await f.services.call('timeline.render',input)),wire);assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId),raw);assert.deepEqual(f.state(),before);
  for(const changed of [{...input,deliveryName:'Different'},Object.fromEntries(Object.entries(input).filter(([key])=>key!=='deliveryName'))])await assert.rejects(f.services.call('timeline.render',changed),error=>error.code==='IDEMPOTENCY_CONFLICT'&&!error.details?.mutationOutcome);
  assert.deepEqual(f.state(),before);assert.equal(f.store.list('exports').length,1);
  assert.ok((await f.services.call('timeline.format.get',{projectId:f.project.id})).blockedReasons.includes('EXPORT_HISTORY'));
 });
});

test('legacy unnamed receipts retain exact absent fields and bytes after later edits and restart',async t=>{
 const f=await fixture(t),input=f.input(),accepted=await f.services.call('timeline.render',input),wire=JSON.stringify(accepted),receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 assert.equal(Object.hasOwn(accepted.snapshot,'deliveryName'),false);assert.equal(Object.hasOwn(accepted.snapshot,'delivery'),false);
 f.store.put('projects',{...f.project,name:'Later name'});f.timeline=await f.services.call('timeline.track.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'});await f.restart();const before=f.state();
 assert.equal(JSON.stringify(await f.services.call('timeline.render',input)),wire);assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);assert.deepEqual(f.state(),before);assert.equal(f.probes,0);
 await assert.rejects(f.services.call('timeline.render',{...input,deliveryName:'Newly added'}),error=>error.code==='IDEMPOTENCY_CONFLICT');
});

test('name-aware preflight hash binds exact presence, does not probe capabilities, and rejects stale names',async t=>{
 const f=await fixture(t),preflight=createTimelinePreflightServices(f.store,{probe:async()=>({width:720,height:1280,duration:1,hasAudio:false,hasVideo:true,videoStreamIndex:0})});t.after(()=>preflight.drain());
 const i={projectId:f.project.id,expectedRevision:f.timeline.revision,deliveryName:'Version One'},before=f.state(),report=await preflight.handlers['timeline.export.preflight'](i);
 assert.equal(report.status,'ready');assert.ok(isExportPreflightResponse(report,i));assert.equal(report.summary.deliveryName,i.deliveryName);assert.equal(Object.hasOwn(report.summary,'delivery'),false);assert.deepEqual(f.state(),before);assert.equal(f.probes,0);
 assert.equal(report.snapshotHash,timelineSnapshotHash(readTimelinePreflightSnapshot(f.store,f.project.id,undefined,i).snapshot));
 const legacy=await preflight.handlers['timeline.export.preflight']({projectId:f.project.id,expectedRevision:f.timeline.revision});assert.notEqual(legacy.snapshotHash,report.snapshotHash);assert.equal(Object.hasOwn(legacy.summary,'deliveryName'),false);
 for(const fields of [{},{deliveryName:'Version Two'}])await assert.rejects(f.services.call('timeline.render',{...f.input(),...fields,preflightSnapshotHash:report.snapshotHash}),error=>error.code==='PREFLIGHT_STALE');
 const accepted=await f.services.call('timeline.render',{...f.input(),deliveryName:i.deliveryName,preflightSnapshotHash:report.snapshotHash});assert.equal(accepted.snapshot.deliveryName,i.deliveryName);assert.equal(f.probes,0);
});

test('corrupt or removed title-only identity on either row or immutable receipt never starts worker media',async t=>{
 for(const target of ['export changed','export removed','receipt changed','receipt removed','preview'])await t.test(target,async t=>{
  const f=await fixture(t),input={...f.input(),deliveryName:'Frozen'},accepted=await f.services.call('timeline.render',input);
  if(target.startsWith('receipt')){f.store.db.exec('DROP TRIGGER immutable_timeline_responses');const row=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId),value=JSON.parse(row.response);if(target.endsWith('removed'))delete value.snapshot.deliveryName;else value.snapshot.deliveryName='Changed';f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(value),input.requestId);}
  else{f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');const value=f.store.get('exports',accepted.id);if(target==='export removed')delete value.snapshot.deliveryName;else if(target==='preview')value.purpose='preview';else value.snapshot.deliveryName='Changed';f.store.put('exports',value);}
  const before=f.state();let media=0;const off=onMediaProcess(()=>media++),worker=startWorker(f.store,f.services,new Map());try{await worker.tick();assert.equal(media,0);assert.deepEqual(f.state(),before);}finally{off();await worker.stop();}
  await assert.rejects(f.services.call('timeline.render',input),error=>['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE'].includes(error.code)&&!error.details?.mutationOutcome);assert.deepEqual(f.state(),before);
 });
});

test('normal SQLite mutation fences title-only exports and original receipt',async t=>{
 const f=await fixture(t),input={...f.input(),deliveryName:'Frozen'},r=await f.services.call('timeline.render',input),before=f.state();
 assert.throws(()=>f.store.put('exports',{...f.store.get('exports',r.id),snapshot:{...f.store.get('exports',r.id).snapshot,deliveryName:'Changed'}}),/immutable/);
 assert.throws(()=>f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('{}',input.requestId),/immutable/);assert.deepEqual(f.state(),before);
});

test('title-only render completes legacy encoding in normal and restored workspaces; held work stays held',async t=>{
 for(const restored of [false,true])await t.test(restored?'restored':'normal',async t=>{
  const f=await fixture(t);await fakeMedia(t,f);let held,heldTask;
  if(restored){
   held=await f.services.call('timeline.render',{...f.input(),deliveryName:'Captured delivery'});const tasks=createEditTasks({store:f.store,services:f.services});heldTask=tasks.prepare({projectId:f.project.id,operation:'timeline.track.add',input:{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'},origin:'new'});await tasks.drain();await f.restart({restore:true});
  }
  const heldRows=restored?JSON.stringify({export:f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(held.id),task:f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(heldTask.task.id)}):null;
  const input={...f.input(),deliveryName:'Current frozen title'},accepted=await f.services.call('timeline.render',input,f.context),receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  if(restored){const origin=f.store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(accepted.id);assert.equal(origin.requestHash,hash({operation:'timeline.render',input}));assert.equal(origin.identityHash,restoreExportIdentity(f.store.get('exports',accepted.id)));}
  const worker=startWorker(f.store,f.services,new Map());try{await worker.tick();}finally{await worker.stop();}
  const result=f.store.get('exports',accepted.id);assert.equal(result.status,'succeeded',JSON.stringify(result.error));assert.equal(result.snapshot.deliveryName,input.deliveryName);assert.equal(Object.hasOwn(result.snapshot,'delivery'),false);assert.equal(f.probes,0);assert.ok(result.assetId);assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);assert.deepEqual(await f.services.call('timeline.render',input),accepted);
  const rendered=f.store.get('assets',result.assetId);assert.deepEqual({width:rendered.width,height:rendered.height},{width:accepted.snapshot.timeline.width,height:accepted.snapshot.timeline.height});
  if(restored){assert.ok(matchesRestoredExport(f.store,result));assert.equal(JSON.stringify({export:f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(held.id),task:f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(heldTask.task.id)}),heldRows);}
 });
});
