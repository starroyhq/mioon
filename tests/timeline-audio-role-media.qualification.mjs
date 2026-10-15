// Explicit bounded qualification, not part of the automatic test glob.
// Generated local media only. Three serial 2-second production renders.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,writeFile,readFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.mjs';
import {renderTimeline} from '../packages/business/src/timeline-media.mjs';
import {run,runStreaming} from '../packages/business/src/media-runtime.mjs';
import {onMediaProcess,hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const root=await mkdtemp(path.join(tmpdir(),'mioon-role-causal-'));
const records={root,policy:'Generated local media; no providers/GUI/network; 3 serial 2-second float-v2 renders; fixtures/decodes single-thread, unchanged production encoder uses two threads.',events:[],commands:[],outputs:[],status:'running'};
// Qualification-only instrumentation: retain exact owned child close and kill outcomes.
const originalSpawn=childProcess.spawn;
childProcess.spawn=function(...args){const child=originalSpawn.apply(this,args),entry={command:args[0],args:args[1],pid:null,killRequests:[]};records.commands.push(entry);child.once('spawn',()=>{entry.pid=child.pid;});child.once('close',(code,signal)=>{entry.close={code,signal};});const kill=child.kill;child.kill=function(...killArgs){const result=kill.apply(this,killArgs);entry.killRequests.push({arguments:killArgs,result});return result;};return child;};
syncBuiltinESMExports();
const off=onMediaProcess(event=>records.events.push({...event,at:new Date().toISOString()}));
const opts={timeout:30000,maxStdoutBytes:65536,maxStderrBytes:65536};
async function command(args){records.commands.push(args);return run('ffmpeg',args,opts);}
let store;
try{
 await mkdir(path.join(root,'workspace','media'),{recursive:true,mode:0o700});
 const wav=path.join(root,'workspace','media','sine.wav'),video=path.join(root,'workspace','media','pattern.mp4');
 await command(['-hide_banner','-loglevel','error','-y','-threads','1','-filter_threads','1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-ac','2','-c:a','pcm_s16le',wav]);
 await command(['-hide_banner','-loglevel','error','-y','-threads','1','-filter_threads','1','-filter_complex_threads','1','-f','lavfi','-i','testsrc2=size=64x64:rate=30:duration=2','-i',wav,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-t','2',video]);
 store=openStore(path.join(root,'workspace'));const services=createServices(store,new Map()),project=(await services.call('project.create',{name:'Role-only causal qualification'}));
 const sources=new Map();records.sourceIdentities=[];
 for(const [file,mimeType,width,height,hasVideo]of [[video,'video/mp4',64,64,true],[wav,'audio/wav',0,0,false]]){
  const bytes=await readFile(file),asset={id:randomUUID(),projectId:project.id,name:path.basename(file),mimeType,duration:2,width,height,hasAudio:true,hasVideo,sha256:hash(bytes),sizeBytes:bytes.length,relativePath:`media/${path.basename(file)}`};
  records.sourceIdentities.push({path:file,sha256:asset.sha256});store.put('assets',asset);sources.set(asset.id,{...asset,path:file});
 }
 let timeline=await services.call('timeline.get',{projectId:project.id});
 const edit=async(op,extra)=>timeline=await services.call(op,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...extra});
 await edit('timeline.track.add',{kind:'audio',name:'Muted role use'});const lanes=timeline.tracks;
 const videoAsset=[...sources.values()].find(a=>a.hasVideo),audioAsset=[...sources.values()].find(a=>!a.hasVideo);
 await edit('timeline.track.update',{trackId:lanes.at(-1).id,patch:{muted:true}});
 for(const [lane,asset,gain]of [[lanes[0],videoAsset,.3],[lanes.find(l=>l.kind==='audio'),audioAsset,.25],[lanes.at(-1),audioAsset,.5]])await edit('timeline.clip.add',{trackId:lane.id,assetId:asset.id,startFrame:0,durationFrames:60,sourceInFrame:0,gain,fadeInFrames:5,fadeOutFrames:5});
 const nonRole=value=>{const result=structuredClone(value);delete result.revision;delete result.updatedAt;for(const clip of result.clips)delete clip.audioRole;return result;};
 const original=nonRole(timeline),settings={profileId:'mp4_h264_float_checked_v2',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
 let baselinePcm,baselineFrames;
 for(const variant of ['absent','roles','clear']){
  if(variant!=='absent')for(const [index,clip]of timeline.clips.entries())await edit('timeline.clip.update',{clipId:clip.id,patch:{audioRole:variant==='roles'?['human','music','sfx'][index]:null}});
  assert.deepEqual(nonRole(timeline),original);
  const snapshot=freezeTimelineSnapshot(timeline,sources,settings),destination=path.join(root,`${variant}.mp4`),signal=AbortSignal.timeout(30000);
  const record={variant,revision:timeline.revision,snapshotSha256:hash(JSON.stringify(snapshot)),signalAborted:false};records.outputs.push(record);
  try{await renderTimeline(snapshot,sources,destination,{signal});}finally{record.signalAborted=signal.aborted;}
  assert.equal(signal.aborted,false);assert.ok((await stat(destination)).size<=16*1024*1024);
  const chunks=[];await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-i',destination,'-vn','-ac','2','-ar','48000','-f','f32le','-'],{...opts,maxStdoutBytes:768*1024,onStdout:chunk=>chunks.push(Buffer.from(chunk))});
  const pcm=Buffer.concat(chunks),frames=await run('ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-i',destination,'-an','-map','0:v:0','-c:v','rawvideo','-threads','1','-f','framemd5','-'],opts);
  const frameLines=frames.split('\n').filter(line=>line&&!line.startsWith('#'));assert.equal(frameLines.length,60);assert.ok(pcm.length>=96000*8&&pcm.length<=768*1024);
  record.pcmBytes=pcm.length;record.pcmSha256=hash(pcm);record.frameCount=frameLines.length;record.frameHashesSha256=hash(frameLines.join('\n'));
  if(variant==='absent'){baselinePcm=pcm;baselineFrames=frameLines;}else{assert.deepEqual(pcm,baselinePcm);assert.deepEqual(frameLines,baselineFrames);}
  for(const asset of sources.values())assert.equal(hash(await readFile(asset.path)),asset.sha256);
 }
 assert.equal(new Set(records.outputs.map(r=>r.snapshotSha256)).size,3);assert.equal(new Set(records.outputs.map(r=>r.revision)).size,3);
 assert.equal(hasUnconfirmedMediaProcesses(),false);
 for(const event of records.events.filter(e=>e.type==='started'))assert.ok(records.events.some(e=>e.type==='exited'&&e.pid===event.pid),`Missing close for PID ${event.pid}`);
 assert.ok(records.commands.filter(c=>!Array.isArray(c)).every(c=>c.close?.code===0&&c.close.signal===null&&c.killRequests.length===0));
 records.status='passed';
}catch(error){records.status='failed';records.error={code:error.code??null,message:error.message,terminationUnconfirmed:Boolean(error.terminationUnconfirmed),unconfirmedOwnedProcesses:hasUnconfirmedMediaProcesses()};process.exitCode=1;}
finally{try{store?.close();}catch(error){records.cleanupError=error.message;records.status='failed';process.exitCode=1;}finally{off();childProcess.spawn=originalSpawn;syncBuiltinESMExports();}await mkdir(new URL('../evidence/audio-roles/',import.meta.url),{recursive:true});await writeFile(new URL('../evidence/audio-roles/causal-media.json',import.meta.url),JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify({status:records.status,root,outputs:records.outputs,error:records.error}));}
