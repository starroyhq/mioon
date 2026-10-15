import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTimelineMixLoudnessDecoder, planTimelineMixLoudnessDecode, TIMELINE_MIX_LOUDNESS_DECODE_LIMITS} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {timelineAudioSilenceFilter, timelineClipAudioFilter, timelineMixedAudioFilter} from '../packages/business/src/timeline-audio-filter-graph.ts';
import {timelineAudioFadeFilters} from '../packages/business/src/timeline-audio.mjs';
import {checkMediaEffect} from '../packages/business/src/media-runtime.mjs';

const clip = patch => ({id:'clip-a',trackId:'sound',assetId:'source',startFrame:0,durationFrames:6,sourceInFrame:3,gain:1,...patch});
const fixture = () => ({timeline:{fps:30,durationFrames:6,tracks:[{id:'sound',kind:'audio',orderIndex:1,hidden:false,muted:false}],clips:[clip()]},
  assets:new Map([['source',{file:'/private/source.wav',mimeType:'audio/wav',duration:10,hasAudio:true}]])});
const metadata = patch => JSON.stringify({streams:[{index:3,codec_type:'audio',codec_name:'aac',sample_rate:'44100',channels:2,channel_layout:'stereo',duration:'10',...patch}],
  format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'10',size:'40000'}});
const silentVideoMetadata = () => JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'h264',width:16,height:16,duration:'10'}],
  format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'10',size:'40000'}});
const pcm = (bytes,value=.25) => {const data=Buffer.alloc(bytes);for(let at=0;at+4<=bytes;at+=4)data.writeFloatLE(value,at);return data;};
const options = patch => ({beforeEffect(){},remainingMs:()=>120000,onPcm(){},...patch});
function runtime(patch={}) {
  const calls=[];
  return {calls,checkMediaEffect,async withProbePermit(_signal,work){calls.push('permit');return work();},
    async run(command,args,opts){calls.push({command,args,opts});opts.beforeSpawn();return metadata();},
    async runStreaming(command,args,opts){calls.push({command,args,opts});opts.beforeSpawn();opts.onStdout(pcm(opts.maxStdoutBytes));return {stdoutBytes:opts.maxStdoutBytes};},...patch};
}

test('shared filter literals retain legacy omitted fades, stream fallback, gain and selected output trim exactly',()=>{
  assert.equal(timelineAudioSilenceFilter(4800),'anullsrc=r=48000:cl=stereo,atrim=end_sample=4800,asetpts=N/SR/TB[silence]');
  assert.equal(timelineClipAudioFilter(clip({gain:1.375}),1,4800,2),'[2:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.375,apad,atrim=end_sample=4800,asetpts=N/SR/TB[a2]');
  assert.equal(timelineClipAudioFilter(clip({gain:.25,fadeInFrames:2,fadeOutFrames:3}),1,4800,4,7),
    '[4:7]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.25,apad,atrim=end_sample=4800,asettb=1/48000,asetpts=N+1600,afade=t=in:ss=0:ns=3200:curve=tri,afade=t=out:ss=4800:ns=4800:curve=tri,asetpts=N/SR/TB[a4]');
  assert.equal(timelineMixedAudioFilter(['silence','a1','a4'],4800,'atrim=start_sample=1600:end_sample=3200,'),
    '[silence][a1][a4]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=4800,atrim=start_sample=1600:end_sample=3200,asetpts=N/SR/TB[outa]');
  for(const gain of [0,.25,1,1.99,2])for(const fades of [{},{fadeInFrames:0,fadeOutFrames:0},{fadeInFrames:1},{fadeOutFrames:6},{fadeInFrames:3,fadeOutFrames:3}]){
    const value=clip({gain,...fades});
    assert.equal(timelineClipAudioFilter(value,4,1600,0,3),`[0:3]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${gain},apad,atrim=end_sample=1600,${timelineAudioFadeFilters(value,4)}asetpts=N/SR/TB[a0]`);
  }
});

