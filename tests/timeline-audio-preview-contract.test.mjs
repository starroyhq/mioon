import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  AUDIO_PREVIEW_PROFILE,AUDIO_PREVIEW_LIMITS,audioPreviewSchemas,
  audioPreviewPlanInputSchema,audioPreviewSourceInputSchema,audioPreviewPlanSchema,
  buildAudioPreviewPlan,isAudioPreviewPlan,audioPreviewPlanDigestMaterial,
  deriveTimelineAudioSamples,audioPreviewEnvelopeAtSample,audioPreviewEnvelopeGainAtLocalSample,
} from '../packages/contracts/src/timeline-audio-preview.ts';
import {timelineCompositionSegments} from '../packages/contracts/src/timeline-segments.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=text=>createHash('sha256').update(text).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture({durationFrames=900,startFrame=0,trackCount=1}={}){
  const projectId=id(1),timelineId=id(2),assetId=id(3);
  const input={projectId,timelineId,expectedRevision:7,startFrame};
  const tracks=Array.from({length:trackCount},(_,i)=>({id:id(10+i),kind:'audio',orderIndex:i,hidden:false,muted:false}));
  const snapshot={timeline:{id:timelineId,projectId,revision:7,fps:30,durationFrames,tracks,
    clips:[{id:id(30),trackId:tracks[0].id,assetId,startFrame:0,durationFrames,sourceInFrame:0,gain:1}]},
    assets:[{id:assetId,projectId,sha256:'a'.repeat(64),sizeBytes:1000,mimeType:'audio/wav',duration:600,hasAudio:true}]};
  return {input,snapshot};
}
const planOf=f=>buildAudioPreviewPlan(f.input,f.snapshot,hash);
const throwsCode=(fn,code)=>assert.throws(fn,error=>error?.code===code);

test('composition segments preserve every exact global edge, gap and readonly bound',()=>{
  const timeline={durationFrames:30,clips:[{startFrame:20,durationFrames:10},
    {startFrame:5,durationFrames:10},{startFrame:10,durationFrames:5},{startFrame:5,durationFrames:10}]};
  const before=JSON.stringify(timeline),segments=timelineCompositionSegments(timeline);
  assert.deepEqual(segments,[{beginFrame:0,endFrame:5},{beginFrame:5,endFrame:10},
    {beginFrame:10,endFrame:15},{beginFrame:15,endFrame:20},{beginFrame:20,endFrame:30}]);
  assert.equal(JSON.stringify(timeline),before);assert.ok(Object.isFrozen(segments));
  assert.ok(segments.every(Object.isFrozen));
  assert.deepEqual(timelineCompositionSegments({durationFrames:0,clips:[]}),[]);
  const maximum=timelineCompositionSegments({durationFrames:200,
    clips:Array.from({length:100},(_,index)=>({startFrame:2*index+1,durationFrames:1}))});
  assert.equal(maximum.length,200);
  assert.deepEqual(maximum[199],{beginFrame:199,endFrame:200});
});

test('strict public inputs admit only saved identity and fixed source binding',()=>{
  const {input}=fixture();
  assert.deepEqual(audioPreviewSchemas['timeline.audioPreview.plan'].parse(input),input);
  const source={...input,clipId:id(30),sourceHash:'a'.repeat(64),planHash:'b'.repeat(64)};
  assert.deepEqual(audioPreviewSourceInputSchema.parse(source),source);
  for(const extra of [{path:'/private.wav'},{url:'https://example.test/media'},{filter:'volume=8'},
    {stream:0},{codec:'aac'},{endFrame:5},{plan:{}},{gain:1},{requestId:id(100)}]){
    assert.equal(audioPreviewPlanInputSchema.safeParse({...input,...extra}).success,false);
    assert.equal(audioPreviewSourceInputSchema.safeParse({...source,...extra}).success,false);
  }
  for(const patch of [{startFrame:-1},{startFrame:18000},{startFrame:1.2},{expectedRevision:0},
    {expectedRevision:Infinity},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{projectId:'foreign'},
    {timelineId:'foreign'},{sourceHash:'A'.repeat(64)}]){
    assert.equal(audioPreviewSourceInputSchema.safeParse({...source,...patch}).success,false);
  }
});

