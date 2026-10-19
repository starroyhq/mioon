import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,isExportPreflightResponse} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

// Synthetic, local-only shared-service/worker acceptance. No provider/model calls.
// Retained old bytes are immutable; freshly encoded MP4 bytes are not promised
// to be reproducible across FFmpeg versions. Preview parity compares decoding.
const exec=promisify(execFile),sampleRate=48000,fps=30;
const repo=fileURLToPath(new URL('..',import.meta.url));
const evidence=path.join(repo,'evidence/project-specifications/media');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const records={startedAt:new Date().toISOString(),runtime:process.version,fixturePolicy:'Local lavfi sources; shared services and real worker; zero providers',commands:[],checks:[]};
async function command(file,args,binary=false){
 try{
  const {stdout,stderr}=await exec(file,args,{encoding:binary?'buffer':'utf8',maxBuffer:32*1024*1024,timeout:120000});
  records.commands.push({file,args,exitCode:0,stdout:binary?{bytes:stdout.length,sha256:sha(stdout)}:stdout,stderr:String(stderr)});return stdout;
 }catch(error){records.commands.push({file,args,exitCode:error.code,stderr:String(error.stderr)});throw error;}
}
const ffmpeg=args=>command('ffmpeg',['-hide_banner','-loglevel','error','-y','-filter_complex_threads','1',...args]);
async function makeFixtures(root){
 for(const {id,width,height} of TIMELINE_OUTPUT_PRESETS)
  await ffmpeg(['-f','lavfi','-i',`color=c=red:s=${width}x${height}:r=30`,'-frames:v','1','-threads','1',path.join(root,`${id}.png`)]);
 for(const [rate,first,last] of [[24,'blue','yellow'],[60,'magenta','cyan']]){
  await ffmpeg(['-f','lavfi','-i',`color=c=${first}:s=320x180:r=${rate}:d=1`,'-f','lavfi','-i',`color=c=${last}:s=320x180:r=${rate}:d=1`,
   '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1',
   '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]',
   '-map','[v]','-map','[a]','-c:v','libx264','-preset','ultrafast','-crf','12','-threads','1','-pix_fmt','yuv420p','-r',String(rate),
   '-c:a','aac','-ac','2',path.join(root,`source-${rate}.mp4`)]);
 }
 await ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
  '-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1[a]','-map','[a]','-c:a','pcm_s16le','-ac','1',path.join(root,'tone.wav')]);
}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-output-presets-')),store=openStore(path.join(root,'data')),providers=new Map();
 const services=createServices(store,providers,{env:{MIOON_ENABLE_LIVE_PROVIDER:'0'}}),worker=startWorker(store,services,providers);
 await mkdir(evidence,{recursive:true});
 t.after(async()=>{
  await worker.stop();await services.drain();store.close();
  records.finishedAt=new Date().toISOString();await writeFile(path.join(evidence,'acceptance.json'),JSON.stringify(records,null,2));
  await rm(root,{recursive:true,force:true});
 });
 const call=(operation,input)=>services.call(operation,input);
 async function importFile(projectId,name,mimeType){return call('asset.import',{projectId,name,mimeType,dataBase64:(await readFile(path.join(root,name))).toString('base64')});}
 async function finish(id,name){
  const deadline=Date.now()+120000;let job;
  do{job=await call('export.get',{exportId:id});if(['succeeded','failed'].includes(job.status))break;await pause(40);}while(Date.now()<deadline);
  assert.equal(job.status,'succeeded',JSON.stringify(job));
  const asset=store.get('assets',job.assetId),file=path.join(evidence,name);
  await copyFile(path.join(store.root,asset.relativePath),file);return {job,asset,file,bytes:await readFile(file)};
 }
 return {root,store,call,importFile,finish};
}
async function probeOutput(file,{width,height,frames,legacy=false}){
 const info=JSON.parse(await command('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]));
 const video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
 assert.equal(info.streams.length,2);assert.equal(video.codec_name,'h264');assert.equal(video.width,width);assert.equal(video.height,height);
 assert.equal(video.r_frame_rate,'30/1');if(!legacy)assert.equal(video.avg_frame_rate,'30/1');assert.equal(Number(video.nb_read_frames),frames);
 assert.equal(audio.codec_name,'aac');assert.equal(Number(audio.sample_rate),sampleRate);assert.equal(audio.channels,2);assert.equal(audio.channel_layout,'stereo');
 assert.ok(Math.abs(Number(video.duration)-frames/fps)<(legacy?.05:.00001));assert.ok(Math.abs(Number(info.format.duration)-frames/fps)<.035);
 await command('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-']);
 await writeFile(file.replace(/\.mp4$/,'-probe.json'),JSON.stringify(info,null,2));
 return {width,height,frames,seconds:Number(info.format.duration),video:'h264',audio:'aac',sampleRate,channels:2,fullDecode:true};
}
async function frame(file,n,width,height){
 const bytes=await command('ffmpeg',['-v','error','-threads','1','-i',file,'-vf',`select=eq(n\\,${n}),format=rgb24`,
  '-fps_mode','passthrough','-frames:v','1','-threads','1','-f','rawvideo','-'],true);
 assert.equal(bytes.length,width*height*3);return bytes;
}
function pixel(bytes,width,x,y,expected,label){
 const at=(y*width+x)*3,actual=[...bytes.subarray(at,at+3)];
 assert.ok(actual.every((value,i)=>Math.abs(value-expected[i])<20),`${label}: expected ${expected}, received ${actual}`);
 return {x,y,expected,actual,label};
}
const pcm=file=>command('ffmpeg',['-v','error','-i',file,'-vn','-ac','1','-ar',String(sampleRate),'-f','f32le','-'],true);
function audioStats(bytes,start,end,frequencies=[]){
 const from=Math.round(start*sampleRate),to=Math.min(Math.round(end*sampleRate),bytes.length/4);assert.ok(to>from);let energy=0;
 for(let n=from;n<to;n++)energy+=bytes.readFloatLE(n*4)**2;
 const amplitudes=Object.fromEntries(frequencies.map(f=>{let re=0,im=0;for(let n=from;n<to;n++){const v=bytes.readFloatLE(n*4),a=2*Math.PI*f*n/sampleRate;re+=v*Math.cos(a);im+=v*Math.sin(a);}return [f,2*Math.hypot(re,im)/(to-from)];}));
 return {start,end,rms:Math.sqrt(energy/(to-from)),amplitudes};
}
function tone(stats,present,absent){assert.ok(stats.rms>.015,JSON.stringify(stats));assert.ok(stats.amplitudes[present]>.015,JSON.stringify(stats));assert.ok(stats.amplitudes[present]>8*stats.amplitudes[absent],JSON.stringify(stats));}
async function decodedFingerprint(file){
 const video=await command('ffmpeg',['-v','error','-threads','1','-i',file,'-map','0:v:0','-f','framemd5','-']);
 return {video:video.split('\n').filter(line=>line&&!line.startsWith('#')).join('\n'),audio:sha(await pcm(file))};
}

test('three current and three legacy frozen timeline presets render exact real media and retain project-sized storyboard exports',{timeout:300000},async t=>{
 const f=await fixture(t);await makeFixtures(f.root);const retained=[];
 for(const rate of [24,60]){
  const file=path.join(f.root,`source-${rate}.mp4`),info=JSON.parse(await command('ffprobe',['-v','error','-show_streams','-of','json',file]));
  const video=info.streams.find(stream=>stream.codec_type==='video');
  assert.equal(video.r_frame_rate,`${rate}/1`);assert.equal(video.avg_frame_rate,`${rate}/1`);
 }
 for(const [index,preset] of TIMELINE_OUTPUT_PRESETS.entries())await t.test(preset.id,async()=>{
  const {width,height}=preset,frames=index===1?91:71,project=await f.call('project.create',{name:`Output preset ${preset.id}`});
  const status=await f.call('timeline.format.get',{projectId:project.id});assert.equal(status.timelineRevision,0);
  // The current implicit portrait timeline is created without any format receipt; explicit legacy presets retain their own geometry.
  let timeline=index===0?await f.call('timeline.get',{projectId:project.id}):await f.call('timeline.format.set',{
   projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:preset.id});
  assert.deepEqual([timeline.fps,timeline.width,timeline.height],[30,width,height]);
  const mutate=async(operation,fields)=>timeline=await f.call(operation,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
  const red=await f.importFile(project.id,`${preset.id}.png`,'image/png'),source24=await f.importFile(project.id,'source-24.mp4','video/mp4'),
   source60=await f.importFile(project.id,'source-60.mp4','video/mp4'),audio=await f.importFile(project.id,'tone.wav','audio/wav');
  const sources=[red,source24,source60,audio],sourceBytes=new Map();
  for(const asset of sources){const stored=f.store.get('assets',asset.id);sourceBytes.set(asset.id,await readFile(path.join(f.store.root,stored.relativePath)));}
  await mutate('timeline.track.add',{kind:'video',name:'60 fps source'});
  const videos=timeline.tracks.filter(track=>track.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex),audioTrack=timeline.tracks.find(track=>track.kind==='audio');
  await mutate('timeline.clip.add',{trackId:videos[0].id,assetId:red.id,startFrame:0,durationFrames:45});
  const lower=timeline.clips.find(clip=>clip.assetId===red.id);assert.deepEqual(lower.rect,{x:0,y:0,width,height});
  await mutate('timeline.clip.add',{trackId:videos[0].id,assetId:red.id,startFrame:60,durationFrames:frames-60});
  const y=height/2-120,left=width/2-260,right=width/2+20;
  await mutate('timeline.clip.add',{trackId:videos[1].id,assetId:source24.id,startFrame:0,durationFrames:45,sourceInFrame:15,
   rect:{x:left,y,width:240,height:240},gain:.75,fadeInFrames:6,fadeOutFrames:6});
  await mutate('timeline.clip.add',{trackId:videos[2].id,assetId:source60.id,startFrame:0,durationFrames:45,sourceInFrame:15,
   rect:{x:right,y,width:240,height:240},gain:0});
  await mutate('timeline.clip.add',{trackId:audioTrack.id,assetId:audio.id,startFrame:60,durationFrames:frames-60,sourceInFrame:30});
  const frozen=structuredClone(timeline),preflightInput={projectId:project.id,expectedRevision:timeline.revision};
  const preflight=await f.call('timeline.export.preflight',preflightInput);
  assert.ok(isExportPreflightResponse(preflight,preflightInput));assert.equal(preflight.status,'ready',JSON.stringify(preflight));
  assert.deepEqual([preflight.summary.fps,preflight.summary.width,preflight.summary.height,preflight.summary.durationFrames],[30,width,height,frames]);
  assert.equal(preflight.checks.checkedAssets,4);assert.equal(preflight.checks.fullDecode,false);
  const request={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',preflightSnapshotHash:preflight.snapshotHash};
  const queued=await f.call('timeline.render',request),preview=await f.call('timeline.render',{...request,requestId:randomUUID(),purpose:'preview'});
  assert.deepEqual(queued.snapshot.timeline,frozen);assert.deepEqual(preview.snapshot.timeline,frozen);
  const receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(request.requestId).response;
  // A later edit affects neither queued export content nor frozen dimensions.
  await mutate('timeline.clip.update',{clipId:lower.id,patch:{durationFrames:30}});
  await assert.rejects(f.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:timeline.revision,
   requestId:randomUUID(),presetId:index===0?'landscape_720':'portrait_720'}),{code:'TIMELINE_FORMAT_LOCKED'});
  const output=await f.finish(queued.id,`${preset.id}-export.mp4`),previewOutput=await f.finish(preview.id,`${preset.id}-preview.mp4`);
  const verified=await probeOutput(output.file,{width,height,frames});await probeOutput(previewOutput.file,{width,height,frames});
  assert.deepEqual(await decodedFingerprint(previewOutput.file),await decodedFingerprint(output.file),'Preview and export decode identically');
  const ratio=width===height?'1x1':width<height?'9x16':'16x9';assert.equal(output.asset.name,`多轨时间线-导出-${ratio}.mp4`);assert.equal(previewOutput.asset.name,`多轨时间线-预览-${ratio}.mp4`);
  const pixels=[];
  for(const n of [12,18,40]){
   const bytes=await frame(output.file,n,width,height);
   pixels.push({frame:n,...pixel(bytes,width,left+120,height/2,n<15?[0,0,255]:[255,255,0],'24 fps converted on source seconds')});
   pixels.push({frame:n,...pixel(bytes,width,right+120,height/2,n<15?[255,0,255]:[0,255,255],'60 fps converted on source seconds')});
   pixels.push({frame:n,...pixel(bytes,width,left+120,y+10,[255,0,0],'transparent contain padding preserves frozen lower layer')});
  }
  for(const n of [45,59])pixels.push({frame:n,...pixel(await frame(output.file,n,width,height),width,width/2,height/2,[0,0,0],'exact picture gap')});
  for(const n of [60,frames-1])pixels.push({frame:n,...pixel(await frame(output.file,n,width,height),width,width/2,height/2,[255,0,0],'exact final clip edge')});
  const decoded=await pcm(output.file),beforeSwitch=audioStats(decoded,.25,.4,[330,660]),afterSwitch=audioStats(decoded,.8,1.15,[330,660]),
   gap=audioStats(decoded,1.62,1.88),tail=audioStats(decoded,2.1,frames/30-.04,[440,880]),fadeIn=audioStats(decoded,.02,.06),fadeOut=audioStats(decoded,1.44,1.48);
  tone(beforeSwitch,330,660);tone(afterSwitch,660,330);tone(tail,880,440);assert.ok(gap.rms<.002,JSON.stringify(gap));
  assert.ok(fadeIn.rms<beforeSwitch.rms*.4);assert.ok(fadeOut.rms<afterSwitch.rms*.4);
  for(const asset of sources){const stored=f.store.get('assets',asset.id);assert.deepEqual(await readFile(path.join(f.store.root,stored.relativePath)),sourceBytes.get(asset.id));assert.equal(stored.sha256,asset.sha256);}
  assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(request.requestId).response,receipt);
  assert.deepEqual(await f.call('timeline.render',request),queued,'Exact historical replay retains its own frozen format');
  retained.push({project,request,receipt,queued,output,frozen,source24});
  records.checks.push({presetId:preset.id,result:'passed',...verified,pixels,audio:{beforeSwitch,afterSwitch,gap,tail,fadeIn,fadeOut},previewExportDecodedEqual:true,sourcesUnchanged:true});
 });
 await t.test('retained receipts/output stay unchanged while a new storyboard export freezes saved project geometry',async()=>{
  for(const item of retained){
   assert.deepEqual((await f.call('export.get',{exportId:item.queued.id})).snapshot.timeline,item.frozen);
   assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(item.request.requestId).response,item.receipt);
   assert.deepEqual(await readFile(path.join(f.store.root,item.output.asset.relativePath)),item.output.bytes);
  }
  const landscape=retained.find(item=>item.frozen.width===1280),projectId=landscape.project.id;
  const before=f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId).data;
  const shot=await f.call('shot.create',{projectId,title:'Legacy storyboard',prompt:'Synthetic local fixture',duration:2});
  // Seed an already-selected version, then use the real legacy enqueue/worker.
  // This avoids involving any generation provider in output-format acceptance.
  const version={id:randomUUID(),jobId:randomUUID(),projectId,shotId:shot.id,assetId:landscape.source24.id,sha256:landscape.source24.sha256,number:1,createdAt:new Date().toISOString()};
  f.store.put('jobs',{id:version.jobId,projectId,shotId:shot.id,status:'succeeded',versionId:version.id});
  f.store.put('versions',version);f.store.put('shots',{...f.store.get('shots',shot.id),selectedVersionId:version.id});
  const request={projectId,requestId:randomUUID()},queued=await f.call('export.create',request);
  assert.notEqual(queued.mode,'timeline');assert.ok(Array.isArray(queued.snapshot));
  const output=await f.finish(queued.id,'legacy-storyboard.mp4');
  const verified=await probeOutput(output.file,{width:1280,height:720,frames:60,legacy:true});
  assert.equal(output.asset.name,'分镜拼接-16x9.mp4');assert.equal(f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId).data,before);
  records.checks.push({name:'Frozen receipt/output retention and separate project-sized storyboard',result:'passed',...verified,retainedPortraitSha256:sha(retained[0].output.bytes)});
 });
});