test('historical 0343ed3 audio extraction preserves frozen b9e7d1e renderer bytes',async()=>{
  // This is a historical extraction proof, not a whole-file freeze on the live
  // renderer: accepted SDR LUT, PNG and JPEG features subsequently changed it.
  const fixture=JSON.parse(await readFile(new URL('./fixtures/timeline-mix-loudness/renderer-extraction-0343ed3.json',import.meta.url),'utf8'));
  assert.equal(fixture.sourceCommit,'0343ed390a85c319210b5f179180cf9c8c3985c2');
  assert.equal(fixture.sourcePath,'packages/business/src/timeline-media.mjs');
  assert.equal(fixture.beforeExtractionCommit,'b9e7d1e57a687010407ae284cb55c0d4eed23abb');
  assert.equal(fixture.sourceSha256,'4b5f850dfc388d972ab42decfff5f76b5951315b16ab73902a7dcaec411fae37');
  assert.equal(createHash('sha256').update(fixture.source).digest('hex'),fixture.sourceSha256);
  assert.equal(fixture.beforeExtractionSha256,'c1586a7dc67f2e0c44ff5a4cc97262e71181f258a0fc66646fc5bac83e25fa95');
  let source=fixture.source;
  for(const [replacement,original] of [
    ["import {timelineAudioSilenceFilter,timelineClipAudioFilter,timelineMixedAudioFilter} from './timeline-audio-filter-graph.ts';","import {timelineAudioFadeFilters} from './timeline-audio.mjs';"],
    ['timelineAudioSilenceFilter(samples)','`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`'],
    ['timelineClipAudioFilter(clip,begin,samples,input,asset.audioStreamIndex)','`[${input}:${asset.audioStreamIndex??\'a:0\'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip,begin)}asetpts=N/SR/TB[${label}]`'],
    ['timelineMixedAudioFilter(sounds,samples,selected.audioOutputTrim)','`${sounds.map(s=>`[${s}]`).join(\'\')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},${selected.audioOutputTrim}asetpts=N/SR/TB[outa]`'],
  ]){assert.equal(source.split(replacement).length,2);source=source.replace(replacement,original);}
  assert.equal(createHash('sha256').update(source).digest('hex'),'c1586a7dc67f2e0c44ff5a4cc97262e71181f258a0fc66646fc5bac83e25fa95');
});

test('current renderer retains exact shared audio helper wiring and unchanged trusted filter literals',async()=>{
  const source=await readFile(new URL('../packages/business/src/timeline-media.mjs',import.meta.url),'utf8');
  for(const wiring of [
    "import {timelineAudioSilenceFilter,timelineClipAudioFilter,timelineMixedAudioFilter} from './timeline-audio-filter-graph.ts';",
    "`,timelineAudioSilenceFilter(samples)];\n   let visual='base';const sounds=['silence'];",
    "filters.push(timelineClipAudioFilter(clip,begin,samples,input,asset.audioStreamIndex));sounds.push(label);",
    "filters.push(timelineMixedAudioFilter(sounds,samples,selected.audioOutputTrim));",
  ])assert.equal(source.split(wiring).length,2,`exact single production wiring: ${wiring}`);
  const helper=await readFile(new URL('../packages/business/src/timeline-audio-filter-graph.ts',import.meta.url));
  // Retain the original accepted source proof. The current helper adds only a
  // non-null processing branch; legacy literals are exercised above and below.
  const historical=JSON.parse(await readFile(new URL('./fixtures/timeline-mix-loudness/filter-helper-b8821e7.json',import.meta.url),'utf8'));
  assert.equal(historical.sourceCommit,'b8821e70b7eaafd84305fe6d0d4d8b40aaedf657');
  assert.equal(createHash('sha256').update(historical.source).digest('hex'),'7701c38b8b2001da046d4801bb981607cbedf24635e489acdfc776cf477c5779');
  assert.equal(historical.sourceSha256,'7701c38b8b2001da046d4801bb981607cbedf24635e489acdfc776cf477c5779');
  assert.equal(createHash('sha256').update(helper).digest('hex'),'c9a288be8773aed61390c37f0fa52b50f8c19a8160c0fbc1d409807ba66c1ee6');
});

