import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {readdirSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,resolveTimelineExportDelivery,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

// Synthetic local assets only. Production renderer, decoder and probe are all
// the existing installed tools; tests are deliberately serial and resource-capped.
const profile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};
const selected=(resolution,rateControl={mode:'crf',quality:'standard'})=>({profileId:'mp4_h264_v1',resolution,rateControl});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function sandbox(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-export-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function wave(){
 const samples=3*48000,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
 bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
 for(let n=0;n<samples;n++)for(let channel=0;channel<2;channel++){
  const hz=n<24000?1700:channel?880:440;bytes.writeInt16LE(Math.round(7000*Math.sin(2*Math.PI*hz*n/48000)),44+n*4+channel*2);
 }
 return bytes;
}
async function binary(args,maxStdoutBytes){const chunks=[];const output=await runStreaming('ffmpeg',['-v','error','-threads','1',...args],{timeout:30000,maxStdoutBytes,maxStderrBytes:64*1024,onStdout:chunk=>{chunks.push(Buffer.from(chunk));}});return Buffer.concat(chunks,output.stdoutBytes);}
const pcm=file=>binary(['-i',file,'-vn','-ac','2','-ar','48000','-c:a','pcm_s16le','-f','s16le','pipe:1'],1024*1024);
async function frames(file,width,height){return binary(['-i',file,'-vf',"select='eq(n,24)+eq(n,25)+eq(n,29)+eq(n,30)+eq(n,34)+eq(n,35)',format=gray",'-fps_mode','passthrough','-frames:v','6','-an','-threads','1','-f','rawvideo','pipe:1'],width*height*6);}
// Downscale the native render through the delivered scale filter so caption
// bounds are compared with an actual post-scale reference; thresholded glyph
// pixels do not scale perfectly linearly at small output sizes.
async function scaledFrames(file,width,height,flags){return binary(['-i',file,'-vf',"select='eq(n,24)+eq(n,25)+eq(n,29)+eq(n,30)+eq(n,34)+eq(n,35)',scale="+width+":"+height+":flags="+flags+',format=gray','-fps_mode','passthrough','-frames:v','6','-an','-threads','1','-f','rawvideo','pipe:1'],width*height*6);}
function whiteBounds(bytes,width,height){
 let count=0,minX=width,minY=height,maxX=-1,maxY=-1;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(bytes[y*width+x]>170){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
 return {count,minX,minY,maxX,maxY};
}
function rms(bytes,from,to,channel=0){let sum=0;const first=Math.round(from*48000),last=Math.round(to*48000);for(let n=first;n<last;n++)sum+=(bytes.readInt16LE(n*4+channel*2)/32768)**2;return Math.sqrt(sum/(last-first));}
function tone(bytes,from,to,hz,channel=0){let real=0,imaginary=0;const first=Math.round(from*48000),last=Math.round(to*48000);for(let n=first;n<last;n++){const value=bytes.readInt16LE(n*4+channel*2)/32768,angle=2*Math.PI*hz*n/48000;real+=value*Math.cos(angle);imaginary+=value*Math.sin(angle);}return 2*Math.hypot(real,imaginary)/(last-first);}
function timeline(preset,audio,image){
 const tracks=[{id:randomUUID(),kind:'video',orderIndex:0,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:1,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:2,hidden:false,muted:true}];
 const rect={x:0,y:0,width:preset.width,height:preset.height},clip=(track,asset,options)=>({id:randomUUID(),trackId:tracks[track].id,assetId:asset.id,name:'synthetic',startFrame:0,durationFrames:60,sourceInFrame:0,rect,gain:1,...options});
 return {id:randomUUID(),projectId:randomUUID(),revision:1,fps:30,width:preset.width,height:preset.height,durationFrames:60,tracks,
  clips:[clip(0,image,{rect:{x:preset.width/4,y:preset.height/4,width:preset.width/2,height:preset.height/2}}),
   clip(1,audio,{startFrame:6,durationFrames:42,sourceInFrame:15,gain:.75,fadeInFrames:12,fadeOutFrames:12}),
   // A muted clip creates a segment edge inside the cue, without contributing
   // sound. The tail extends duration to include genuine post-audio silence.
   clip(2,audio,{startFrame:30,durationFrames:30})],
  subtitles:{profileId:profile.profileId,cues:[{id:randomUUID(),text:'你好，字幕\nExport 100%',startFrame:25,durationFrames:10}]},
  createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
}
async function assetsAt(root){
 const audioFile=path.join(root,'source.wav'),imageFile=path.join(root,'source.png');await writeFile(audioFile,wave());
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=red:s=64x64:r=30','-frames:v','1','-threads','1',imageFile],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 const audio={id:randomUUID(),mimeType:'audio/wav',path:audioFile,width:0,height:0,duration:3,hasVideo:false,hasAudio:true,audioStreamIndex:0};
 const image={id:randomUUID(),mimeType:'image/png',path:imageFile,width:64,height:64,duration:0,hasVideo:true,hasAudio:false,videoStreamIndex:0};
 return {audio,image,assets:new Map([[audio.id,audio],[image.id,image]])};
}
async function verifyOutput(file,width,height,frames=60){
 const output=await probe(file),streams=output.probe.streams,v=streams.find(stream=>stream.codec_type==='video'),a=streams.find(stream=>stream.codec_type==='audio');
 assert.equal(streams.length,2);assert.equal(v.codec_name,'h264');assert.equal(v.pix_fmt,'yuv420p');assert.equal(v.width,width);assert.equal(v.height,height);
 assert.equal(v.sample_aspect_ratio,'1:1');assert.equal(v.r_frame_rate,'30/1');assert.equal(v.avg_frame_rate,'30/1');assert.equal(v.time_base,'1/30000');assert.equal(v.has_b_frames,0);assert.equal(Number(v.nb_frames),frames);
 assert.equal(a.codec_name,'aac');assert.equal(a.sample_rate,'48000');assert.equal(a.channels,2);assert.equal(a.channel_layout,'stereo');assert.equal(a.time_base,'1/48000');
 assert.ok(Math.abs(Number(v.duration)-frames/30)<0.00001);assert.ok(Math.abs(Number(a.duration)-frames/30)<0.025);assert.ok(Math.abs(output.duration-frames/30)<.035);
 await run('ffmpeg',['-v','error','-threads','1','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 const counted=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',file],{timeout:30000,maxStdoutBytes:64*1024,maxStderrBytes:64*1024}));assert.equal(Number(counted.streams[0].nb_read_frames),frames);
}

test('all three timeline aspects deliver native/360/1080 with post-caption scale, exact frame boundaries and identical audio', {timeout:240000},async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),sourceHashes=[hash(await readFile(audio.path)),hash(await readFile(image.path))];
 let audioReference;
 for(const preset of TIMELINE_OUTPUT_PRESETS){
  const saved=timeline(preset,audio,image),snapshot={timeline:saved,subtitleProfile:profile},frozen=structuredClone(snapshot),legacy=path.join(root,`${preset.id}-legacy.mp4`);
  let nativeFile=null;
  const events=[],off=onMediaProcess(event=>events.push(event));
  try{await renderTimeline(snapshot,assets,legacy);}finally{off();}
  assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,6,'legacy has one subtitle measurement, four original segments, one final concat, and no capability probe');
  const legacyBytes=await readFile(legacy),legacyPcm=await pcm(legacy);
  if(audioReference)assert.deepEqual(legacyPcm,audioReference);else audioReference=legacyPcm;
  let nativeBounds;
  for(const [resolution,rateControl] of [['native',{mode:'crf',quality:'standard'}],['short_360',{mode:'crf',quality:'compact'}],['short_1080',{mode:'bitrate',targetKbps:4000}]]){
   const delivery=resolveTimelineExportDelivery(saved,selected(resolution,rateControl)),file=path.join(root,`${preset.id}-${resolution}.mp4`),explicit={...snapshot,delivery};
   await renderTimeline(explicit,assets,file);const {width,height}=delivery.effective;
   if(resolution==='native')nativeFile=file;
   await verifyOutput(file,width,height);
   assert.deepEqual(await pcm(file),legacyPcm,'delivery settings cannot change source trim, timeline clock, fades, gain, silence, stereo PCM or AAC');
   if(resolution==='native')assert.equal(hash(await readFile(file)),hash(legacyBytes),'explicit native/standard settings retain byte-identical default rendering');
   const pixels=await frames(file,width,height);assert.equal(pixels.length,width*height*6);
   const bounds=[];
   for(let frame=0;frame<6;frame++){
    const buffer=pixels.subarray(frame*width*height,(frame+1)*width*height),box=whiteBounds(buffer,width,height);bounds.push(box);
    if(frame===0||frame===5)assert.equal(box.count,0,'half-open global cue must be absent at frames 24 and 35');else assert.ok(box.count>30,'cue must be present at 25,29,30,34 across the segment edge');
    assert.ok(buffer[Math.floor(height/2)*width+Math.floor(width/2)]>40,'original composition rectangle remains in the scaled center');
    assert.ok(buffer[Math.floor(height/8)*width+Math.floor(width/8)]<8,'outside composition remains black');
   }
   if(resolution==='native')nativeBounds=bounds[1];
   else{
    const reference=await scaledFrames(nativeFile,width,height,delivery.effective.scaling);
    const referenceBox=whiteBounds(reference.subarray(width*height,2*width*height),width,height);
    for(const key of ['minX','minY','maxX','maxY'])assert.ok(Math.abs(bounds[1][key]-referenceBox[key])<=3,`${preset.id} ${resolution}: caption geometry must scale after composition (${key})`);
   }
   assert.deepEqual(snapshot,frozen);assert.deepEqual(explicit.delivery,delivery);
  }
 }
 // Independently verify the unchanged decoded envelope and source trim, rather
 // than relying solely on equality between outputs sharing an audio graph.
 assert.ok(rms(audioReference,.02,.15)<.002);assert.ok(rms(audioReference,1.75,1.95)<.002);
 const plateau=tone(audioReference,.7,.9,440),early=tone(audioReference,.25,.3,440),late=tone(audioReference,1.5,1.55,440);
 assert.ok(plateau>.13&&plateau<.19);assert.ok(early/plateau>.08&&early/plateau<.3);assert.ok(late/plateau>.08&&late/plateau<.3);
 assert.ok(tone(audioReference,.7,.9,1700)<.002,'nonzero sourceInFrame removes the source preamble');
 assert.ok(tone(audioReference,.7,.9,880,1)>.13);assert.ok(tone(audioReference,.7,.9,880,0)<.002);
 assert.deepEqual([hash(await readFile(audio.path)),hash(await readFile(image.path))],sourceHashes);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('remaining fixed quality/bitrate selections encode and malformed frozen delivery fails before media I/O', {timeout:90000},async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[2],audio,image);
 delete saved.subtitles;const snapshot={timeline:saved};
 for(const [index,rateControl] of [{mode:'crf',quality:'high'},{mode:'bitrate',targetKbps:2000},{mode:'bitrate',targetKbps:8000}].entries()){
  const delivery=resolveTimelineExportDelivery(saved,selected('short_360',rateControl)),file=path.join(root,`rate-${index}.mp4`);
  await renderTimeline({...snapshot,delivery},assets,file);await verifyOutput(file,360,360);
 }
 // A target bitrate controls encoder intent; short synthetic clips are not
 // expected to attain an exact average bitrate and no such claim is asserted.
 const good=resolveTimelineExportDelivery(saved,selected('native')),events=[],off=onMediaProcess(event=>events.push(event));
 try{
  for(const delivery of [null,undefined,{...good,effective:{...good.effective,width:good.effective.width+2}},{...good,effective:{...good.effective,rateControl:{mode:'crf',crf:0}}},{...good,effective:{...good.effective,extra:'-filter_complex'}}])
   await assert.rejects(renderTimeline({...snapshot,delivery},assets,path.join(root,'invalid.mp4')),{code:'INVALID_TIMELINE_SNAPSHOT'});
  assert.deepEqual(events,[]);assert.equal((await readdir(root)).includes('invalid.mp4'),false);
 }finally{off();}
});

