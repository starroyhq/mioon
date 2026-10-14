import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveTimelineExportDelivery} from '@mioon/contracts';
import {createTimelineMixLoudnessDecoder, planTimelineMixLoudnessDecode} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {timelineAudioFadeFilters} from '../packages/business/src/timeline-audio.mjs';
import {timelineCompositionSegments} from '@mioon/contracts/timeline-segments';
import {run, runStreaming, checkMediaEffect} from '../packages/business/src/media-runtime.mjs';
import {withProbePermit, MEDIA_PROBE_LIMITS} from '../packages/business/src/media-probe.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';

const actualRuntime={run,runStreaming,checkMediaEffect,withProbePermit},actualDecode=createTimelineMixLoudnessDecoder(actualRuntime);
const seconds=frames=>(frames/30).toFixed(9),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const options=patch=>({beforeEffect(){},remainingMs:()=>120000,onPcm(){},...patch});
const encode=args=>run('ffmpeg',['-hide_banner','-loglevel','error','-n','-threads','1','-filter_threads','1','-filter_complex_threads','1',...args],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:65536});
async function sandbox(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-mix-loudness-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function wave(duration=2,rate=48000,channels=2,sample=(n,c)=>(c?-.3:.4)*Math.sin(2*Math.PI*733*n/rate)){
  const samples=Math.round(duration*rate),data=Buffer.alloc(44+samples*channels*4);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(3,20);data.writeUInt16LE(channels,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*channels*4,28);
  data.writeUInt16LE(channels*4,32);data.writeUInt16LE(32,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);
  for(let n=0;n<samples;n++)for(let c=0;c<channels;c++)data.writeFloatLE(sample(n,c),44+(n*channels+c)*4);return data;
}
async function collect(timeline,assets,extra={}){const chunks=[];const receipt=await actualDecode(timeline,assets,options({...extra,onPcm:chunk=>chunks.push(Buffer.from(chunk))}));return {receipt,pcm:Buffer.concat(chunks)};}
async function manifest(root){return Promise.all((await readdir(root)).sort().map(async name=>[name,sha(await readFile(path.join(root,name)))]));}
const track=(id,orderIndex,patch={})=>({id,kind:'audio',orderIndex,muted:false,hidden:false,...patch});
const clip=(id,trackId,assetId,patch={})=>({id,trackId,assetId,startFrame:0,durationFrames:6,sourceInFrame:0,gain:1,...patch});

/** Literal frozen b9e7d1e audio graph. No new shared graph helper is used.
 * Keep original renderer input enumeration (including visual-only inputs),
 * frame overread, numerical strings and clip-relative fade ordering. */
async function originalRendererAudio(timeline,assets){
  const chunks=[],tracks=new Map(timeline.tracks.map(item=>[item.id,item]));let bytes=0;
  for(const {beginFrame:begin,endFrame:end} of timelineCompositionSegments(timeline)){
    const frames=end-begin,samples=frames*1600;
    const clips=timeline.clips.filter(c=>c.startFrame<=begin&&c.startFrame+c.durationFrames>=end).sort((a,b)=>tracks.get(a.trackId).orderIndex-tracks.get(b.trackId).orderIndex||a.id.localeCompare(b.id));
    const args=['-hide_banner','-loglevel','error','-n','-filter_complex_threads','1'],inputs=[];
    for(const clip of clips){
      const asset=assets.get(clip.assetId),lane=tracks.get(clip.trackId),visual=lane.kind==='video'&&!lane.hidden,audio=asset.hasAudio&&!lane.muted&&clip.gain>0;
      if(!visual&&!audio)continue;const input=inputs.length,isImage=asset.mimeType.startsWith('image/');args.push('-threads','1');
      if(isImage)args.push('-loop','1','-framerate','30');else args.push('-ss',seconds(clip.sourceInFrame+begin-clip.startFrame));
      args.push('-t',seconds(frames+1),'-i',asset.file);inputs.push({clip,asset,audio,input});
    }
    const filters=[`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`],sounds=['silence'];
    for(const {clip,asset,input,audio} of inputs)if(audio){const label=`a${input}`;
      filters.push(`[${input}:${asset.audioStreamIndex??'a:0'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip,begin)}asetpts=N/SR/TB[${label}]`);sounds.push(label);}
    filters.push(`${sounds.map(s=>`[${s}]`).join('')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},asetpts=N/SR/TB[outa]`);
    args.push('-filter_complex',filters.join(';'),'-map','[outa]','-vn','-sn','-dn','-threads','1','-c:a','pcm_f32le','-ar','48000','-ac','2','-f','f32le','pipe:1');
    const result=await runStreaming('ffmpeg',args,{timeout:30000,maxStdoutBytes:samples*8,maxStderrBytes:65536,onStdout:chunk=>chunks.push(Buffer.from(chunk))});
    assert.equal(result.stdoutBytes,samples*8);bytes+=result.stdoutBytes;
  }
  return Buffer.concat(chunks,bytes);
}

test('real full mixed float PCM matches original export graph exactly at every image/muted/zero/silent seam',{timeout:120000},async t=>{
  const root=await sandbox(t),wav=path.join(root,'44100.wav'),aac=path.join(root,'44100.m4a'),mono=path.join(root,'mono.wav'),image=path.join(root,'image.png'),short=path.join(root,'short.wav'),embedded=path.join(root,'embedded.mp4');
  await writeFile(wav,wave(2,44100));await writeFile(mono,wave(2,48000,1,(n)=>.3*Math.sin(2*Math.PI*997*n/48000)));
  await writeFile(short,wave(.18,48000,2,(n,c)=>(c?-.17:.22)*Math.sin(2*Math.PI*440*n/48000)));
  await encode(['-i',wav,'-c:a','aac','-b:a','192k',aac]);
  await encode(['-f','lavfi','-i','color=c=black:s=16x16:r=30:d=1.2','-i',short,'-i',mono,'-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','libx264','-preset','ultrafast','-c:a','aac','-threads','1','-t','1.2',embedded]);
  await encode(['-f','lavfi','-i','color=c=red:s=16x16','-frames:v','1','-threads','1',image]);
  const assets=new Map([['aac',{file:aac,mimeType:'audio/mp4',duration:2,hasAudio:true,audioStreamIndex:0}],['mono',{file:mono,mimeType:'audio/wav',duration:2,hasAudio:true,audioStreamIndex:0}],
    ['embedded',{file:embedded,mimeType:'video/mp4',duration:1.2,hasAudio:true,audioStreamIndex:1}],['image',{file:image,mimeType:'image/png',duration:null,hasAudio:false}]]);
  const timeline={fps:30,durationFrames:36,tracks:[track('image',0,{kind:'video'}),track('hidden',1,{kind:'video',hidden:true}),track('main',2),track('mono',3),track('muted',4,{muted:true}),track('zero',5)],
    clips:[clip('image1','image','image',{durationFrames:9}),clip('image2','image','image',{startFrame:12,durationFrames:24}),
      clip('main','main','aac',{startFrame:4,durationFrames:28,sourceInFrame:7,gain:1.25,fadeInFrames:5,fadeOutFrames:7}),
      clip('mono1','mono','mono',{durationFrames:12,sourceInFrame:1,gain:.7}),clip('mono2','mono','mono',{startFrame:17,durationFrames:19,sourceInFrame:2,gain:.4}),
      clip('hidden','hidden','embedded',{startFrame:3,durationFrames:33,gain:1.6}),clip('muted','muted','aac',{startFrame:8,durationFrames:19,sourceInFrame:2,gain:2}),
      clip('zero','zero','aac',{startFrame:10,durationFrames:4,gain:0})]};
  const before=await manifest(root),frozen=structuredClone(timeline),events=[],off=onMediaProcess(event=>events.push(event));let result;
  try{result=await collect(timeline,assets);}finally{off();}
  const reference=await originalRendererAudio(timeline,assets);assert.deepEqual(result.pcm,reference);assert.equal(result.pcm.length,36*1600*8);assert.deepEqual(timeline,frozen);
  const plan=planTimelineMixLoudnessDecode(timeline,assets);assert.equal(events.filter(e=>e.type==='started'&&e.kind==='ffprobe').length,3);
  assert.equal(events.filter(e=>e.type==='started'&&e.kind==='ffmpeg').length,plan.segmentCount);
  let active=0,maximum=0;for(const event of events){active+=event.type==='started'?1:-1;maximum=Math.max(maximum,active);}assert.equal(maximum,1);assert.equal(active,0);
  const candidate={...timeline,clips:timeline.clips.map(c=>({...c,gain:c.gain>0?c.gain/2:0}))};
  const applied=await collect(candidate,assets);assert.deepEqual(applied.pcm,await originalRendererAudio(candidate,assets));assert.notEqual(sha(applied.pcm),sha(result.pcm));
  const meter=createExportLoudnessAccumulator(timeline.durationFrames/30);await actualDecode(timeline,assets,options({onPcm:chunk=>meter.write(chunk)}));
  const one=createExportLoudnessAccumulator(timeline.durationFrames/30);one.write(reference);assert.deepEqual(meter.finish(),one.finish(),'meter state must span every original render segment');
  assert.deepEqual(await manifest(root),before,'no source writes, rendered asset, filter script or staging directory');
  t.diagnostic(JSON.stringify({segmentCount:plan.segmentCount,sampleFrames:result.receipt.sampleFrames,decodeWorkFrames:plan.decodeWorkFrames,referenceMaxAbsError:0,actualMaximumChildren:maximum,pcmHash:sha(reference)}));
});

test('real headroom stays above one and fully silent compositions keep exact natural EOF',{timeout:30000},async t=>{
  const root=await sandbox(t),file=path.join(root,'headroom.wav');await writeFile(file,wave(.4,48000,2,(_n,c)=>c?-1.5:1.25));
  const assets=new Map([['source',{file,mimeType:'audio/wav',duration:.4,hasAudio:true}]]),timeline={fps:30,durationFrames:12,tracks:[track('audio',0)],clips:[clip('tone','audio','source',{durationFrames:12,gain:1.5})]};
  const result=await collect(timeline,assets);assert.equal(result.pcm.readFloatLE(0),1.875);assert.equal(result.pcm.readFloatLE(4),-2.25);
  const silent={...timeline,tracks:[track('audio',0,{muted:true})]};const events=[],off=onMediaProcess(event=>events.push(event));let silence;
  try{silence=await collect(silent,assets);}finally{off();}
  assert.equal(silence.pcm.length,12*1600*8);assert.ok(silence.pcm.every(byte=>byte===0));assert.equal(events.filter(e=>e.type==='started'&&e.kind==='ffprobe').length,0);
});

test('real malformed AAC and missing selected audio cannot be hidden by the silence-first pad',{timeout:30000},async t=>{
  const root=await sandbox(t),wav=path.join(root,'valid.wav'),valid=path.join(root,'valid.m4a'),corrupt=path.join(root,'corrupt.m4a'),video=path.join(root,'video.mp4');
  await writeFile(wav,wave(.4));await encode(['-i',wav,'-c:a','aac','-b:a','128k',valid]);
  const packets=JSON.parse(await run('ffprobe',['-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pos,size','-of','json',valid],{timeout:10000,maxStdoutBytes:131072,maxStderrBytes:65536})).packets;
  const bytes=await readFile(valid);assert.ok(packets.length>1);for(const packet of packets)bytes.fill(0,Number(packet.pos),Number(packet.pos)+Number(packet.size));await writeFile(corrupt,bytes);
  const timeline={fps:30,durationFrames:6,tracks:[track('audio',0)],clips:[clip('tone','audio','source')]};
  const assets=new Map([['source',{file:corrupt,mimeType:'audio/mp4',duration:.4,hasAudio:true}]]);
  await assert.rejects(collect(timeline,assets),error=>['MEDIA_EXIT_FAILED','MEDIA_PROCESS_FAILED'].includes(error.code));
  await encode(['-f','lavfi','-i','color=c=black:s=16x16:r=30:d=0.4','-an','-c:v','libx264','-preset','ultrafast',video]);
  assets.get('source').file=video;await assert.rejects(collect(timeline,assets),{code:'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  assets.get('source').file=path.join(root,'missing.m4a');await assert.rejects(collect(timeline,assets),error=>['MEDIA_EXIT_FAILED','MEDIA_PROCESS_FAILED'].includes(error.code));
});

test('real queued probe cancellation and active child cancellation never leave an owned process',{timeout:30000},async t=>{
  const root=await sandbox(t),file=path.join(root,'cancel.wav');await writeFile(file,wave(.4));
  const assets=new Map([['source',{file,mimeType:'audio/wav',duration:.4,hasAudio:true}]]),timeline={fps:30,durationFrames:6,tracks:[track('audio',0)],clips:[clip('tone','audio','source')]};
  const releases=[],blockers=Array.from({length:MEDIA_PROBE_LIMITS.concurrent},()=>withProbePermit(undefined,()=>new Promise(resolve=>releases.push(resolve))));
  while(releases.length<MEDIA_PROBE_LIMITS.concurrent)await new Promise(resolve=>setImmediate(resolve));
  let controller=new AbortController(),events=[],off=onMediaProcess(event=>events.push(event));
  try{const pending=assert.rejects(collect(timeline,assets,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});controller.abort();await pending;assert.deepEqual(events,[]);}
  finally{releases.forEach(release=>release());await Promise.all(blockers);off();}
  controller=new AbortController();events=[];off=onMediaProcess(event=>{events.push(event);if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});
  try{await assert.rejects(collect(timeline,assets,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});}finally{off();}
  assert.deepEqual(events.map(e=>e.type),['started','exited','started','exited']);assert.throws(()=>process.kill(events.at(-1).pid,0),{code:'ESRCH'});
});

test('real stored video audio-presence parity rejects both mismatches and verifies genuine silence',{timeout:30000},async t=>{
  const root=await sandbox(t),wav=path.join(root,'tone.wav'),audible=path.join(root,'audible.mp4'),silent=path.join(root,'silent.mp4');
  await writeFile(wav,wave(.4));
  await encode(['-f','lavfi','-i','color=c=black:s=16x16:r=30:d=0.4','-i',wav,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-c:a','aac','-threads','1',audible]);
  await encode(['-f','lavfi','-i','color=c=black:s=16x16:r=30:d=0.4','-an','-c:v','libx264','-preset','ultrafast',silent]);
  const timeline={fps:30,durationFrames:6,tracks:[track('video',0,{kind:'video',hidden:true})],clips:[clip('video','video','source')]};
  const assets=new Map([['source',{file:audible,mimeType:'video/mp4',duration:.4,hasAudio:false}]]),events=[],off=onMediaProcess(event=>events.push(event));
  try{await assert.rejects(collect(timeline,assets),{code:'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});}finally{off();}
  assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffprobe').length,1);assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,0);
  Object.assign(assets.get('source'),{file:silent,hasAudio:true});
  await assert.rejects(collect(timeline,assets),{code:'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  assets.get('source').hasAudio=false;const result=await collect(timeline,assets);assert.equal(result.receipt.decodeWorkFrames,0);assert.equal(result.pcm.length,6*1600*8);assert.ok(result.pcm.every(byte=>byte===0));
});

function originalRendererSource(current){
  let source=current;
  for(const [replacement,original] of [
    ["import {timelineAudioSilenceFilter,timelineClipAudioFilter,timelineMixedAudioFilter} from './timeline-audio-filter-graph.ts';","import {timelineAudioFadeFilters} from './timeline-audio.mjs';"],
    ['timelineAudioSilenceFilter(samples)','`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`'],
    ['timelineClipAudioFilter(clip,begin,samples,input,asset.audioStreamIndex)','`[${input}:${asset.audioStreamIndex??\'a:0\'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip,begin)}asetpts=N/SR/TB[${label}]`'],
    ['timelineMixedAudioFilter(sounds,samples,selected.audioOutputTrim)','`${sounds.map(s=>`[${s}]`).join(\'\')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},${selected.audioOutputTrim}asetpts=N/SR/TB[outa]`'],
  ]){assert.equal(source.split(replacement).length,2);source=source.replace(replacement,original);}
  assert.equal(sha(Buffer.from(source)),'c1586a7dc67f2e0c44ff5a4cc97262e71181f258a0fc66646fc5bac83e25fa95','reconstructed renderer is the exact b9e7d1e source, without invoking git');
  return source;
}

/** Only test-owned temporary modules are written. Apart from import URLs,
 * module bodies stay untouched. The shared runtime wrapper records argv and
 * forwards every call/options to the same real runner. Instrumented copies of
 * media and capability modules also expose their real ffprobe/proof argv. */
async function instrumentedRenderers(root){
  const business=new URL('../packages/business/src/',import.meta.url),runtimeURL=new URL('media-runtime.mjs',business).href;
  const captureURL=pathToFileURL(path.join(root,'capture-runtime.mjs')).href;
  await writeFile(new URL(captureURL),`import * as actual from ${JSON.stringify(runtimeURL)};\nexport const calls=[];\nexport {checkMediaEffect,isMediaEffectRestriction} from ${JSON.stringify(runtimeURL)};\nexport const run=(command,args,options)=>{calls.push({lane:'run',command,args:[...args]});return actual.run(command,args,options);};\nexport const runStreaming=(command,args,options)=>{calls.push({lane:'streaming',command,args:[...args]});return actual.runStreaming(command,args,options);};\n`,{flag:'wx',mode:0o600});
  const copiedMediaURL=pathToFileURL(path.join(root,'captured-media.mjs')).href,copiedCapabilityURL=pathToFileURL(path.join(root,'captured-capability.mjs')).href;
  const redirect=new Map([[runtimeURL,captureURL],[new URL('media.mjs',business).href,copiedMediaURL],[new URL('timeline-export-capabilities.mjs',business).href,copiedCapabilityURL]]);
  const resolveImports=(source,origin)=>source.replace(/\bfrom\s+(['"])([^'"]+)\1/gu,(_match,_quote,specifier)=>{
    const resolved=specifier.startsWith('.')?new URL(specifier,origin).href:import.meta.resolve(specifier);
    return `from ${JSON.stringify(redirect.get(resolved)??resolved)}`;
  });
  for(const [file,target] of [['media.mjs',copiedMediaURL],['timeline-export-capabilities.mjs',copiedCapabilityURL]]){
    const origin=new URL(file,business);await writeFile(new URL(target),resolveImports(await readFile(origin,'utf8'),origin),{flag:'wx',mode:0o600});
  }
  const rendererURL=new URL('timeline-media.mjs',business),current=await readFile(rendererURL,'utf8'),old=originalRendererSource(current);
  const modules=[];
  for(const [name,source] of [['old',old],['new',current]]){
    const file=pathToFileURL(path.join(root,`${name}-renderer.mjs`));await writeFile(file,resolveImports(source,rendererURL),{flag:'wx',mode:0o600});modules.push(await import(file.href));
  }
  const {calls}=await import(captureURL);return {old:modules[0].renderTimeline,current:modules[1].renderTimeline,calls};
}

test('complete v1 and float-v2 render argv and final MP4 bytes match the reconstructed baseline exactly',{timeout:90000},async t=>{
  const root=await sandbox(t),image=path.join(root,'golden-image.png'),wav=path.join(root,'golden-44100.wav');
  await encode(['-f','lavfi','-i','color=c=blue:s=16x16','-frames:v','1','-threads','1',image]);await writeFile(wav,wave(1,44100,1,n=>.3*Math.sin(2*Math.PI*523*n/44100)));
  const imageAsset={id:'image',path:image,mimeType:'image/png',duration:0,width:16,height:16,hasVideo:true,hasAudio:false,videoStreamIndex:0},
    audioAsset={id:'audio',path:wav,mimeType:'audio/wav',duration:1,width:0,height:0,hasVideo:false,hasAudio:true,audioStreamIndex:0},assets=new Map([['image',imageAsset],['audio',audioAsset]]);
  const rect={x:0,y:0,width:720,height:720},timeline={fps:30,width:720,height:720,durationFrames:12,
    tracks:[track('video',0,{kind:'video'}),track('audio',1),track('muted',2,{muted:true})],
    clips:[{...clip('image-a','video','image',{durationFrames:5}),rect},{...clip('image-b','video','image',{startFrame:7,durationFrames:5}),rect},
      {...clip('audio','audio','audio',{durationFrames:12,sourceInFrame:3,gain:.75,fadeInFrames:3,fadeOutFrames:4}),rect},
      {...clip('muted','muted','audio',{startFrame:3,durationFrames:6,sourceInFrame:2,gain:2}),rect}]};
  const sourcesBefore=[sha(await readFile(image)),sha(await readFile(wav))],renderers=await instrumentedRenderers(root),frozen=structuredClone(timeline);
  const decodePcm=async file=>{const chunks=[];await runStreaming('ffmpeg',['-v','error','-threads','1','-i',file,'-map','0:a:0','-vn','-c:a','pcm_f32le','-f','f32le','pipe:1'],
    {timeout:30000,maxStdoutBytes:1024*1024,maxStderrBytes:65536,onStdout:chunk=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks);};
  for(const profileId of ['mp4_h264_v1','mp4_h264_float_checked_v2']){
    const snapshot={timeline,delivery:resolveTimelineExportDelivery(timeline,{profileId,resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}})},outputs=[];
    for(const [name,render] of [['old',renderers.old],['new',renderers.current]]){
      const destination=path.join(root,`${name}-${profileId}.mp4`),offset=renderers.calls.length;
      const result=await render(snapshot,assets,destination);
      // Only actual private output locations vary. Source paths, all filter
      // text, maps, codecs, arguments and argument order remain literal.
      const calls=renderers.calls.slice(offset).map(call=>({...call,args:call.args.map(arg=>arg.replaceAll(destination,'<OUTPUT>')
        .replace(/\.timeline-render-[A-Za-z0-9_-]+(?=\/)/gu,'.timeline-render-<PRIVATE>')
        .replace(/\.timeline-float-proof-[A-Za-z0-9_-]+(?=\/)/gu,'.timeline-float-proof-<PRIVATE>'))}));
      outputs.push({calls,bytes:await readFile(destination),pcm:await decodePcm(destination),result});
    }
    assert.deepEqual(outputs[1].calls,outputs[0].calls,`${profileId}: every actual render, proof and probe argv must match`);
    assert.equal(sha(outputs[1].bytes),sha(outputs[0].bytes),`${profileId}: final MP4 content hash must match without metadata normalization`);
    assert.deepEqual(outputs[1].bytes,outputs[0].bytes);assert.deepEqual(outputs[1].pcm,outputs[0].pcm);
    assert.equal(Object.hasOwn(outputs[0].result,'audioCheck'),profileId==='mp4_h264_float_checked_v2');
    if(profileId==='mp4_h264_float_checked_v2')assert.deepEqual(outputs[1].result.audioCheck,outputs[0].result.audioCheck);
    t.diagnostic(JSON.stringify({profileId,exactArgvCalls:outputs[0].calls.length,mp4Bytes:outputs[0].bytes.length,mp4Sha256:sha(outputs[0].bytes),decodedPcmSha256:sha(outputs[0].pcm)}));
  }
  assert.deepEqual(timeline,frozen);assert.deepEqual([sha(await readFile(image)),sha(await readFile(wav))],sourcesBefore);
  assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-')),false,'old and new private staging both cleaned up');
});