test('builds exact max20s or remaining saved interval without changing legacy fields',()=>{
  const f=fixture(),before=JSON.stringify(f),plan=planOf(f);
  assert.equal(plan.status,'planned');assert.equal(plan.profileId,AUDIO_PREVIEW_PROFILE);
  assert.deepEqual(plan.range,{startFrame:0,endFrame:600,startSample:0,endSample:960000,sampleFrames:960000});
  assert.equal(plan.sources.length,1);assert.equal(plan.voices.length,1);
  assert.equal(plan.sources[0].pcmBytes,7_680_000);assert.equal(plan.sources[0].sampleFrames,960000);
  assert.equal(plan.memory.retainedPcmBytes,7_680_000);assert.equal(plan.memory.largestSourcePcmBytes,7_680_000);
  assert.equal(plan.memory.admittedBytes,4*7_680_000+2*1024*1024);assert.equal(plan.memory.hashReadBytes,2000);
  assert.deepEqual(plan.sources[0].decodeSegments,[{sourceInFrame:0,frameCount:900,trimStartFrame:0,outputFrames:600}]);
  assert.deepEqual(plan.work,{decodedSourceFrames:901,decodeSegments:1});
  assert.equal(plan.planHash,hash(audioPreviewPlanDigestMaterial(plan)));
  assert.ok(isAudioPreviewPlan(plan,f.input));assert.equal(JSON.stringify(f),before);
  assert.equal(Object.hasOwn(f.snapshot.timeline.clips[0],'fadeInFrames'),false);
  assert.equal(plan.voices[0].fadeInFrames,0);assert.equal(plan.voices[0].fadeOutFrames,0);
  const tail=fixture({startFrame:899});assert.deepEqual(planOf(tail).range,
    {startFrame:899,endFrame:900,startSample:1_438_400,endSample:1_440_000,sampleFrames:1600});
  throwsCode(()=>planOf(fixture({startFrame:900})),'AUDIO_PREVIEW_RANGE_BOUNDS');
  const empty=fixture({durationFrames:0});empty.snapshot.timeline.clips=[];
  throwsCode(()=>planOf(empty),'AUDIO_PREVIEW_RANGE_BOUNDS');
});

test('retains original clip clock/fades while mapping just its trimmed intersection',()=>{
  const f=fixture({startFrame:350});
  Object.assign(f.snapshot.timeline.clips[0],{sourceInFrame:100,fadeInFrames:450,fadeOutFrames:450,gain:2});
  const plan=planOf(f),source=plan.sources[0],voice=plan.voices[0];
  assert.equal(source.sourceInFrame,450);assert.equal(source.durationFrames,550);
  assert.deepEqual(source.decodeSegments,[{sourceInFrame:100,frameCount:900,trimStartFrame:350,outputFrames:550}]);
  assert.deepEqual(plan.work,{decodedSourceFrames:901,decodeSegments:1});
  assert.equal(voice.startFrame,0);assert.equal(voice.durationFrames,900);assert.equal(voice.sourceInFrame,100);
  assert.equal(voice.intersectionStartFrame,350);assert.equal(voice.intersectionEndFrame,900);
  assert.equal(audioPreviewEnvelopeAtSample(voice,350*1600),2*350/450);
  assert.equal(audioPreviewEnvelopeAtSample(voice,450*1600),2);
  assert.equal(audioPreviewEnvelopeAtSample(voice,899*1600),2/450);
  assert.equal(audioPreviewEnvelopeAtSample(voice,900*1600),0);
  assert.equal(audioPreviewEnvelopeAtSample(voice,350*1600-1),0);
  assert.deepEqual(deriveTimelineAudioSamples(voice,350),{startSample:0,endSample:1_440_000,durationSamples:1_440_000,
    sourceInSample:160000,offsetSamples:560000,sourceSample:720000,fadeInSamples:720000,fadeOutSamples:720000,fadeOutStartSample:720000});
});

