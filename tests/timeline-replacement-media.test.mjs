import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.mjs';
import {run,runStreaming} from '../packages/business/src/media-runtime.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const token='clip-replacement-synthetic-http-fixture';
const evidence=path.resolve('evidence/clip-replacement/media');
const binary=async args=>{
 const chunks=[];
 await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-threads','1',...args],{timeout:20000,maxStdoutBytes:8*1024*1024,onStdout:chunk=>{chunks.push(Buffer.from(chunk));}});
 return Buffer.concat(chunks);
};
async function sample(file){
 const pixels=await binary(['-ss','1.25','-i',file,'-frames:v','1','-vf','scale=4:4','-threads','1','-pix_fmt','rgb24','-f','rawvideo','-']);
 // Sample the center at full resolution separately, preserving black padding.
 const center=await binary(['-ss','1.25','-i',file,'-frames:v','1','-vf','crop=2:2:360:640','-threads','1','-pix_fmt','rgb24','-f','rawvideo','-']);
 const sound=await binary(['-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','-']);
 const stats=(start,end)=>{
  const from=Math.round(start*48000),to=Math.round(end*48000);let energy=0;
  const tones={440:[0,0],880:[0,0]};
  for(let n=from;n<to;n++){const value=sound.readFloatLE(n*4);energy+=value*value;for(const f of [440,880]){const angle=2*Math.PI*f*n/48000;tones[f][0]+=value*Math.cos(angle);tones[f][1]+=value*Math.sin(angle);}}
  return {rms:Math.sqrt(energy/(to-from)),tones:Object.fromEntries(Object.entries(tones).map(([f,v])=>[f,2*Math.hypot(...v)/(to-from)]))};
 };
 return {center:[...center.subarray(0,3)],corner:[...pixels.subarray(0,3)],early:stats(.55,.65),middle:stats(1.15,1.35),late:stats(2.35,2.45),gap:stats(.1,.3)};
}

