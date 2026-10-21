import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,open} from 'node:fs/promises';
import {writeFileSync,readdirSync,lstatSync,unlinkSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {resolveTimelineExportDelivery,TIMELINE_OUTPUT_PRESETS,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe,fileInfo,stitch} from '../packages/business/src/media.ts';
import {withProbePermit,MEDIA_PROBE_LIMITS} from '../packages/business/src/media-probe.ts';
import {onMediaProcess,terminateMediaProcesses} from '../packages/business/src/media-processes.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {inspectTimelineExportCapability,assertTimelineExportCapability} from '../packages/business/src/timeline-export-capabilities.ts';
import {verifySubtitleFontResource} from '../packages/business/src/subtitle-resources.ts';
import {probeTimelineSource,prepareTimelineInputs} from '../packages/business/src/timeline-sources.ts';

const codes=['RESTORE_OPERATION_UNAVAILABLE','RESTORED_RECORD_HELD','RESTORE_WORKSPACE_ORIGIN_REQUIRED','RESTORE_WORKSPACE_ORIGIN_MISMATCH'];
const restriction=(code=codes[0])=>Object.assign(Error('Synthetic revoked media owner.'),{code});
const delivery=resolveTimelineExportDelivery(TIMELINE_OUTPUT_PRESETS[0],{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}});
const metadata={streams:[{index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'2'},
 {index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}],format:{duration:String(2/30)}};
const listing='Encoders:\n ------\n V....D libx264 Synthetic video\n A..... aac Synthetic audio\n';
const subtitleHelp='Filter drawtext\n  Synthetic drawtext filter\ndrawtext AVOptions:\n'+
 ['fontfile','textfile','expansion','fontsize','borderw','line_spacing','fontcolor','bordercolor','x','y'].map(name=>`   ${name} <string> ..FV....... synthetic option\n`).join('')+
 "\nThis filter has support for timeline through the 'enable' option.\n";