test('zero gain and track mute silence, hidden video remains audible, known silent media stays silent',()=>{
  for(const mutate of [f=>{f.snapshot.timeline.clips[0].gain=0;},f=>{f.snapshot.timeline.tracks[0].muted=true;},
    f=>{f.snapshot.assets[0].hasAudio=false;}]){
    const f=fixture();mutate(f);const plan=planOf(f);
    assert.deepEqual(plan.sources,[]);assert.deepEqual(plan.voices,[]);
    assert.deepEqual(plan.memory,{retainedPcmBytes:0,largestSourcePcmBytes:0,transportReserveBytes:2*1024*1024,
      admittedBytes:2*1024*1024,hashReadBytes:0});
    assert.deepEqual(plan.work,{decodedSourceFrames:0,decodeSegments:0});
  }
  const video=fixture();Object.assign(video.snapshot.timeline.tracks[0],{kind:'video',hidden:true});
  video.snapshot.assets[0].mimeType='video/mp4';assert.equal(planOf(video).voices.length,1);
  const still=clone(video);Object.assign(still.snapshot.assets[0],{mimeType:'image/png',duration:0});
  delete still.snapshot.assets[0].hasAudio;assert.equal(planOf(still).voices.length,0);
  still.snapshot.assets[0].hasAudio=true;throwsCode(()=>planOf(still),'AUDIO_PREVIEW_INVALID_SNAPSHOT');
});

test('muted and image clip edges preserve export reseeks including the pre-window prefix',()=>{
  const f=fixture({durationFrames:900,startFrame:350,trackCount:3});
  f.snapshot.timeline.tracks[1].muted=true;
  Object.assign(f.snapshot.timeline.tracks[2],{kind:'video',hidden:true});
  f.snapshot.assets.push({...f.snapshot.assets[0],id:id(4),mimeType:'image/png',duration:0,hasAudio:false});
  f.snapshot.timeline.clips.push(
    {...f.snapshot.timeline.clips[0],id:id(31),trackId:id(11),startFrame:200,durationFrames:200},
    {...f.snapshot.timeline.clips[0],id:id(32),trackId:id(12),assetId:id(4),startFrame:550,durationFrames:100});
  const before=JSON.stringify(f),plan=planOf(f);
  assert.equal(plan.voices.length,1);assert.equal(plan.sources.length,1);
  assert.deepEqual(plan.sources[0].decodeSegments,[
    {sourceInFrame:200,frameCount:200,trimStartFrame:150,outputFrames:50},
    {sourceInFrame:400,frameCount:150,trimStartFrame:0,outputFrames:150},
    {sourceInFrame:550,frameCount:100,trimStartFrame:0,outputFrames:100},
    {sourceInFrame:650,frameCount:250,trimStartFrame:0,outputFrames:250},
  ]);
  assert.deepEqual(plan.work,{decodedSourceFrames:704,decodeSegments:4});
  assert.equal(JSON.stringify(f),before);
  const changed=clone(f);changed.snapshot.timeline.clips[1].durationFrames=201;
  const updated=planOf(changed);
  assert.equal(updated.sources[0].sourceInFrame,plan.sources[0].sourceInFrame);
  assert.equal(updated.sources[0].durationFrames,plan.sources[0].durationFrames);
  assert.notEqual(updated.sources[0].sourceKey,plan.sources[0].sourceKey);
  assert.notEqual(updated.planHash,plan.planHash);
});

test('matching requested source intervals dedupe only when their original decode segments also match',()=>{
  const f=fixture({durationFrames:200,trackCount:2});
  f.snapshot.timeline.clips[0].durationFrames=100;
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31),startFrame:100});
  const contiguous=planOf(f);
  assert.equal(contiguous.sources.length,1);assert.equal(contiguous.voices.length,2);
  assert.deepEqual(contiguous.work,{decodedSourceFrames:101,decodeSegments:1});
  f.snapshot.timeline.tracks[1].muted=true;
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(32),trackId:id(11),startFrame:50,durationFrames:10});
  const segmented=planOf(f);
  assert.equal(segmented.sources.length,2);assert.equal(segmented.voices.length,2);
  assert.deepEqual(segmented.sources.map(source=>[source.assetId,source.sourceHash,source.sourceInFrame,source.durationFrames]),
    Array(2).fill([id(3),'a'.repeat(64),0,100]));
  assert.deepEqual(segmented.sources[0].decodeSegments,[
    {sourceInFrame:0,frameCount:50,trimStartFrame:0,outputFrames:50},
    {sourceInFrame:50,frameCount:10,trimStartFrame:0,outputFrames:10},
    {sourceInFrame:60,frameCount:40,trimStartFrame:0,outputFrames:40},
  ]);
  assert.deepEqual(segmented.sources[1].decodeSegments,[{sourceInFrame:0,frameCount:100,trimStartFrame:0,outputFrames:100}]);
  assert.notEqual(segmented.sources[0].sourceKey,segmented.sources[1].sourceKey);
  assert.deepEqual(segmented.work,{decodedSourceFrames:204,decodeSegments:4});
});