test('cancellation during a selected-profile worker capability leaves no render scratch or destination',async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[0],audio,image),delivery=resolveTimelineExportDelivery(saved,selected('short_1080'));
 const controller=new AbortController(),events=[],off=onMediaProcess(event=>{events.push(event);if(event.type==='started')controller.abort();});
 try{await assert.rejects(renderTimeline({timeline:saved,subtitleProfile:profile,delivery},assets,path.join(root,'cancelled.mp4'),{signal:controller.signal}),{code:'MEDIA_CANCELLED'});}finally{off();}
 assert.equal(events.filter(event=>event.type==='started').length,1);assert.equal(events.filter(event=>event.type==='exited').length,1);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')||name==='cancelled.mp4'),false);
});

test('fresh worker capability is followed by the owner fence before any subtitle work, scratch or encoding',async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[0],audio,image),delivery=resolveTimelineExportDelivery(saved,selected('short_360'));
 const events=[],off=onMediaProcess(event=>events.push(event));let fenced=false;
 try{
  await assert.rejects(renderTimeline({timeline:saved,subtitleProfile:profile,delivery},assets,path.join(root,'stale.mp4'),{beforeEncode(){
   fenced=true;assert.equal(events.filter(event=>event.type==='started').length,2);assert.equal(events.filter(event=>event.type==='exited').length,2);
   throw Object.assign(Error('Saved export changed while capability was checked.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
  }}),{code:'INVALID_TIMELINE_SNAPSHOT'});
 }finally{off();}
 assert.equal(fenced,true);assert.equal(events.filter(event=>event.type==='started').length,2);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')||name==='stale.mp4'),false);
});