test('typed fade extraction preserves the old helper body byte-for-byte and its public import path',async()=>{
  const helper=await readFile(new URL('../packages/business/src/timeline-audio-filter-graph.ts',import.meta.url),'utf8');
  const body=helper.slice(helper.indexOf('// The render graph'),helper.indexOf('/** Pure trusted renderer primitives.'))
    .replace("export function timelineAudioFadeFilters(clip: Pick<TimelineAudioFilterClip, 'startFrame' | 'durationFrames' | 'fadeInFrames' | 'fadeOutFrames'>,\n  segmentStartFrame: number): string {",'export function timelineAudioFadeFilters(clip, segmentStartFrame) {').trimEnd()+'\n';
  const original="import {deriveTimelineAudioSamples} from '@mioon/contracts/timeline-audio-preview';\n"+body;
  assert.equal(createHash('sha256').update(original).digest('hex'),'1154c4fdbaefceeeb1bf6d9f7ccccbf004ce5e7262afa4a48ac10ae853f7dcbb');
  const shim=await readFile(new URL('../packages/business/src/timeline-audio.mjs',import.meta.url),'utf8');
  assert.match(shim,/export \{timelineAudioFadeFilters\} from '\.\/timeline-audio-filter-graph\.ts';/u);
});

test('global image/muted/zero-gain edges retain every original reseek and include silent gaps',async()=>{
  const {timeline,assets}=fixture();timeline.clips[0]=clip({startFrame:1,durationFrames:4});
  timeline.tracks.push({id:'visual',kind:'video',orderIndex:0,hidden:false,muted:false},{id:'muted',kind:'audio',orderIndex:2,hidden:false,muted:true});
  timeline.clips.push(clip({id:'image',trackId:'visual',assetId:'image',startFrame:0,durationFrames:2,sourceInFrame:0,gain:1}),
    clip({id:'muted',trackId:'muted',startFrame:3,durationFrames:3}),clip({id:'zero',startFrame:5,durationFrames:1,gain:0}));
  assets.set('image',{file:'/private/unused.png',mimeType:'image/png',duration:null,hasAudio:false});
  const plan=planTimelineMixLoudnessDecode(timeline,assets);assert.deepEqual(plan,{sampleFrames:9600,pcmBytes:76800,segmentCount:5,decodeWorkFrames:7});
  const r=runtime(),result=await createTimelineMixLoudnessDecoder(r)(timeline,assets,options());assert.deepEqual(result,{sampleRate:48000,channels:2,...plan});
  assert.equal(r.calls.filter(call=>call.command==='ffprobe').length,1);
  const calls=r.calls.filter(call=>call.command==='ffmpeg');assert.equal(calls.length,5);
  assert.deepEqual(calls.map(call=>call.args.includes('-ss')?call.args[call.args.indexOf('-ss')+1]:null),[null,'0.100000000','0.133333333','0.166666667',null]);
  assert.ok(calls[0].args[calls[0].args.indexOf('-filter_complex')+1].includes('amix=inputs=1:'));
  assert.ok(calls.every(call=>!call.args.includes('-c:v')&&!call.args.includes('libx264')&&call.args.at(-1)==='pipe:1'));
});

test('actual selected index, gain/fades, bounded seek and restrictions use one probe per unique source',async()=>{
  const {timeline,assets}=fixture();timeline.clips[0]=clip({gain:1.5,fadeInFrames:2,fadeOutFrames:2});
  const r=runtime();await createTimelineMixLoudnessDecoder(r)(timeline,assets,options());
  const probe=r.calls.find(call=>call.command==='ffprobe'),decode=r.calls.find(call=>call.command==='ffmpeg');
  assert.equal(probe.args[probe.args.indexOf('-format_whitelist')+1],'mov,matroska,mp3,wav');
  assert.equal(decode.args[decode.args.indexOf('-ss')+1],'0.100000000');assert.equal(decode.args[decode.args.indexOf('-t')+1],'0.233333333');
  assert.equal(decode.args[decode.args.indexOf('-f')+1],'mov');assert.ok(decode.args.includes('-xerror'));
  assert.equal(decode.args[decode.args.indexOf('-enable_drefs')+1],'0');assert.equal(decode.args[decode.args.indexOf('-use_absolute_path')+1],'0');
  const filter=decode.args[decode.args.indexOf('-filter_complex')+1];assert.match(filter,/\[0:3\].*volume=1\.5,apad/u);assert.match(filter,/asetpts=N\+0,afade=t=in:ss=0:ns=3200:curve=tri,afade=t=out:ss=6400:ns=3200:curve=tri/u);
  assert.doesNotMatch(filter,/loudnorm|alimiter|dynaudnorm|normalize=1/u);assert.equal(decode.opts.maxStdoutBytes,76800);
});