test('unknown media audio fails closed even when muted, zero gain, or outside the window',()=>{
  for(const state of ['missing',null])for(const silent of ['muted','gain','outside']){
    const f=fixture({trackCount:2});
    f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31),trackId:id(11),assetId:id(4)});
    f.snapshot.assets.push({...f.snapshot.assets[0],id:id(4)});
    if(state==='missing')delete f.snapshot.assets[1].hasAudio;else f.snapshot.assets[1].hasAudio=state;
    if(silent==='muted')f.snapshot.timeline.tracks[1].muted=true;
    if(silent==='gain')f.snapshot.timeline.clips[1].gain=0;
    if(silent==='outside')Object.assign(f.snapshot.timeline.clips[1],{startFrame:800,durationFrames:100});
    throwsCode(()=>planOf(f),'AUDIO_PREVIEW_AUDIO_UNKNOWN');
  }
});

test('cross-track voices sum independently and dedupe only exact prepared source identities',()=>{
  const f=fixture({durationFrames:600,trackCount:3});
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31),trackId:id(11),gain:0.5},
    {...f.snapshot.timeline.clips[0],id:id(32),trackId:id(12),sourceInFrame:1,gain:2});
  const plan=planOf(f);
  assert.equal(plan.voices.length,3);assert.equal(plan.sources.length,2);
  assert.equal(plan.voices[0].sourceKey,plan.voices[1].sourceKey);
  assert.notEqual(plan.voices[0].sourceKey,plan.voices[2].sourceKey);
  assert.equal(plan.voices.reduce((sum,voice)=>sum+audioPreviewEnvelopeAtSample(voice,20),0),3.5);
  const ordered=clone(f);ordered.snapshot.timeline.clips.reverse();ordered.snapshot.timeline.tracks.reverse();
  assert.deepEqual(planOf(ordered),plan);
  const differentAsset=clone(f);differentAsset.snapshot.assets.push({...differentAsset.snapshot.assets[0],id:id(4)});
  differentAsset.snapshot.timeline.clips[1].assetId=id(4);assert.equal(planOf(differentAsset).sources.length,3);
  const differentLength=clone(f);differentLength.snapshot.timeline.clips[1].durationFrames=599;
  assert.equal(planOf(differentLength).sources.length,3);
  const differentHash=clone(f);differentHash.snapshot.assets[0].sha256='c'.repeat(64);
  assert.notEqual(planOf(differentHash).sources[0].sourceKey,plan.sources[0].sourceKey);
});

