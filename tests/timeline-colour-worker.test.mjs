import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeFileSync,renameSync,statSync,utimesSync,openSync,writeSync,closeSync} from 'node:fs';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {startWorker} from '../packages/business/src/jobs.mjs';
import {run} from '../packages/business/src/media-runtime.mjs';
import {probe} from '../packages/business/src/media.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {prepareTimelineInputs,probeTimelineSource,readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.mjs';
import {createTimelineColourLutReader} from '../packages/business/src/timeline-colour-lut.ts';
const text='LUT_3D_SIZE 2\n0 0 0\n0 1 0\n1 0 0\n1 1 0\n0 0 1\n0 1 1\n1 0 1\n1 1 1\n';
async function fixture(t){
 const base=await mkdtemp(path.join(tmpdir(),'mioon-colour-worker-')),root=path.join(base,'workspace'),source=path.join(base,'source.mp4');
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=red:s=64x48:r=30:d=1','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',source],{timeout:30000,maxStdoutBytes:0});
 const store=openStore(root),services=createServices(store,new Map());let worker,closed=false;
 const close=async()=>{if(closed)return;await worker?.stop();await services.drain();store.close();closed=true;};
 t.after(async()=>{await close();await rm(base,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'SDR worker'}),asset=await services.call('asset.import',{projectId:project.id,name:'SDR source.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
 const observation=await services.call('timeline.colour.source.inspect',{projectId:project.id,assetId:asset.id});assert.equal(observation.status,'compatible');assert.equal(observation.evidence.range,'limited');
 const imported=await services.call('lut.import',{projectId:project.id,requestId:randomUUID(),name:'Swap red and green.cube',dataBase64:Buffer.from(text).toString('base64')});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:12});
 const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{profileId:'rec709-yuv-sdr-v1',assetSha256:asset.sha256,streamIndex:observation.streamIndex,range:'limited',declaredBy:'user',declaredAt:new Date().toISOString()},
  look:{resourceId:imported.resource.id,resourceSha256:imported.resource.sha256,resourceProfile:imported.resource.profile,purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}};
 timeline=await services.call('timeline.clip.update',{projectId:project.id,clipId:timeline.clips[0].id,expectedRevision:timeline.revision,requestId:randomUUID(),patch:{colour}});
 const render=purpose=>services.call('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose});
 return {base,root,store,services,asset,imported,project,timeline,render,close,start(){return worker??=startWorker(store,services,new Map());}};
}
test('real accepted LUT job uses exact frozen receipt, preflight, shared worker and artifact verification',{timeout:120000},async t=>{
 const f=await fixture(t),preflight=await f.services.call('timeline.export.preflight',{projectId:f.project.id,expectedRevision:f.timeline.revision});assert.equal(preflight.status,'ready',JSON.stringify(preflight));
 const preview=await f.render('preview'),exported=await f.render('export');assert.deepEqual(preview.snapshot.colourPlan,exported.snapshot.colourPlan);
 const worker=f.start();await worker.tick();
 for(const accepted of [preview,exported]){const final=await f.services.call('export.get',{exportId:accepted.id});assert.equal(final.status,'succeeded',JSON.stringify(final.error));assert.deepEqual(final.snapshot,accepted.snapshot);
  const asset=f.store.get('assets',final.assetId),info=await probe(path.join(f.root,asset.relativePath)),v=info.probe.streams.find(s=>s.codec_type==='video');assert.equal(v.color_range,'tv');assert.equal(v.color_primaries,'bt709');assert.equal(v.color_transfer,'bt709');assert.equal(v.color_space,'bt709');assert.equal(Number(v.nb_frames),12);
 }
 assert.equal((await readdir(path.join(f.root,'media'))).filter(name=>name.startsWith('.timeline-render-')).length,0);
});
test('stripping colour identity cannot downgrade a queued receipt to an ungraded legacy render',{timeout:90000},async t=>{
 const f=await fixture(t),accepted=await f.render('export'),changed=structuredClone(accepted);delete changed.snapshot.colourPlan;delete changed.snapshot.timeline.clips[0].colour;
 f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');f.store.put('exports',changed);const worker=f.start();await worker.tick();
 assert.equal(f.store.get('exports',accepted.id).status,'queued');assert.equal(f.store.list('assets',f.project.id).length,1);
});
test('resource corruption blocks actual job and cannot publish an ungraded success',{timeout:90000},async t=>{
 const f=await fixture(t),accepted=await f.render('export');f.store.db.exec('DROP TRIGGER immutable_project_lut_resources');
 f.store.db.prepare('UPDATE project_lut_resources SET content=? WHERE id=?').run(Buffer.from(text.replace('0 0 0','1 1 1')),f.imported.resource.id);
 const worker=f.start();await worker.tick();const final=f.store.get('exports',accepted.id);assert.equal(final.status,'failed');assert.equal(final.assetId,null);assert.equal(f.store.list('assets',f.project.id).length,1);
});
for(const phase of ['capability','prepublication'])test(`physical source replacement at ${phase} prevents managed-colour publication`,{timeout:90000},async t=>{
 const f=await fixture(t),accepted=await f.render('export'),source=path.join(f.root,f.store.get('assets',f.asset.id).relativePath),original=await readFile(source);let replaced=false,probeCount=0,observerError,after;
 utimesSync(source,1700000000,1700000000);const before=statSync(source);
 const off=onMediaProcess(event=>{
  if(replaced)return;
  if(event.type==='exited'&&event.kind==='ffprobe')probeCount++;
  if(phase==='capability'&&event.type==='started'&&event.kind==='ffmpeg'||phase==='prepublication'&&event.type==='exited'&&event.kind==='ffprobe'&&probeCount===3){
   try{
    if(phase==='capability'){const replacement=source+'.new';writeFileSync(replacement,original,{flag:'wx',mode:0o600});renameSync(replacement,source);}
    else{const fd=openSync(source,'r+');try{writeSync(fd,Buffer.from([original[0]^1]),0,1,0);}finally{closeSync(fd);}utimesSync(source,1700000000,1700000000);}
    after=statSync(source);replaced=true;
   }catch(error){observerError=error;}
  }
 });
 try{await f.start().tick();}finally{off();}
 assert.equal(observerError,undefined);assert.equal(replaced,true);const final=f.store.get('exports',accepted.id);assert.equal(final.status,'failed');assert.equal(final.error.code,'TIMELINE_SOURCE_UNAVAILABLE');assert.equal(final.assetId,null);assert.equal(f.store.list('assets',f.project.id).length,1);
 if(phase==='capability')assert.deepEqual(await readFile(source),original,'fixture replacement is preserved, never repaired/deleted');
 else{assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.notEqual(after.ctimeMs,before.ctimeMs);assert.equal((await readFile(source))[0],original[0]^1,'changed source is preserved, never repaired');}
});
test('cold backup32 restore33 retains exact LUT and source interpretation and explicitly rerenders',{timeout:120000},async t=>{
 const f=await fixture(t);await f.close();const backup=path.join(f.base,'backup'),restored=path.join(f.base,'restored');
 await createWorkspaceBackup({source:f.root,destination:backup});const installed=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(installed.databaseSchemaVersion,33);
 const store=openStore(restored),services=createServices(store,new Map()),context={expectedWorkspaceOrigin:getWorkspaceRestoreContext(store).workspaceOrigin};let worker;
 try{
  const timeline=await services.call('timeline.get',{projectId:f.project.id});assert.deepEqual(timeline.clips[0].colour,f.timeline.clips[0].colour);
  const lut=await services.call('lut.inspect',{projectId:f.project.id,lutId:f.imported.resource.id});assert.deepEqual(lut.resource,f.imported.resource);
  await assert.rejects(services.call('timeline.colour.source.inspect',{projectId:f.project.id,assetId:f.asset.id},context),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  const accepted=await services.call('timeline.render',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'},context);
  worker=startWorker(store,services,new Map());await worker.tick();const final=await services.call('export.get',{exportId:accepted.id});assert.equal(final.status,'succeeded',JSON.stringify(final.error));
  const output=store.get('assets',final.assetId),media=await probe(path.join(restored,output.relativePath));assert.equal(media.probe.streams.find(s=>s.codec_type==='video').color_range,'tv');
  const replacement=await services.call('asset.import',{projectId:f.project.id,name:'Replacement.mp4',mimeType:'video/mp4',dataBase64:(await readFile(path.join(restored,store.get('assets',f.asset.id).relativePath))).toString('base64')},context);
  const changed=await services.call('timeline.clip.replaceSource',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0].id,assetId:replacement.id},context);
  assert.deepEqual(changed.clips[0].colour,{...timeline.clips[0].colour,source:null});
  let processCount=0;const off=onMediaProcess(event=>{if(event.type==='started')processCount++;});
  try{await assert.rejects(services.call('timeline.render',{projectId:f.project.id,expectedRevision:changed.revision,requestId:randomUUID(),purpose:'export'},context),{code:'INVALID_TIMELINE_COLOUR'});}finally{off();}
  assert.equal(processCount,0,'invalidated interpretation cannot initiate implicit inspection');
  const undone=await services.call('timeline.undo',{projectId:f.project.id,expectedRevision:changed.revision,requestId:randomUUID()},context);assert.deepEqual(undone.clips[0],timeline.clips[0]);
 }finally{await worker?.stop();await services.drain();store.close();}
});
test('an earlier source changing during later-source preparation is rejected before rendering',{timeout:90000},async t=>{
 const f=await fixture(t),first=path.join(f.root,f.store.get('assets',f.asset.id).relativePath),bytes=await readFile(first);
 const second=await f.services.call('asset.import',{projectId:f.project.id,name:'Second.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
 const saved=await f.services.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),assetId:second.id,trackId:f.timeline.tracks[0].id,startFrame:12,durationFrames:12,colour:structuredClone(f.timeline.clips[0].colour)});
 const accepted=await f.services.call('timeline.render',{projectId:f.project.id,expectedRevision:saved.revision,requestId:randomUUID(),purpose:'export'}),secondPath=path.join(f.root,f.store.get('assets',second.id).relativePath);let changed=false;
 await assert.rejects(prepareTimelineInputs(accepted.snapshot,{root:f.root,projectId:f.project.id,readAsset:id=>readOwnedTimelineAsset(f.store.db,f.project.id,id),readLut:createTimelineColourLutReader(f.store.db,f.project.id),probe:async(file,options)=>{
  const media=await probeTimelineSource(file,options);if(file===secondPath){const temporary=first+'.new';writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});renameSync(temporary,first);changed=true;}return media;
 }}),{code:'MANAGED_SOURCE_CHANGED'});assert.equal(changed,true);
});
