import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSync, openSync, realpathSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, instantiateSpeedPreset, splitTimeMap, timeMapPlanFrames,
  timeMapSourceAtOutputFrame, TIMELINE_SPEED_PRESETS,
} from '../packages/contracts/src/timeline-time-map.ts';
import type {CompiledTimeMap, TimeMapBasis, TimeMapResult, TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {assertSpeedExportVideoCapability, prepareSpeedExportVideo} from '../packages/business/src/timeline-speed-export-video.ts';
import type {SpeedExportReverseVideo} from '../packages/business/src/timeline-speed-export-video.ts';

const clock = {fpsNumerator:30,fpsDenominator:1};
const frameBytes = 16 * 16;
function unwrap<T>(value: TimeMapResult<T>): T {
  assert.ok(value.ok, JSON.stringify(value));
  return value.value;
}
function motion(speed: TimeMapSpeed, sourceFrames: number, direction: 'forward'|'reverse'='forward') {
  const basis: TimeMapBasis = {profile:'timeline-speed-v1',sourceFps:clock,outputFps:clock,
    sourceRange:{start:{kind:'rational',numerator:'0',denominator:'1'},
      end:{kind:'rational',numerator:String(sourceFrames),denominator:'1'}},speed};
  const plan=initialTimeMap(unwrap(compileTimeMap(basis)),direction);
  const timing: ClipTiming = {profile:'timeline-speed-v1',basis,view:{direction,loTime:{anchor:'start',offsetOutputFrames:0},
    hiTime:{anchor:'end',offsetOutputFrames:0}},outputWindow:plan.outputWindow,interpolation:'off',pitchShift:false};
  return {timing,plan};
}
const constant = (numerator: number, denominator: number) => ({kind:'constant' as const,rate:{numerator,denominator}});

async function fixture(t:test.TestContext) {
  const root=await mkdtemp(path.join(realpathSync(tmpdir()),'speed-export-video-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let count=0;
  return {root,async stage(source:string,timing:ClipTiming,plan:CompiledTimeMap,maxBytes?:number,reverse?:SpeedExportReverseVideo) {
    const slot=String(count++);
    return prepareSpeedExportVideo({source:{path:source,videoStreamIndex:0},reverse,timing,plan,
      file:path.join(root,slot+'.media'),scriptFile:path.join(root,slot+'.filter'),maxBytes,
      reserve:file=>closeSync(openSync(file,'wx',0o600)),
      writeOwnedFile:(file,body)=>writeFile(file,body,{flag:'wx',mode:0o600})});
  }};
}

async function reverseFixture(root:string,source:string,firstSourceOrdinal:number,frameCount:number): Promise<SpeedExportReverseVideo> {
  const file=path.join(root,'reverse.mkv');
  const end=firstSourceOrdinal+frameCount;
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-i',source,'-an','-filter_threads','1',
    '-vf',`trim=start_frame=${firstSourceOrdinal}:end_frame=${end},reverse,settb=1/30,setpts=N`,
    '-c:v','ffv1','-threads:v','1','-pix_fmt','+gray','-fps_mode','passthrough',file]);
  return {file,firstSourceOrdinal,frameCount,storage:'matroska'};
}

async function sourceFixture(root:string,frames:number,{variable=false,nativeFps=30}: {variable?:boolean;nativeFps?:number}={}): Promise<string> {
  const file=path.join(root,variable?'variable.mov':`cfr-${nativeFps}.mov`);
  const variableFilter=variable ? [ '-vf',`settb=1/300,setpts='N*10+if(eq(N,${frames-1}),0,if(eq(mod(N,3),1),-2,3*eq(mod(N,3),2)))'`,
    '-fps_mode','passthrough','-enc_time_base','1/300','-video_track_timescale','300'] : [];
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
    `nullsrc=size=16x16:rate=${nativeFps},format=gray,geq=lum=N`,...variableFilter,
    '-frames:v',String(frames),'-c:v','png','-threads:v','1',file]);
  return file;
}

async function readRaw(file:string,pixFmt:string): Promise<Buffer> {
  const chunks:Buffer[]=[];
  await runStreaming('ffmpeg',['-nostdin','-hide_banner','-v','error','-i',file,'-c:v','rawvideo','-threads:v','1',
    '-pix_fmt',`+${pixFmt}`,'-fps_mode','passthrough','-f','rawvideo','-'],{onStdout:chunk=>{chunks.push(chunk);}});
  return Buffer.concat(chunks);
}

async function readOrdinals(file:string): Promise<number[]> {
  const bytes=await readRaw(file,'gray');
  assert.equal(bytes.length%frameBytes,0);
  return Array.from({length:bytes.length/frameBytes},(_,ordinal)=>{
    const value=bytes[ordinal*frameBytes]!;
    assert.ok(bytes.subarray(ordinal*frameBytes,(ordinal+1)*frameBytes).every(byte=>byte===value));
    return value;
  });
}