test('strict snapshot validates whole graph/ranges/gain/fades before audible filtering',()=>{
  const invalid=[
    f=>{f.snapshot.timeline.clips[0].gain=NaN;},f=>{f.snapshot.timeline.clips[0].gain=Infinity;},
    f=>{f.snapshot.timeline.clips[0].gain=2.01;},f=>{f.snapshot.timeline.clips[0].startFrame=0.5;},
    f=>{f.snapshot.timeline.clips[0].sourceInFrame=-1;},f=>{f.snapshot.timeline.clips[0].durationFrames=0;},
    f=>{f.snapshot.timeline.clips[0].fadeInFrames=901;},
    f=>{Object.assign(f.snapshot.timeline.clips[0],{fadeInFrames:500,fadeOutFrames:500});},
    f=>{f.snapshot.timeline.clips[0].fadeOutFrames=0.1;},
    f=>{f.snapshot.assets[0].hasAudio=false;f.snapshot.timeline.clips[0].fadeInFrames=1;},
    f=>{f.snapshot.timeline.durationFrames=901;},f=>{f.snapshot.timeline.fps=29.97;},
    f=>{f.snapshot.timeline.clips[0].trackId=id(999);},f=>{f.snapshot.assets[0].projectId=id(999);},
    f=>{f.snapshot.assets[0].duration=1;},f=>{f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31)});},
    f=>{f.snapshot.timeline.tracks.push({...f.snapshot.timeline.tracks[0]});},
    f=>{f.snapshot.assets.push({...f.snapshot.assets[0]});},
    f=>{f.snapshot.timeline.clips[0].filter='volume=1';},f=>{f.snapshot.assets[0].path='/private.wav';},
  ];
  for(const mutate of invalid){const f=fixture();mutate(f);throwsCode(()=>planOf(f),'AUDIO_PREVIEW_INVALID_SNAPSHOT');}
  const stale=fixture();stale.input.expectedRevision++;throwsCode(()=>planOf(stale),'AUDIO_PREVIEW_REVISION_CONFLICT');
  const wrong=fixture();wrong.input.timelineId=id(123);throwsCode(()=>planOf(wrong),'AUDIO_PREVIEW_INVALID_SNAPSHOT');
});

test('admission uses every distinct clipped source payload rather than track count',()=>{
  const f=fixture({durationFrames:600,trackCount:6});
  f.snapshot.timeline.clips=f.snapshot.timeline.tracks.map((track,i)=>({
    ...f.snapshot.timeline.clips[0],id:id(30+i),trackId:track.id,sourceInFrame:i*600,
  }));
  throwsCode(()=>planOf(f),'AUDIO_PREVIEW_MEMORY_LIMIT');
  f.snapshot.timeline.clips.pop();const plan=planOf(f);
  assert.equal(plan.sources.length,5);assert.equal(plan.memory.retainedPcmBytes,5*7_680_000);
  assert.equal(plan.memory.admittedBytes,12*7_680_000+2*1024*1024);
  assert.ok(plan.memory.admittedBytes<=AUDIO_PREVIEW_LIMITS.memoryBytes);
  const many=fixture({durationFrames:100});
  many.snapshot.timeline.clips=Array.from({length:100},(_,i)=>({...many.snapshot.timeline.clips[0],
    id:id(100+i),startFrame:i,durationFrames:1,sourceInFrame:i}));
  const admitted=planOf(many);assert.equal(admitted.voices.length,100);assert.equal(admitted.sources.length,100);
  many.snapshot.timeline.clips.push({...many.snapshot.timeline.clips[0],id:id(201)});
  throwsCode(()=>planOf(many),'AUDIO_PREVIEW_INVALID_SNAPSHOT');
});

test('per-source and aggregate double-hash caps reject complete interval without shortening',()=>{
  const f=fixture({durationFrames:30,trackCount:2});f.snapshot.assets[0].sizeBytes=AUDIO_PREVIEW_LIMITS.sourceBytes;
  assert.equal(planOf(f).memory.hashReadBytes,AUDIO_PREVIEW_LIMITS.hashReadBytes);
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31),trackId:id(11)});
  assert.equal(planOf(f).sources.length,1);
  f.snapshot.timeline.clips[1].sourceInFrame=1;throwsCode(()=>planOf(f),'AUDIO_PREVIEW_HASH_LIMIT');
  f.snapshot.assets[0].sizeBytes++;throwsCode(()=>planOf(f),'AUDIO_PREVIEW_SOURCE_LIMIT');
  const long=fixture();long.snapshot.assets[0].duration=600.01;throwsCode(()=>planOf(long),'AUDIO_PREVIEW_SOURCE_LIMIT');
});