test('borrowed arbitrary chunks stream sequentially into a caller-owned continuous sink without a whole PCM allocation',async()=>{
  for(const size of [1,3,7,15,65537]){
    const {timeline,assets}=fixture(),expected=pcm(76800),pieces=[];
    const r=runtime({async runStreaming(_command,_args,opts){for(let at=0;at<expected.length;at+=size){const chunk=Buffer.from(expected.subarray(at,at+size));opts.onStdout(chunk);chunk.fill(0);}return {stdoutBytes:expected.length};}});
    const result=await createTimelineMixLoudnessDecoder(r)(timeline,assets,options({onPcm:chunk=>pieces.push(Buffer.from(chunk))}));
    assert.deepEqual(Buffer.concat(pieces),expected);assert.equal(result.pcmBytes,76800);assert.equal(Object.hasOwn(result,'pcm'),false);
  }
});

test('resource planner charges per-input original segments and one-frame overread before any media effect',async()=>{
  const {timeline,assets}=fixture();timeline.durationFrames=18000;timeline.clips[0]=clip({durationFrames:18000,sourceInFrame:0});assets.get('source').duration=600;
  assert.equal(planTimelineMixLoudnessDecode(timeline,assets).decodeWorkFrames,18001);
  timeline.tracks.push({id:'other',kind:'audio',orderIndex:2,hidden:false,muted:false});timeline.clips.push(clip({id:'other',trackId:'other',durationFrames:18000,sourceInFrame:0}));
  const r=runtime();await assert.rejects(createTimelineMixLoudnessDecoder(r)(timeline,assets,options()),{code:'TIMELINE_MIX_LOUDNESS_BUDGET'});assert.deepEqual(r.calls,[]);
  assert.equal(TIMELINE_MIX_LOUDNESS_DECODE_LIMITS.totalTwoPassPcmBytes,460800000);assert.equal(TIMELINE_MIX_LOUDNESS_DECODE_LIMITS.totalTwoPassDecodeWorkFrames,72000);
});

test('invalid input, effects, paths, source bounds and unsupported actual streams never silently become silence',async()=>{
  for(const mutate of [f=>f.timeline.fps=29,f=>f.timeline.durationFrames=18001,f=>f.timeline.clips[0].gain=NaN,
    f=>f.timeline.clips[0].gain=2.01,f=>f.timeline.clips[0].effects=[],f=>f.timeline.clips[0].fadeInFrames=7,
    f=>f.timeline.clips[0].fadeInFrames=null,f=>f.timeline.clips[0].sourceInFrame=-1,
    f=>f.assets.get('source').file='https://invalid/source',f=>f.assets.get('source').file='/bad\0path']){
    const f=fixture();mutate(f);const r=runtime();await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options()),{code:'MEDIA_INVALID_CONFIGURATION'});assert.deepEqual(r.calls,[]);
  }
  for(const patch of [{channels:6,channel_layout:'5.1'},{index:undefined},{codec_name:'unknown'},{duration:'0'}]){
    const f=fixture(),r=runtime({async run(){return metadata(patch);}});await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options()),{code:patch.codec_name==='unknown'?'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH':'TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT'});assert.equal(r.calls.filter(call=>call.command==='ffmpeg').length,0);
  }
});

test('natural EOF must have the exact finite stereo count for every segment',async()=>{
  for(const [bytes,receipt,code] of [[pcm(76792),{stdoutBytes:76792},'TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH'],
    [pcm(76799),{stdoutBytes:76799},'TIMELINE_MIX_LOUDNESS_INVALID_PCM'],[pcm(76808),{stdoutBytes:76808},'TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH'],
    [pcm(76800),{stdoutBytes:76799},'TIMELINE_MIX_LOUDNESS_INVALID_PCM'],
    ...[NaN,Infinity,-Infinity].map(value=>[pcm(76800,value),{stdoutBytes:76800},'TIMELINE_MIX_LOUDNESS_INVALID_PCM'])]){
    const f=fixture(),r=runtime({async runStreaming(_command,_args,opts){opts.onStdout(bytes);return receipt;}});
    await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options()),{code});
  }
  const f=fixture(),r=runtime({async runStreaming(_command,_args,opts){opts.onStdout(pcm(76800));throw Object.assign(Error('failed'),{code:'MEDIA_EXIT_FAILED'});}});
  await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options()),{code:'MEDIA_EXIT_FAILED'});
});