test('worker capability await cannot encode or overwrite a hostile replacement of the accepted delivery record',{timeout:30000},async t=>{
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace),services=createServices(store,new Map());let worker;
 try{
  const project=await services.call('project.create',{name:'Synthetic worker capability race'});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  const asset=await services.call('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find(track=>track.kind==='audio').id,assetId:asset.id,startFrame:0,durationFrames:30});
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('native')};
  const accepted=await services.call('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  // The production trigger prevents this write. Dropping only this trigger is
  // a hostile-corruption simulation to test the independent asynchronous fence.
  store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');
  let ffmpegStarts=0,replacement,observerFailure;const events=[];
  const off=onMediaProcess(event=>{
   events.push(event);
   if(event.type==='started'&&event.kind==='ffmpeg'&&++ffmpegStarts===2){
    try{replacement=store.get('exports',accepted.id);replacement.snapshot.delivery=resolveTimelineExportDelivery(replacement.snapshot.timeline,selected('short_360'));store.put('exports',replacement);}
    catch(error){observerFailure=error;}
   }
  });
  try{worker=startWorker(store,services,new Map());await worker.tick();}finally{off();}
  assert.equal(observerFailure,undefined);assert.ok(replacement,'record was replaced during the real selected-profile encode proof');
  assert.equal(ffmpegStarts,2,'worker stopped after listing + synthetic proof, before rendering');
  assert.deepEqual(store.get('exports',accepted.id),replacement,'failed owner fence cannot overwrite the newer persisted record');
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  assert.equal((await readdir(path.join(workspace,'media'))).some(name=>name.startsWith('.timeline-render-')||name.startsWith('export-')),false);
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
});

async function sourceOwnershipRace(t,{mutation,phase='capability'}){
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace),services=createServices(store,new Map());let worker;
 const state=()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='exports' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
 try{
  const project=await services.call('project.create',{name:'Synthetic frozen-source race'}),other=await services.call('project.create',{name:'Private foreign fixture'});
  const imported=await services.call('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  const asset={...store.get('assets',imported.id),provenance:'generated'};store.put('assets',asset);
  const shot=await services.call('shot.create',{projectId:project.id,title:'Synthetic retained lineage'}),foreignShot=await services.call('shot.create',{projectId:other.id,title:'Untouched foreign shot'});
  const jobId=randomUUID(),versionId=randomUUID(),sourceSnapshot={projectId:project.id,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
  store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot:sourceSnapshot});
  store.put('versions',{id:versionId,projectId:project.id,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1,snapshot:sourceSnapshot});
  store.put('shots',{...shot,selectedVersionId:versionId});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find(track=>track.kind==='audio').id,assetId:asset.id,startFrame:0,durationFrames:3});
  // Retained historical lineage is validated independently of the asset's
  // provenance label, including every version/job/shot reverse relation.
  Object.assign(timeline.clips[0],{versionId,jobId,shotId:shot.id});store.put('timelines',timeline);
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('short_360')};
  const accepted=await services.call('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  const acceptedSnapshot=store.get('exports',accepted.id).snapshot;
  const sourceFile=path.join(workspace,asset.relativePath),sourceHash=hash(await readFile(sourceFile)),files=(await readdir(path.join(workspace,'media'))).sort();
  // The normal version trigger rejects this corruption; remove only that
  // fixture-local protection when testing the independent retained-graph fence.
  if(mutation==='version-sql-owner')store.db.exec('DROP TRIGGER immutable_versions');
  let moved=false,afterMutation,observerFailure,ffmpegStarts=0,probeExits=0,publicationArmed=false,linkedBeforeTx=false,replacementFile,preservedFile,readUncertain=false,readFailureObserved=false;const events=[];
  const replacementBytes=Buffer.from('Different fixture-owned inode must be preserved.');
  const prepare=store.db.prepare;
  if(phase==='publication-read-unknown')t.mock.method(store.db,'prepare',function(sql,...args){
   if(readUncertain&&!store.db.isTransaction&&sql.includes('FROM exports WHERE id=?')){
    readUncertain=false;readFailureObserved=true;throw Error('Synthetic private cleanup-read failure.');
   }
   return prepare.call(this,sql,...args);
  });
  const patch=(table,id,values)=>store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({...store.get(table,id),...values}),id);
  const move=()=>{
   if(moved)return;moved=true;
   try{
    if(mutation==='asset-sql-owner')store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other.id,asset.id);
    else if(mutation==='asset-json-owner')patch('assets',asset.id,{projectId:other.id});
    else if(mutation==='version-sql-owner')store.db.prepare('UPDATE versions SET projectId=? WHERE id=?').run(other.id,versionId);
    else if(mutation==='job-lineage')patch('jobs',jobId,{shotId:foreignShot.id});
    else if(mutation==='shot-sql-owner')store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(other.id,shot.id);
    else if(mutation==='asset-hash')patch('assets',asset.id,{sha256:'b'.repeat(64)});
    else if(mutation==='asset-mime')patch('assets',asset.id,{mimeType:'audio/mp4'});
    else if(mutation==='asset-path')patch('assets',asset.id,{relativePath:'media/foreign-owned-unread.wav'});
    else throw Error('Unknown synthetic source race');
    afterMutation=state();
   }catch(error){observerFailure=error;}
  };
  const originalTx=store.tx;
  const publicationPhase=['publication-tx','publication-replacement','publication-read-unknown'].includes(phase);
  if(publicationPhase)store.tx=body=>{if(publicationArmed){
   publicationArmed=false;
   const linked=readdirSync(path.join(workspace,'media')).find(name=>name.startsWith(`export-${accepted.id}-`)&&name.endsWith('.mp4')&&!name.endsWith('.part.mp4'));
   linkedBeforeTx=Boolean(linked);
   if(linked&&phase==='publication-replacement'){
    replacementFile=path.join(workspace,'media',linked);
    // Create while the original inode is still live, then atomically replace
    // the name; this avoids accidental same-inode reuse in the fixture.
    const fresh=replacementFile+'.replacement';writeFileSync(fresh,replacementBytes,{flag:'wx',mode:0o600});renameSync(fresh,replacementFile);
   }
   if(linked&&phase==='publication-read-unknown')preservedFile=path.join(workspace,'media',linked);
   move();
   if(phase==='publication-read-unknown')readUncertain=true;
  }return originalTx(body);};
  const off=onMediaProcess(event=>{
   events.push(event);
   if(event.type==='started'&&event.kind==='ffmpeg'&&++ffmpegStarts===2&&phase==='capability')move();
   // Source probe, renderer verification, then final fileInfo probe. The third
   // observed close happens before the await resumes at publication admission.
   if(event.type==='exited'&&event.kind==='ffprobe'&&++probeExits===3){
    if(phase==='prepublication')move();
    if(publicationPhase)publicationArmed=true;
   }
  });
  try{worker=startWorker(store,services,new Map());await worker.tick();}finally{off();}
  assert.equal(observerFailure,undefined);assert.equal(moved,true,`${mutation} raced at ${phase}`);
  if(publicationPhase)assert.equal(linkedBeforeTx,true,'ownership changed after this task linked its output and immediately before the real publication transaction');
  assert.deepEqual(state(),afterMutation,'worker cannot change source, lineage, foreign records, or receipts after ownership drift');
  const rejected=store.get('exports',accepted.id);assert.equal(rejected.status,'failed');assert.equal(rejected.error.code,'TIMELINE_SOURCE_UNAVAILABLE');
  assert.equal(rejected.assetId,null);assert.equal(rejected.url,null);assert.deepEqual(rejected.snapshot,acceptedSnapshot);
  assert.equal(JSON.stringify(rejected.error).includes(other.id),false);assert.equal(JSON.stringify(rejected.error).includes(foreignShot.id),false);assert.equal(JSON.stringify(rejected.error).includes(workspace),false);
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  assert.equal(ffmpegStarts,phase==='capability'?2:4,phase==='capability'?'no timeline encode after capability source drift':'render completed before publication source drift');
  if(phase==='publication-replacement'){
   assert.ok(replacementFile);assert.deepEqual(await readFile(replacementFile),replacementBytes,'cleanup must refuse a replacement inode without hiding the original source-ownership error');
   assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),[...files,path.basename(replacementFile)].sort());
  }else if(phase==='publication-read-unknown'){
   assert.equal(readFailureObserved,true);assert.ok(preservedFile);
   await verifyOutput(preservedFile,360,640,3);
   assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),[...files,path.basename(preservedFile)].sort(),'uncertain publication ownership must preserve the linked output');
  }else assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),files,'no render scratch, partial file, orphan publication, or output asset may remain');
  assert.equal(hash(await readFile(sourceFile)),sourceHash);
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
}