test('decode work charges original prefixes, repeated work and every one-frame lookahead without truncation',()=>{
  const f=fixture({durationFrames:8999,startFrame:8998,trackCount:2});
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(31),trackId:id(11)});
  const shared=planOf(f);
  assert.equal(shared.sources.length,1);assert.deepEqual(shared.work,{decodedSourceFrames:9000,decodeSegments:1});
  f.snapshot.timeline.clips[1].sourceInFrame=1;
  const exact=planOf(f);
  assert.equal(exact.sources.length,2);assert.deepEqual(exact.work,{decodedSourceFrames:18000,decodeSegments:2});
  assert.equal(exact.memory.retainedPcmBytes,2*12800);
  f.input.startFrame=8999;f.snapshot.timeline.durationFrames=9000;
  for(const clip of f.snapshot.timeline.clips)clip.durationFrames=9000;
  const before=JSON.stringify(f);throwsCode(()=>planOf(f),'AUDIO_PREVIEW_BUDGET');
  assert.equal(JSON.stringify(f),before);
  const longest=fixture({durationFrames:17999,startFrame:17998});
  assert.deepEqual(planOf(longest).sources[0].decodeSegments,
    [{sourceInFrame:0,frameCount:17999,trimStartFrame:17998,outputFrames:1}]);
  assert.deepEqual(planOf(longest).work,{decodedSourceFrames:18000,decodeSegments:1});
  // Charge the lookahead even where EOF may stop actual demuxing earlier.
  throwsCode(()=>planOf(fixture({durationFrames:18000,startFrame:17999})),'AUDIO_PREVIEW_BUDGET');
  longest.snapshot.timeline.clips[0].sourceInFrame=2;
  throwsCode(()=>planOf(longest),'AUDIO_PREVIEW_INVALID_SNAPSHOT');
});

test('decode segment count is bounded across all distinct sources, with large valid segment arrays admitted',()=>{
  const f=fixture({durationFrames:300,trackCount:2});
  f.snapshot.timeline.tracks[1].muted=true;
  f.snapshot.timeline.clips.push(...Array.from({length:99},(_,index)=>({
    ...f.snapshot.timeline.clips[0],id:id(100+index),trackId:id(11),startFrame:2*index+1,durationFrames:1,
  })));
  const plan=planOf(f);
  assert.equal(plan.sources[0].decodeSegments.length,199);
  assert.deepEqual(plan.work,{decodedSourceFrames:499,decodeSegments:199});
  assert.ok(isAudioPreviewPlan(plan,f.input));
  f.snapshot.timeline.clips.pop();
  f.snapshot.timeline.tracks.push({id:id(12),kind:'audio',orderIndex:2,hidden:false,muted:false});
  f.snapshot.timeline.clips.push({...f.snapshot.timeline.clips[0],id:id(199),trackId:id(12),
    startFrame:1,durationFrames:3,sourceInFrame:1});
  assert.deepEqual(planOf(f).work,{decodedSourceFrames:503,decodeSegments:200});
  f.snapshot.timeline.clips.at(-1).durationFrames=4;
  throwsCode(()=>planOf(f),'AUDIO_PREVIEW_BUDGET');
  // Two audible paths each need 197 original segments: 394 child runs, even
  // though the selected PCM and decoded frame count are small.
  Object.assign(f.snapshot.timeline.clips.at(-1),{startFrame:0,durationFrames:300});
  throwsCode(()=>planOf(f),'AUDIO_PREVIEW_BUDGET');
});

test('response schema enforces exact counts, identity references, resource equations and strict fields',()=>{
  const f=fixture(),plan=planOf(f);
  for(const mutate of [p=>{p.range.sampleFrames--;},p=>{p.range.startSample++;},p=>{p.range.endFrame++;},
    p=>{p.sources[0].pcmBytes--;},p=>{p.sources[0].sourceInFrame++;},p=>{p.sources[0].sourceKey='f'.repeat(64);},
    p=>{p.sources[0].clipId=id(88);},p=>{p.sources[0].url='/media';},p=>{p.sources.push(clone(p.sources[0]));},
    p=>{p.voices[0].gain=0;},p=>{p.voices[0].fadeInFrames=901;},p=>{p.voices[0].intersectionStartFrame++;},
    p=>{p.voices[0].extra=true;},p=>{p.memory.retainedPcmBytes--;},p=>{p.memory.admittedBytes--;},
    p=>{p.memory.hashReadBytes++;},p=>{p.memory.extra=true;},p=>{p.path='/private';},p=>{p.planHash='A'.repeat(64);},
    p=>{p.profileId='future-preview';},p=>{p.sources[0].profileId='future-preview';},p=>{p.status='succeeded';}]){
    const bad=clone(plan);mutate(bad);assert.equal(audioPreviewPlanSchema.safeParse(bad).success,false);
    assert.equal(isAudioPreviewPlan(bad,f.input),false);
  }
  for(const patch of [{projectId:id(42)},{timelineId:id(42)},{expectedRevision:8},{startFrame:1}])
    assert.equal(isAudioPreviewPlan(plan,{...f.input,...patch}),false);
});