test('fences, cancellation, synchronous sink and termination doubt retain the exact original failure',async()=>{
  const f=fixture();
  for(const boundary of ['dequeue','probe','spawn','chunk','finish']){
    let revoked=false;const denied=Object.assign(Error('changed'),{code:'TIMELINE_MIX_LOUDNESS_STALE'});
    const r=runtime({async withProbePermit(_signal,work){if(boundary==='dequeue')revoked=true;return work();},
      async run(){if(boundary==='probe')revoked=true;return metadata();},
      async runStreaming(_command,_args,opts){if(boundary==='spawn')revoked=true;opts.beforeSpawn();if(boundary==='chunk')revoked=true;opts.onStdout(pcm(76800));if(boundary==='finish')revoked=true;return {stdoutBytes:76800};}});
    await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options({beforeEffect(){if(revoked)throw denied;}})),error=>error===denied);
  }
  const r=runtime({async runStreaming(_command,_args,opts){try{opts.onStdout(pcm(76800));}catch{throw Object.assign(Error('sanitized'),{code:'MEDIA_STREAM_FAILED',terminationUnconfirmed:true});}}});
  const denied=Object.assign(Error('consumer failed'),{code:'SINK_FAILED'});
  await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options({onPcm(){throw denied;}})),error=>error===denied&&error.terminationUnconfirmed===true);
  await assert.rejects(createTimelineMixLoudnessDecoder(runtime())(f.timeline,f.assets,options({async onPcm(){}})),{code:'MEDIA_INVALID_CONFIGURATION'});
  await assert.rejects(createTimelineMixLoudnessDecoder(runtime())(f.timeline,f.assets,options({signal:AbortSignal.abort()})),{code:'MEDIA_CANCELLED'});
  await assert.rejects(createTimelineMixLoudnessDecoder(runtime())(f.timeline,f.assets,options({remainingMs:()=>0})),{code:'TIMELINE_MIX_LOUDNESS_BUDGET'});
});

test('stored false video with real audio is rejected before any mixed PCM or candidate can be published',async()=>{
  const f=fixture();f.timeline.tracks[0].kind='video';Object.assign(f.assets.get('source'),{mimeType:'video/mp4',hasAudio:false});
  const r=runtime();await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options({onPcm(){assert.fail('metadata mismatch must not publish PCM');}})),
    {code:'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  assert.equal(r.calls.filter(call=>call.command==='ffprobe').length,1);assert.equal(r.calls.filter(call=>call.command==='ffmpeg').length,0);
});

test('stored true video with no actual audio rejects the same exact presence mismatch',async()=>{
  const f=fixture();f.timeline.tracks[0].kind='video';f.assets.get('source').mimeType='video/mp4';
  const r=runtime({async run(){return silentVideoMetadata();}});
  await assert.rejects(createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options()),{code:'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  assert.equal(r.calls.filter(call=>call.command==='ffmpeg').length,0);
});

test('legitimate stored false video is probed once without audio work, including a hidden video',async()=>{
  for(const hidden of [false,true]){
    const f=fixture();Object.assign(f.timeline.tracks[0],{kind:'video',hidden});Object.assign(f.assets.get('source'),{mimeType:'video/mp4',hasAudio:false});
    const r=runtime({async run(command,args,opts){r.calls.push({command,args,opts});return silentVideoMetadata();}});
    assert.equal(planTimelineMixLoudnessDecode(f.timeline,f.assets).decodeWorkFrames,0);
    const result=await createTimelineMixLoudnessDecoder(r)(f.timeline,f.assets,options());assert.equal(result.sampleFrames,9600);
    assert.equal(r.calls.filter(call=>call.command==='ffprobe').length,1);assert.equal(r.calls.filter(call=>call.command==='ffmpeg').length,1);
    assert.ok(!r.calls.find(call=>call.command==='ffmpeg').args.includes('-i'));
  }
});