async function sandbox(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-restore-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function fixture(t){
 const root=await sandbox(t),binary=path.join(root,'synthetic-media.ts');
 await writeFile(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
 import assert from 'node:assert/strict';
 const args=process.argv.slice(2);
 if(args.includes('-show_streams'))process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});
 else if(args.includes('-encoders'))process.stdout.write(${JSON.stringify(listing)});
 else if(args.includes('-h')){assert.deepEqual(args,['-hide_banner','-h','filter=drawtext']);process.stdout.write(${JSON.stringify(subtitleHelp)});}
 else if(args.includes('rawvideo')){const bytes=Buffer.alloc(4096*256);bytes[64*4096+64]=255;process.stdout.write(bytes);}
 else if(args.at(-1)==='pipe:1')process.stdout.write('synthetic-not-mp4');
 else writeFileSync(args.at(-1),'synthetic-owned-output',{flag:args.includes('-n')?'wx':'w'});\n`,{mode:0o700});
 const saved={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 process.env.MIOON_FFMPEG_PATH=binary;process.env.MIOON_FFPROBE_PATH=binary;
 t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 return root;
}
function observe(t,callback){const events=[],off=onMediaProcess(event=>{events.push(event);callback?.(event);});t.after(off);return events;}
const started=events=>events.filter(event=>event.type==='started');
function timeline(root,{subtitles=false}={}){
 const asset={id:randomUUID(),mimeType:'audio/wav',path:path.join(root,'synthetic.wav'),duration:1,hasVideo:false,hasAudio:true,audioStreamIndex:0};
 const track={id:randomUUID(),kind:'audio',orderIndex:0,hidden:false,muted:false};
 const saved={fps:30,width:720,height:1280,durationFrames:2,tracks:[track],clips:[0,1].map(startFrame=>({id:randomUUID(),trackId:track.id,assetId:asset.id,startFrame,durationFrames:1,sourceInFrame:startFrame,rect:{x:0,y:0,width:720,height:1280},gain:1}))};
 const snapshot={timeline:saved};
 if(subtitles){saved.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'Local test',startFrame:0,durationFrames:2}]};snapshot.subtitleProfile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};}
 return {snapshot,assets:new Map([[asset.id,asset]])};
}
async function output(t,root,name='output.mp4'){
 const file=path.join(root,name),handle=await open(file,'wx',0o600),identity=await handle.stat();t.after(()=>handle.close());
 const check=()=>{const current=lstatSync(file);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(current.isFile(),true);};
 return {file,check};
}

test('expired synchronous fences preserve all restriction identities and spawn zero',async t=>{
 const root=await sandbox(t),source=path.join(root,'source');await writeFile(source,'input');const events=observe(t);
 for(const code of codes){
  const expected=restriction(code),beforeEffect=()=>{throw expected;};
  for(const action of [
   ()=>run(process.execPath,['-e','process.stdout.write("never")'],{beforeEffect}),
   ()=>runStreaming(process.execPath,['-e','process.stdout.write("never")'],{beforeEffect,onStdout(){}}),
   ()=>probe(source,{beforeEffect}),()=>fileInfo(source,{beforeEffect}),
   ()=>stitch([source],path.join(root,'never.mp4'),{beforeEffect}),
   ()=>renderTimeline(null,new Map(),path.join(root,'never.mp4'),{beforeEffect}),
   ()=>inspectTimelineExportCapability(delivery,{beforeEffect}),()=>assertTimelineExportCapability(delivery,{beforeEffect}),
   ()=>verifySubtitleFontResource({beforeEffect}),
  ])await assert.rejects(action(),error=>error===expected);
 }
 assert.deepEqual(events,[]);assert.deepEqual(await readdir(root),['source']);
});

test('runtime supports synchronous beforeSpawn plus beforeEffect and rejects async guards before spawn',async t=>{
 const events=observe(t),calls=[];
 assert.equal(await run(process.execPath,['-e','process.stdout.write("ok")'],{beforeSpawn(){calls.push('spawn');},beforeEffect(){calls.push('effect');}}),'ok');
 assert.deepEqual(calls,['spawn','effect','effect']);assert.equal(started(events).length,1);
 for(const options of [{beforeEffect:async()=>{}},{beforeSpawn:async()=>{}},{beforeEffect:1},{beforeSpawn:1}])
  await assert.rejects(run(process.execPath,['-e','process.stdout.write("never")'],options),{code:'MEDIA_INVALID_CONFIGURATION'});
 assert.equal(started(events).length,1);
 const expected=restriction(codes[1]);
 await assert.rejects(runStreaming(process.execPath,['-e','process.stdout.write("chunk")'],{onStdout(){throw expected;}}),error=>error===expected);
 assert.deepEqual(await terminateMediaProcesses(),[]);
});

for(const queuedProbe of [probe,probeTimelineSource])test(`queued ${queuedProbe.name} checks a revoked caller after permit dequeue and spawns zero`,async t=>{
 const root=await fixture(t),events=observe(t);let release,entered=0,checks=0,live=true;
 const gate=new Promise(resolve=>{release=resolve;});
 const blockers=Array.from({length:MEDIA_PROBE_LIMITS.concurrent},()=>withProbePermit(undefined,async()=>{entered++;await gate;}));
 await Promise.resolve();assert.equal(entered,MEDIA_PROBE_LIMITS.concurrent);
 const expected=restriction(),pending=queuedProbe(path.join(root,'source'),{beforeEffect(){checks++;if(!live)throw expected;}}),rejected=assert.rejects(pending,error=>error===expected);
 await Promise.resolve();assert.equal(checks,0);live=false;release();await Promise.all(blockers);await rejected;
 assert.equal(checks,1);assert.deepEqual(events,[]);
 assert.equal((await queuedProbe('next-current-source',{beforeEffect(){}})).hasVideo,true);
});

test('timeline source revocation during hash await preserves its exact rejection and never probes',async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root),projectId=randomUUID(),asset=assets.values().next().value,bytes=Buffer.alloc(128*1024,7);
 mkdirSync(path.join(root,'media'),{mode:0o700});asset.relativePath='media/source.wav';asset.path=path.join(root,asset.relativePath);asset.projectId=projectId;
 asset.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(asset.path,bytes,{mode:0o600});
 snapshot.timeline.projectId=projectId;snapshot.assets=[{...asset}];
 let live=true;const expected=restriction(codes[1]),events=observe(t);
 await assert.rejects(prepareTimelineInputs(snapshot,{root,projectId,readAsset(){queueMicrotask(()=>{live=false;});return asset;},beforeEffect(){if(!live)throw expected;}}),error=>error===expected);
 assert.deepEqual(events,[]);assert.equal(await readFile(asset.path).then(value=>value.length),bytes.length);
 const prepared=await prepareTimelineInputs(snapshot,{root,projectId,readAsset:()=>asset,beforeEffect(){}});
 assert.equal(prepared.get(asset.id).sha256,asset.sha256);assert.equal(started(events).length,1);
});

test('fileInfo and stitch reject expiry after input ffprobe without output or later ffmpeg',async t=>{
 const root=await fixture(t),source=path.join(root,'source');await writeFile(source,'input');let live=true;
 const events=observe(t,event=>{if(event.type==='exited')live=false;}),expected=restriction(codes[2]),beforeEffect=()=>{if(!live)throw expected;};
 await assert.rejects(fileInfo(source,{beforeEffect}),error=>error===expected);
 live=true;await assert.rejects(stitch([source],path.join(root,'never.mp4'),{beforeEffect}),error=>error===expected);
 assert.deepEqual(started(events).map(event=>event.kind),['ffprobe','ffprobe']);
 assert.equal((await readdir(root)).includes('never.mp4'),false);
});

test('capability expiry after listing does not launch proof or remap restriction into a result',async t=>{
 await fixture(t);let live=true;const events=observe(t,event=>{if(event.type==='exited')live=false;});
 for(const code of codes){live=true;const expected=restriction(code);await assert.rejects(assertTimelineExportCapability(delivery,{beforeEffect(){if(!live)throw expected;}}),error=>error===expected);}
 assert.equal(started(events).length,codes.length);
});

for(const stopAfter of [1,2,3])test(`timeline expiry after child ${stopAfter} prevents every later segment/concat/probe`,async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root),destination=await output(t,root);let live=true,exited=0;
 const events=observe(t,event=>{if(event.type==='exited'&&++exited===stopAfter)live=false;}),expected=restriction();
 await assert.rejects(renderTimeline(snapshot,assets,destination.file,{beforeEffect(){destination.check();if(!live)throw expected;}}),error=>error===expected);
 assert.equal(started(events).length,stopAfter);assert.equal(started(events).some(event=>event.kind==='ffprobe'),false);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('revoked timeline cleanup preserves replaced output inode and unknown nested children',async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root),destination=await output(t,root);let live=true,work;
 const expected=restriction(codes[3]),events=observe(t,event=>{
  if(event.type!=='exited'||!live)return;
  work=path.join(root,readdirSync(root).find(name=>name.startsWith('.timeline-render-')));
  const segment=path.join(work,'segment-000.mov');unlinkSync(segment);writeFileSync(segment,'replacement-must-survive');
  mkdirSync(path.join(work,'unknown'));writeFileSync(path.join(work,'unknown','keep'),'foreign-child');live=false;
 });
 await assert.rejects(renderTimeline(snapshot,assets,destination.file,{beforeEffect(){destination.check();if(!live)throw expected;}}),error=>error===expected);
 assert.equal(started(events).length,1);assert.equal(await readFile(path.join(work,'segment-000.mov'),'utf8'),'replacement-must-survive');
 assert.equal(await readFile(path.join(work,'unknown','keep'),'utf8'),'foreign-child');
 assert.deepEqual((await readdir(work)).sort(),['segment-000.mov','unknown']);
});

test('timeline cleanup never follows a replaced work directory',async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root),destination=await output(t,root);let work,moved,live=true;
 const expected=restriction(),events=observe(t,event=>{
  if(event.type!=='exited'||!live)return;
  work=path.join(root,readdirSync(root).find(name=>name.startsWith('.timeline-render-')));moved=work+'-moved';renameSync(work,moved);
  mkdirSync(work);writeFileSync(path.join(work,'keep'),'replacement-directory');live=false;
 });
 await assert.rejects(renderTimeline(snapshot,assets,destination.file,{beforeEffect(){if(!live)throw expected;}}),error=>error===expected);
 assert.equal(started(events).length,1);assert.equal(await readFile(path.join(work,'keep'),'utf8'),'replacement-directory');
 assert.equal(await readFile(path.join(moved,'segment-000.mov'),'utf8'),'synthetic-owned-output');
});

test('subtitle font copy rechecks before each write and removes only its owned partial file on expiry',async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root,{subtitles:true}),destination=await output(t,root),events=observe(t);let copied=0;
 const expected=restriction();
 await assert.rejects(renderTimeline(snapshot,assets,destination.file,{beforeEffect(){
  destination.check();const name=readdirSync(root).find(name=>name.startsWith('.timeline-render-'));if(!name)return;
  try{copied=lstatSync(path.join(root,name,'subtitle-font.otf')).size;}catch{return;}
  if(copied>=64*1024)throw expected;
 }}),error=>error===expected);
 assert.equal(copied,64*1024);assert.deepEqual(events,[]);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

for(const stopAfter of [1,2])test(`subtitle ${stopAfter===1?'inspection':'measurement'} expiry never starts a media segment and cleans all known subtitle files`,async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root,{subtitles:true}),destination=await output(t,root);let live=true;
 let exited=0;const expected=restriction(),events=observe(t,event=>{if(event.type==='exited'&&++exited===stopAfter)live=false;});
 await assert.rejects(renderTimeline(snapshot,assets,destination.file,{beforeEffect(){destination.check();if(!live)throw expected;}}),error=>error===expected);
 assert.deepEqual(started(events).map(event=>event.kind),Array(stopAfter).fill('ffmpeg'));assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('valid guarded subtitle render and omitted-callback legacy paths preserve their normal results',async t=>{
 const root=await fixture(t),{snapshot,assets}=timeline(root,{subtitles:true}),destination=await output(t,root),events=observe(t);let checks=0;
 const result=await renderTimeline(snapshot,assets,destination.file,{beforeEffect(){checks++;destination.check();}});
 assert.equal(result.width,720);assert.ok(checks>20);assert.deepEqual(started(events).map(event=>event.kind),[...Array(5).fill('ffmpeg'),'ffprobe']);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
 const normal=timeline(root),legacy=path.join(root,'legacy.mp4');await renderTimeline(normal.snapshot,normal.assets,legacy);
 assert.equal(await readFile(legacy,'utf8'),'synthetic-owned-output');
 const imported=await fileInfo(legacy);assert.equal(imported.hasVideo,true);
 await stitch([legacy],path.join(root,'stitched.mp4'));
 assert.deepEqual(await inspectTimelineExportCapability(delivery),{status:'incomplete',code:'EXPORT_CAPABILITY_FAILED'});
 assert.deepEqual(await terminateMediaProcesses(),[]);
});