test('actual CFR filters preserve eight rate plans and use lookup for a fractional right split', async t=>{
  const f=await fixture(t), source=await sourceFixture(f.root,60);
  await assertSpeedExportVideoCapability();
  for (const [p,q] of [[1,10],[1,4],[1,2],[11,10],[3,2],[2,1],[4,1],[10,1]] as const) {
    const {timing,plan}=motion(constant(p,q),60);
    const staged=await f.stage(source,timing,plan);
    assert.equal(staged.path,'cfr');
    assert.equal(staged.frameCount,plan.durationFrames);
    assert.deepEqual(await readOrdinals(staged.file),Array.from(unwrap(timeMapPlanFrames(plan))));
    if (p===3) {
      const right=unwrap(splitTimeMap(plan,1)).right;
      const result=await f.stage(source,timing,right);
      assert.equal(result.path,'lookup');
      assert.deepEqual(await readOrdinals(result.file),Array.from(unwrap(timeMapPlanFrames(right))));
    }
  }
});

test('curve selection and a freeze use source-clock frames, including repeated and skipped ordinals', async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,150);
  for (const {id} of TIMELINE_SPEED_PRESETS) {
    const {timing,plan}=motion(unwrap(instantiateSpeedPreset(id,0,150)),150);
    const staged=await f.stage(source,timing,plan);
    assert.deepEqual(await readOrdinals(staged.file),Array.from(unwrap(timeMapPlanFrames(plan))),id);
  }
  const plan=initialTimeMap(unwrap(compileFreezeTimeMap({sourceFrame:43,durationFrames:7,sourceFps:clock,outputFps:clock})));
  const staged=await f.stage(source,{profile:'timeline-freeze-v1',sourceFrame:43,sourceVersionId:null,sourceSha256:'a'.repeat(64)},plan);
  assert.equal(staged.path,'freeze');
  assert.deepEqual(await readOrdinals(staged.file),Array(7).fill(43));
});

test('VFR maps the shared continuous source clock into native frame PTS', async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,60,{variable:true});
  const {timing,plan}=motion(constant(3,2),60);
  const staged=await f.stage(source,timing,plan);
  assert.equal(staged.path,'lookup');
  const pts=Array.from({length:60},(_,frame)=>frame*10+(frame===59?0:frame%3===1?-2:frame%3===2?3:0));
  const truth=Array.from({length:plan.durationFrames},(_,index)=>{
    const position=unwrap(timeMapSourceAtOutputFrame(plan,index)).source;
    assert.equal(position.kind,'exact');
    const ticks=BigInt(position.numerator)*10n;
    return pts.findLastIndex(pts=>BigInt(pts)*BigInt(position.denominator)<=ticks);
  });
  assert.deepEqual(await readOrdinals(staged.file),truth);
});

test('synthetic reverse FFV1 proxies supply the original shared ordinals for each preset and a partial split',async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,150),proxy=await reverseFixture(f.root,source,0,150);
  for (const {id} of TIMELINE_SPEED_PRESETS) {
    const {timing,plan}=motion(unwrap(instantiateSpeedPreset(id,0,150)),150,'reverse');
    const staged=await f.stage(source,timing,plan,undefined,proxy);
    assert.equal(staged.path,'lookup');
    assert.deepEqual(await readOrdinals(staged.file),Array.from(unwrap(timeMapPlanFrames(plan))),id);
  }
  const {timing,plan}=motion(constant(3,2),150,'reverse');
  const partial=unwrap(splitTimeMap(plan,17)).left;
  const expected=Array.from(unwrap(timeMapPlanFrames(partial)));
  const partialDirectory=await mkdtemp(path.join(f.root,'partial-'));
  const first=expected.at(-1)!;
  const partialProxy=await reverseFixture(partialDirectory,source,first,150-first);
  assert.deepEqual(await readOrdinals((await f.stage(source,timing,partial,undefined,partialProxy)).file),expected);
  await assert.rejects(f.stage(source,timing,plan,undefined,partialProxy),{
    code:'SPEED_MAPPING_INVALID',details:{reason:'REVERSE_PROXY_COVERAGE'},
  });
  const {timing:shortTiming,plan:shortPlan}=motion(constant(3,2),30,'reverse');
  await assert.rejects(f.stage(source,shortTiming,shortPlan,undefined,{...proxy,frameCount:30}),{
    code:'SPEED_MAPPING_INVALID',details:{reason:'REVERSE_PROXY_COVERAGE'},
  });
});

test('synthetic reverse VFR selects the original frame strictly before each backward boundary',async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,60,{variable:true}),proxy=await reverseFixture(f.root,source,0,60);
  // This VFR MOV gives its final frame only one native tick. End the clip
  // inside the genuine media duration, exactly at that final frame's PTS.
  const {timing,plan}=motion(constant(3,2),59,'reverse');
  const pts=Array.from({length:60},(_,frame)=>frame*10+(frame===59?0:frame%3===1?-2:frame%3===2?3:0));
  const truth=Array.from({length:plan.durationFrames},(_,frame)=>{
    const source=unwrap(timeMapSourceAtOutputFrame(plan,frame)).source;
    assert.equal(source.kind,'exact');
    return Math.max(0,pts.findLastIndex(pts=>BigInt(pts)*BigInt(source.denominator)<BigInt(source.numerator)*10n));
  });
  const staged=await f.stage(source,timing,plan,undefined,proxy);
  assert.deepEqual(await readOrdinals(staged.file),truth);
});