test('worker rechecks frozen source ownership, retained lineage and identity after the actual capability await',{timeout:45000},async t=>{
 for(const mutation of ['asset-sql-owner','asset-json-owner','version-sql-owner','job-lineage','shot-sql-owner','asset-hash','asset-mime','asset-path'])
  await t.test(mutation,t=>sourceOwnershipRace(t,{mutation}));
});

test('worker publication guards remove only known unpublished output and preserve replaced or uncertain files',{timeout:20000},async t=>{
 for(const phase of ['prepublication','publication-tx','publication-replacement','publication-read-unknown'])await t.test(phase,t=>sourceOwnershipRace(t,{mutation:'asset-sql-owner',phase}));
});

test('postcommit publication exception preserves the successful custom export and its exact owned output',{timeout:20000},async t=>{
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace),services=createServices(store,new Map());let worker;
 try{
  const project=await services.call('project.create',{name:'Synthetic committed publication'});
  const asset=await services.call('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find(track=>track.kind==='audio').id,assetId:asset.id,startFrame:0,durationFrames:3});
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('short_360')};
  const accepted=await services.call('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  const originalTx=store.tx;let probeExits=0,armed=false,injected=false,committed,committedAsset;
  store.tx=body=>{
   if(!armed)return originalTx(body);
   armed=false;const result=originalTx(body);committed=store.get('exports',accepted.id);committedAsset=store.get('assets',committed.assetId);injected=true;
   throw Object.assign(Error('Synthetic acknowledgement failure after successful commit.'),{code:'SYNTHETIC_POSTCOMMIT_FAILURE'});
  };
  const events=[],off=onMediaProcess(event=>{events.push(event);if(event.type==='exited'&&event.kind==='ffprobe'&&++probeExits===3)armed=true;});
  try{worker=startWorker(store,services,new Map());await worker.tick();}finally{off();}
  assert.equal(injected,true);assert.equal(committed.status,'succeeded');assert.equal(committed.error,null);
  assert.deepEqual(store.get('exports',accepted.id),committed,'postcommit exception cannot downgrade an already published success');
  assert.deepEqual(store.get('assets',committed.assetId),committedAsset);assert.equal(store.list('assets').length,2);
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  const file=path.join(workspace,committedAsset.relativePath);assert.equal(hash(await readFile(file)),committedAsset.sha256);await verifyOutput(file,360,640,3);
  assert.equal((await readdir(path.join(workspace,'media'))).some(name=>name.startsWith('.timeline-render-')||name.endsWith('.part.mp4')),false);
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
});