test('response rejects forged decode segments, cross-voice original bounds and work arithmetic',()=>{
  const f=fixture({durationFrames:900,startFrame:350}),plan=planOf(f);
  for(const mutate of [
    p=>{delete p.sources[0].decodeSegments;},p=>{p.sources[0].decodeSegments=[];},
    p=>{p.sources[0].decodeSegments[0].path='/private.wav';},
    p=>{p.sources[0].decodeSegments[0].sampleRate=44100;},
    p=>{p.sources[0].decodeSegments[0].sourceInFrame++;},
    p=>{p.sources[0].decodeSegments[0].frameCount=18001;},
    p=>{p.sources[0].decodeSegments[0].trimStartFrame++;},
    p=>{p.sources[0].decodeSegments[0].trimStartFrame=-1;},
    p=>{p.sources[0].decodeSegments[0].outputFrames++;},
    p=>{p.sources[0].decodeSegments[0].frameCount=899;},
    p=>{p.sources[0].decodeSegments.push(clone(p.sources[0].decodeSegments[0]));},
    p=>{p.sources[0].decodeSegments=Array(201).fill(p.sources[0].decodeSegments[0]);},
    p=>{delete p.work;},p=>{p.work.decodedSourceFrames--;},p=>{p.work.decodeSegments++;},
    p=>{p.work.rate=30;},
    p=>{p.sources[0].decodeSegments[0].frameCount++;p.work.decodedSourceFrames++;},
    p=>{p.voices[0].startFrame=100;p.voices[0].durationFrames=800;p.voices[0].sourceInFrame=100;},
  ]){
    const bad=clone(plan);mutate(bad);
    assert.equal(audioPreviewPlanSchema.safeParse(bad).success,false);
    assert.equal(isAudioPreviewPlan(bad,f.input),false);
  }
  const split=clone(plan);
  split.sources[0].decodeSegments=[
    {sourceInFrame:0,frameCount:400,trimStartFrame:350,outputFrames:50},
    {sourceInFrame:400,frameCount:500,trimStartFrame:0,outputFrames:500},
  ];
  split.work.decodeSegments=2;
  split.work.decodedSourceFrames++;
  assert.ok(audioPreviewPlanSchema.safeParse(split).success);
  // Structural validation cannot authenticate saved global edges. Digest
  // verification and the authoritative saved-data rebuild bind this change.
  assert.notEqual(hash(audioPreviewPlanDigestMaterial(split)),plan.planHash);
  for(const mutate of [
    p=>{p.sources[0].decodeSegments.reverse();},
    p=>{p.sources[0].decodeSegments[0].frameCount++;p.work.decodedSourceFrames++;},
    p=>{p.sources[0].decodeSegments[1].sourceInFrame--;p.sources[0].decodeSegments[1].trimStartFrame++;},
  ]){
    const bad=clone(split);mutate(bad);assert.equal(isAudioPreviewPlan(bad,f.input),false);
  }
});

test('canonical digest binds gain, fades, source hash, bytes, revision, range and profile with key-order stability',()=>{
  const f=fixture(),plan=planOf(f),material=audioPreviewPlanDigestMaterial(plan);
  const shuffled=Object.fromEntries(Object.entries(plan).reverse());assert.equal(audioPreviewPlanDigestMaterial(shuffled),material);
  for(const mutate of [p=>{p.voices[0].gain=0.5;},p=>{p.voices[0].fadeInFrames=50;},
    p=>{p.sources[0].sourceHash='b'.repeat(64);},p=>{p.timelineRevision++;},
    p=>{p.sources[0].sourceBytes++;p.memory.hashReadBytes+=2;}]){
    const changed=clone(plan);mutate(changed);assert.notEqual(hash(audioPreviewPlanDigestMaterial(changed)),plan.planHash);
  }
  const ownDigest=clone(plan);ownDigest.planHash='e'.repeat(64);assert.equal(audioPreviewPlanDigestMaterial(ownDigest),material);
  throwsCode(()=>buildAudioPreviewPlan(f.input,f.snapshot,()=> 'UPPERCASE'),'AUDIO_PREVIEW_INVALID_INPUT');
  const alternate=fixture({startFrame:1});assert.notEqual(planOf(alternate).planHash,plan.planHash);
});