test('explicit replacement keeps timing/fades and old exports while new media, preflight and waveform use the new source', {timeout:120000}, async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-replacement-media-')),workspace=path.join(root,'workspace');
 await mkdir(evidence,{recursive:true});
 let server;
 t.after(async()=>{await server?.close();await rm(root,{recursive:true,force:true});});
 const start=async()=>{server=await startServer({dataDir:workspace,port:0,token,chatGateway:async function*(){throw Error('Synthetic media acceptance must not invoke a model');}});};
 await start();
 const rpc=async(operation,input,expected=200)=>{
  const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
  const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body.ok?body.data:body.error;
 };
 const finish=async job=>{
  const deadline=Date.now()+45000;let current;
  do{current=await rpc('export.get',{exportId:job.id});if(['succeeded','failed'].includes(current.status))break;await pause(50);}while(Date.now()<deadline);
  assert.equal(current.status,'succeeded',JSON.stringify(current));
  const response=await fetch(server.url+current.url,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer()),file=path.join(evidence,job.id+'.mp4');await writeFile(file,bytes);
  const probe=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{timeout:15000}));
  const video=probe.streams.find(s=>s.codec_type==='video');assert.equal(Number(video.nb_read_frames),75);assert.equal(video.width,720);assert.equal(video.height,1280);assert.ok(Math.abs(Number(probe.format.duration)-2.5)<.04);
  await run('ffmpeg',['-v','error','-i',file,'-f','null','-'],{timeout:15000});
  return {job:current,file,sha256:hash(bytes),sample:await sample(file)};
 };
 const project=await rpc('project.create',{name:'Synthetic fixed-source replacement'});
 // This pixel/audio fixture explicitly preserves its historical 720 canvas.
 await rpc('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'portrait_720'});

 let timeline=await rpc('timeline.get',{projectId:project.id});const assets=[];
 for(const [color,frequency] of [['red',440],['blue',880]]){
  const file=path.join(root,color+'.mp4');
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${color}:s=160x90:r=30:d=3`,'-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=3`,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-t','3',file],{timeout:20000});
  assets.push(await rpc('asset.import',{projectId:project.id,name:color+'.mp4',mimeType:'video/mp4',dataBase64:(await readFile(file)).toString('base64')}));
 }
 const mutate=async(operation,input)=>timeline=await rpc(operation,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...input});
 await mutate('timeline.clip.add',{assetId:assets[0].id,trackId:timeline.tracks.find(s=>s.kind==='video').id,name:'Keep my clip name',startFrame:15,durationFrames:60,sourceInFrame:15,rect:{x:180,y:320,width:360,height:640},gain:.5,fadeInFrames:15,fadeOutFrames:15});
 const beforeTimeline=structuredClone(timeline),beforeCheck=await rpc('timeline.export.preflight',{projectId:project.id,expectedRevision:timeline.revision});assert.equal(beforeCheck.status,'ready');
 const waveform=async assetId=>{
  await rpc('asset.waveform.request',{projectId:project.id,assetId});let value;const deadline=Date.now()+15000;
  do{value=await rpc('asset.waveform.get',{projectId:project.id,assetId,sourceStartFrame:15,sourceEndFrame:75,points:64});if(['ready','error','unsupported'].includes(value.status))break;await pause(30);}while(Date.now()<deadline);
  assert.equal(value.status,'ready',JSON.stringify(value));return value;
 };
 const beforeWave=await waveform(assets[0].id);
 const oldRequest={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',preflightSnapshotHash:beforeCheck.snapshotHash};
 const before=await finish(await rpc('timeline.render',oldRequest));
 const replacement={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0].id,assetId:assets[1].id};
 timeline=await rpc('timeline.clip.replaceSource',replacement);const changed=structuredClone(timeline);
 assert.deepEqual({...timeline.clips[0],assetId:assets[0].id},beforeTimeline.clips[0]);
 assert.equal((await rpc('timeline.render',{...oldRequest,requestId:randomUUID(),expectedRevision:timeline.revision},409)).code,'PREFLIGHT_STALE');
 assert.equal((await rpc('asset.waveform.get',{projectId:project.id,assetId:assets[1].id})).status,'missing','replacement never requests a decode');
 const afterWave=await waveform(assets[1].id);assert.notEqual(afterWave.attemptId,beforeWave.attemptId);
 assert.deepEqual(await rpc('asset.waveform.get',{projectId:project.id,assetId:assets[0].id,sourceStartFrame:15,sourceEndFrame:75,points:64}),beforeWave);
 const afterCheck=await rpc('timeline.export.preflight',{projectId:project.id,expectedRevision:timeline.revision});assert.equal(afterCheck.status,'ready');assert.notEqual(afterCheck.snapshotHash,beforeCheck.snapshotHash);
 const after=await finish(await rpc('timeline.render',{...oldRequest,requestId:randomUUID(),expectedRevision:timeline.revision,preflightSnapshotHash:afterCheck.snapshotHash}));
 assert.ok(before.sample.center[0]>220&&before.sample.center[2]<30,JSON.stringify(before.sample));assert.ok(after.sample.center[2]>220&&after.sample.center[0]<30,JSON.stringify(after.sample));
 for(const [result,frequency,other] of [[before,440,880],[after,880,440]]){
  assert.ok(result.sample.corner.every(v=>v<15));assert.ok(result.sample.gap.rms<.002);
  assert.ok(result.sample.middle.tones[frequency]>result.sample.middle.tones[other]*10);
  assert.ok(result.sample.early.rms<result.sample.middle.rms*.4);assert.ok(result.sample.late.rms<result.sample.middle.rms*.4);
 }
 await mutate('timeline.undo',{});assert.deepEqual(timeline.clips,beforeTimeline.clips);
 await mutate('timeline.redo',{});assert.deepEqual(timeline.clips,changed.clips);
 assert.deepEqual(await rpc('timeline.clip.replaceSource',replacement),changed,'old acknowledgement is exact after later history operations');
 await server.close();server=null;await start();
 assert.deepEqual(await rpc('timeline.clip.replaceSource',replacement),changed,'restart retains replay identity and original response');
 assert.deepEqual((await rpc('timeline.get',{projectId:project.id})).clips,changed.clips);
 const originalAgain=await fetch(server.url+before.job.url,{headers:{authorization:`Bearer ${token}`}});assert.equal(hash(Buffer.from(await originalAgain.arrayBuffer())),before.sha256);
 assert.deepEqual((await rpc('export.get',{exportId:before.job.id})).snapshot,before.job.snapshot);
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});
 try{
  for(const a of assets){const stored=JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(a.id).data);assert.equal(hash(await readFile(path.join(workspace,stored.relativePath))),a.sha256);}
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exports').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waveform_cache').get().n,2);
 }finally{db.close();}
 await writeFile(path.join(evidence,'acceptance.json'),JSON.stringify({status:'passed',synthetic:true,projectId:project.id,before,after,originalBytesUnchanged:true,oldExportUnchanged:true,exactRestartReplay:true,preflightHashes:[beforeCheck.snapshotHash,afterCheck.snapshotHash],waveformAttempts:[beforeWave.attemptId,afterWave.attemptId]},null,2)+'\n');
});