test('24/25/60 fps use the actual source clock on the 30fps project map',async t=>{
  const f=await fixture(t);
  for (const nativeFps of [24,25,60]) {
    const source=await sourceFixture(f.root,2*nativeFps,{nativeFps});
    const {timing,plan}=motion(constant(3,2),60);
    const staged=await f.stage(source,timing,plan);
    assert.equal(staged.path,'cfr');
    assert.deepEqual(await readOrdinals(staged.file),Array.from({length:40},(_,frame)=>Math.floor(frame*3*nativeFps/60)));
  }
});

test('budget failure and missing reverse media do not yield a valid video stage', async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,30);
  const {timing,plan}=motion(constant(2,1),30);
  await assert.rejects(f.stage(source,timing,plan,32),{code:'SPEED_BUDGET_EXCEEDED'});
  await assert.rejects(f.stage(source,timing,initialTimeMap(plan.root,'reverse')),{code:'SPEED_MAPPING_INVALID'});
});

test('16-bit alpha remains byte-identical through the lossless freeze stage', async t=>{
  const f=await fixture(t),source=path.join(f.root,'alpha.mkv');
  const format='gbrap16le',width=32,height=64,frame=width*height*4*2;
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
    `nullsrc=size=${width}x${height}:rate=30,format=${format},geq=r='1000+X':g='800+Y':b='10230':a='N*51+X*10'`,
    '-frames:v','4','-c:v','ffv1','-level','3','-threads:v','4','-slices','4','-pix_fmt',`+${format}`,
    '-color_range','pc','-colorspace','rgb',source]);
  const plan=initialTimeMap(unwrap(compileFreezeTimeMap({sourceFrame:1,durationFrames:5,sourceFps:clock,outputFps:clock})));
  const result=await f.stage(source,{profile:'timeline-freeze-v1',sourceFrame:1,sourceVersionId:null,sourceSha256:'a'.repeat(64)},plan);
  const original=(await readRaw(source,format)).subarray(frame,frame*2);
  assert.deepEqual(await readRaw(result.file,format),Buffer.concat(Array(5).fill(original) as Buffer[]));
});

test('32-bit float video retimes native samples byte-for-byte in a raw stream', async t=>{
  const f=await fixture(t),source=path.join(f.root,'float.mov');
  const format='gbrpf32le',width=32,height=64,frame=width*height*3*4;
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
    `testsrc2=size=${width}x${height}:rate=30,format=${format}`,'-frames:v','8','-c:v','exr',
    '-threads:v','1','-pix_fmt',`+${format}`,source]);
  const {plan,timing}=motion(constant(3,2),8);
  const result=await f.stage(source,timing,plan);
  const original=await readRaw(source,format);
  assert.deepEqual(result.inputArgs,['-f','rawvideo','-pixel_format',format,'-video_size','32x64','-framerate','30']);
  assert.equal(result.bytes,plan.durationFrames*frame);
  assert.deepEqual(await readFile(result.file),Buffer.concat(Array.from(unwrap(timeMapPlanFrames(plan)),
    index=>original.subarray(index*frame,(index+1)*frame))));
  const {timing:reverseTiming,plan:reversePlan}=motion(constant(3,2),8,'reverse');
  const raw=path.join(f.root,'reverse.raw');
  await writeFile(raw,Buffer.concat(Array.from({length:8},(_,at)=>original.subarray((7-at)*frame,(8-at)*frame))));
  const reverse=await f.stage(source,reverseTiming,reversePlan,undefined,{file:raw,firstSourceOrdinal:0,frameCount:8,storage:'raw'});
  assert.deepEqual(reverse.inputArgs,result.inputArgs);
  assert.deepEqual(await readFile(reverse.file),Buffer.concat(Array.from(unwrap(timeMapPlanFrames(reversePlan)),
    index=>original.subarray(index*frame,(index+1)*frame))));
});

test('display rotation is provided to the segment input without rotating stage pixels', async t=>{
  const f=await fixture(t),source=await sourceFixture(f.root,12),display=path.join(f.root,'rotate.mov');
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-display_rotation:v:0','90','-i',source,
    '-map','0:v:0','-c:v','copy',display]);
  const {plan,timing}=motion(constant(2,1),12);
  const result=await f.stage(display,timing,plan);
  assert.deepEqual(result.inputArgs,['-display_rotation:v:0','90']);
  assert.deepEqual(await readOrdinals(result.file),Array.from(unwrap(timeMapPlanFrames(plan))));
});