test('hostile bounded boundary never evaluates getters or toJSON or traverses unbounded arrays',()=>{
  const f=fixture(),plan=planOf(f);let invoked=0;
  const getter=clone(plan);Object.defineProperty(getter,'sources',{enumerable:true,get(){invoked++;throw Error('getter');}});
  assert.equal(isAudioPreviewPlan(getter,f.input),false);assert.equal(invoked,0);
  const snapshot=clone(f.snapshot);Object.defineProperty(snapshot.timeline,'clips',{enumerable:true,get(){invoked++;throw Error('getter');}});
  throwsCode(()=>buildAudioPreviewPlan(f.input,snapshot,hash),'AUDIO_PREVIEW_INVALID_SNAPSHOT');assert.equal(invoked,0);
  const toJSON={...plan,toJSON(){invoked++;return plan;}};assert.equal(isAudioPreviewPlan(toJSON,f.input),false);assert.equal(invoked,0);
  const huge={...plan,sources:new Array(1_000_000)};assert.equal(isAudioPreviewPlan(huge,f.input),false);
  const cycle={...plan};cycle.cycle=cycle;assert.equal(isAudioPreviewPlan(cycle,f.input),false);
  const inherited=Object.create(plan);assert.equal(isAudioPreviewPlan(inherited,f.input),false);
});

test('half-open ramps, one-frame fades, meeting ramps and seeks use the identical integer sample clock',()=>{
  const f=fixture({durationFrames:4});Object.assign(f.snapshot.timeline.clips[0],{fadeInFrames:2,fadeOutFrames:2,gain:2});
  const voice=planOf(f).voices[0];
  for(const [sample,expected] of [[-1,0],[0,0],[1,2/3200],[1599,2*1599/3200],[1600,1],
    [3199,2*3199/3200],[3200,2],[4800,1],[6399,2/3200],[6400,0]])
    assert.equal(audioPreviewEnvelopeAtSample(voice,sample),expected,`sample ${sample}`);
  for(const frame of [0,1,2,3,4]){
    const mapping=deriveTimelineAudioSamples(voice,frame);assert.equal(mapping.offsetSamples,frame*1600);
    assert.equal(mapping.sourceSample,mapping.sourceInSample+mapping.offsetSamples);
  }
  const sought=clone(voice);sought.intersectionStartFrame=2;
  assert.equal(audioPreviewEnvelopeAtSample(sought,3200),audioPreviewEnvelopeAtSample(voice,3200));
  assert.equal(audioPreviewEnvelopeAtSample(sought,4800),audioPreviewEnvelopeAtSample(voice,4800));
  const interior=fixture({durationFrames:900});const bounded=planOf(interior).voices[0];
  assert.equal(audioPreviewEnvelopeAtSample(bounded,600*1600),0);
  assert.equal(audioPreviewEnvelopeGainAtLocalSample(bounded,600*1600),1);
  assert.equal(audioPreviewEnvelopeGainAtLocalSample(bounded,900*1600),1);
  assert.equal(audioPreviewEnvelopeGainAtLocalSample(voice,6400),0);
  throwsCode(()=>audioPreviewEnvelopeAtSample(voice,0.5),'AUDIO_PREVIEW_INVALID_INPUT');
  throwsCode(()=>deriveTimelineAudioSamples(voice,5),'AUDIO_PREVIEW_INVALID_INPUT');
  throwsCode(()=>deriveTimelineAudioSamples({...voice,fadeInFrames:null},0),'AUDIO_PREVIEW_INVALID_INPUT');
});
