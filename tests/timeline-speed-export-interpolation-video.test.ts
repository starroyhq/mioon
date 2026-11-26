import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSync, openSync, realpathSync} from 'node:fs';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileTimeMap, initialTimeMap, splitTimeMap, timeMapHasSlowMotion, timeMapPlanFrames, trimTimeMap,
  type TimeMapBasis, type TimeMapResult, type TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {compileInterpolationPhase} from '../packages/contracts/src/timeline-interpolation.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {assertSpeedExportVideoCapability, inspectSpeedVideoInterpolation, prepareSpeedExportVideo,
  type SpeedExportVideoOptions} from '../packages/business/src/timeline-speed-export-video.ts';

const fps = {fpsNumerator:30,fpsDenominator:1};
const frameBytes = 64 * 64 * 3 / 2;
const qtr = {kind:'constant',rate:{numerator:1,denominator:4}} as const;
const luma = (source: number): number => source * 12 + 24;
function unwrap<T>(value: TimeMapResult<T>): T {
  assert.ok(value.ok, JSON.stringify(value));
  return value.value;
}
function timing(sourceFrames: number, interpolation:'blend'|'optical', direction:'forward'|'reverse'='forward', speed:TimeMapSpeed=qtr) {
  const basis: TimeMapBasis = {profile:'timeline-speed-v1',sourceFps:fps,outputFps:fps,
    sourceRange:{start:{kind:'rational',numerator:'0',denominator:'1'},
      end:{kind:'rational',numerator:String(sourceFrames),denominator:'1'}},speed};
  const plan = initialTimeMap(unwrap(compileTimeMap(basis)), direction);
  const clip: ClipTiming = {profile:'timeline-speed-v1',basis,view:{direction,loTime:{anchor:'start',offsetOutputFrames:0},
    hiTime:{anchor:'end',offsetOutputFrames:0}},outputWindow:plan.outputWindow,interpolation,pitchShift:false};
  return {plan,timing:clip};
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(realpathSync(tmpdir()),'speed-interpolation-video-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  let slot = 0;
  return {root, stage(options: Omit<SpeedExportVideoOptions,'reserve'|'file'|'scriptFile'|'writeOwnedFile'>) {
    const stem = path.join(root,'stage-'+slot++);
    return prepareSpeedExportVideo({...options,file:stem+'.mkv',scriptFile:stem+'.filter',
      reserve(file) {closeSync(openSync(file,'wx',0o600));},
      writeOwnedFile:(file,body)=>writeFile(file,body,{flag:'wx',mode:0o600})});
  }};
}

async function planarSource(root: string, frames: number, variable = false): Promise<string> {
  const source = path.join(root, variable ? 'variable.mov' : 'source.mov');
  // A reversible 12-level ramp makes the interpolation weights observable.
  const timing = variable ? ['-vf',"settb=1/300,setpts='N*10-2*eq(mod(N,2),1)'",
    '-fps_mode','passthrough','-enc_time_base','1/300','-video_track_timescale','300'] : ['-video_track_timescale','30000'];
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-noauto_conversion_filters',
    '-f','lavfi','-i','nullsrc=s=64x64:r=30,format=yuv420p,geq=lum=N*12+24:cb=128:cr=128',...timing,
    '-frames:v',String(frames),'-c:v','libx264','-preset','ultrafast','-qp','0','-bf','0',
    '-threads:v','1','-pix_fmt','+yuv420p',source]);
  return source;
}

async function readLuma(file: string): Promise<number[]> {
  const chunks: Buffer[] = [];
  await runStreaming('ffmpeg',['-nostdin','-hide_banner','-v','error','-i',file,'-c:v','rawvideo','-threads:v','1',
    '-pix_fmt','+yuv420p','-fps_mode','passthrough','-f','rawvideo','pipe:1'],{onStdout:chunk=>{chunks.push(chunk);}});
  const bytes=Buffer.concat(chunks);
  assert.equal(bytes.length % frameBytes,0);
  return Array.from({length:bytes.length/frameBytes},(_,frame)=>bytes[frame*frameBytes]!);
}

test('blend reads original CFR pairs and preserves fractional phase in a split range', async t => {
  const f = await fixture(t), source = {path:await planarSource(f.root,8)};
  await assertSpeedExportVideoCapability({interpolation:'blend'});
  const compiled = timing(8,'blend');
  const entire = await f.stage({...compiled,source});
  const expected = Array.from({length:32},(_,frame)=>luma(Math.min(7,frame/4)));
  assert.equal(entire.path,'blend');
  assert.deepEqual(await readLuma(entire.file),expected);
  const right = unwrap(splitTimeMap(compiled.plan,5)).right;
  const trimmed = await f.stage({...compiled,source,plan:right,interpolationPlan:compiled.plan});
  assert.deepEqual(await readLuma(trimmed.file),expected.slice(5));
});

test('blend adapts fractional source time to native VFR timestamps', async t => {
  const f=await fixture(t), source={path:await planarSource(f.root,9,true)};
  const compiled=timing(7,'blend'), staged=await f.stage({...compiled,source});
  const ticks=[0,8,20,28,40,48,60,68];
  const expected=Array.from({length:28},(_,frame)=>{
    const target=frame*2.5, base=ticks.findLastIndex(tick=>tick<=target);
    if (base===ticks.length-1) return luma(base);
    return Math.round(luma(base) + 12*(target-ticks[base]!)/(ticks[base+1]!-ticks[base]!));
  });
  assert.deepEqual(await readLuma(staged.file),expected);
});

test('blends traversal neighbours on a reverse proxy, including the clamped endpoint', async t => {
  const f=await fixture(t), source={path:await planarSource(f.root,8)};
  const file=path.join(f.root,'reverse.mkv');
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-i',source.path,'-an','-filter_threads','1','-vf',
    'reverse,settb=1/30,setpts=N','-c:v','ffv1','-threads:v','1','-pix_fmt','+yuv420p','-fps_mode','passthrough',file]);
  const compiled=timing(8,'blend','reverse');
  const staged=await f.stage({...compiled,source,reverse:{file,firstSourceOrdinal:0,frameCount:8,storage:'matroska'}});
  assert.deepEqual(await readLuma(staged.file),Array.from({length:32},(_,frame)=>luma(Math.max(0,7-frame/4))));
});

test('reverse blend uses native VFR right boundaries and clamps only at the source endpoint', async t => {
  const f=await fixture(t), source={path:await planarSource(f.root,9,true)};
  const file=path.join(f.root,'reverse.mkv');
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-i',source.path,'-an','-filter_threads','1','-vf',
    'trim=end_frame=8,reverse,settb=1/30,setpts=N','-c:v','ffv1','-threads:v','1','-pix_fmt','+yuv420p',
    '-enc_time_base','1/30','-fps_mode','passthrough',file]);
  const compiled=timing(7,'blend','reverse');
  const staged=await f.stage({...compiled,source,reverse:{file,firstSourceOrdinal:0,frameCount:8,storage:'matroska'}});
  const ticks=[0,8,20,28,40,48,60,68,80];
  const expected=Array.from({length:28},(_,frame)=>{
    const target=70-frame*2.5;
    const from=ticks.findLastIndex(tick=>tick<target);
    return from===0 ? luma(0) : Math.round(luma(from)-12*(ticks[from+1]!-target)/(ticks[from+1]!-ticks[from]!));
  });
  assert.deepEqual(await readLuma(staged.file),expected);
});

test('curve only blends its slow frames and keeps faster frames at the off selection', async t => {
  const f=await fixture(t),source={path:await planarSource(f.root,12)};
  const compiled=timing(12,'blend','forward',{kind:'curve',interpolation:'log-pchip-v1',presetId:'speed-test',
    points:[{sourceFrame:0,rate:{numerator:3,denominator:4}},{sourceFrame:12,rate:{numerator:3,denominator:2}}]});
  const proof=unwrap(compileInterpolationPhase(compiled.plan));
  assert.equal(proof.available,true);
  assert.ok(proof.frames.some(frame=>!frame.active) && proof.frames.some(frame=>frame.active && frame.weight>0));
  const staged=await f.stage({...compiled,source});
  const selected=unwrap(timeMapPlanFrames(compiled.plan)), actual=await readLuma(staged.file);
  assert.deepEqual(actual,proof.frames.map((frame,index)=>frame.active
    ? Math.round(luma(frame.fromFrame)+(luma(frame.toFrame)-luma(frame.fromFrame))*frame.weight)
    : luma(selected[index]!)));
});

test('rejects a steep curve above the phase bound and a blend exceeding its byte reservation', async t => {
  const f=await fixture(t),source={path:await planarSource(f.root,12)};
  const compiled=timing(12,'blend','forward',{kind:'curve',interpolation:'log-pchip-v1',presetId:'speed-test',
    points:[{sourceFrame:0,rate:{numerator:1,denominator:4}},{sourceFrame:12,rate:{numerator:2,denominator:1}}]});
  assert.equal(unwrap(compileInterpolationPhase(compiled.plan)).available,false);
  await assert.rejects(inspectSpeedVideoInterpolation({source,plan:compiled.plan}),{code:'INTERPOLATION_UNAVAILABLE'});
  await assert.rejects(f.stage({...compiled,source}),{code:'INTERPOLATION_UNAVAILABLE'});
  assert.deepEqual(await readdir(f.root),['source.mov']);
  await assert.rejects(f.stage({...timing(12,'blend'),source,maxBytes:1024}),{code:'SPEED_BUDGET_EXCEEDED'});
});

test('optical stage uses clip-local proxy output ordinals without applying a second retime', async t => {
  const f=await fixture(t),source={path:await planarSource(f.root,8)};
  const file=path.join(f.root,'optical.mkv');
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
    'nullsrc=s=64x64:r=30,format=yuv420p,geq=lum=N+120:cb=128:cr=128,setparams=chroma_location=left','-frames:v','40',
    '-c:v','ffv1','-threads:v','1','-pix_fmt','+yuv420p','-chroma_sample_location','left',file]);
  const compiled=timing(8,'optical'), plan=unwrap(trimTimeMap(compiled.plan,4,12));
  await assert.rejects(f.stage({...compiled,plan,source}),{code:'SPEED_PROCESSING_NOT_READY'});
  await assert.rejects(f.stage({...compiled,plan,source,firstOutputFrame:4,optical:{file,firstOutputFrame:5,frameCount:40}}),
    {code:'SPEED_PROCESSING_NOT_READY'});
  assert.deepEqual((await readdir(f.root)).sort(),['optical.mkv','source.mov']);
  const staged=await f.stage({...compiled,plan,source,firstOutputFrame:4,optical:{file,firstOutputFrame:-3,frameCount:40}});
  assert.equal(staged.path,'optical');
  assert.deepEqual(await readLuma(staged.file),Array.from({length:8},(_,frame)=>127+frame));
  await assertSpeedExportVideoCapability({interpolation:'optical'});
});

test('fast-only segment needs no optical lease or blend source support', async t => {
  const f=await fixture(t), source={path:await planarSource(f.root,12)};
  const optics=timing(12,'optical','forward',{kind:'curve',interpolation:'log-pchip-v1',presetId:'speed-test',
    points:[{sourceFrame:0,rate:{numerator:1,denominator:4}},{sourceFrame:12,rate:{numerator:2,denominator:1}}]});
  const full=optics.plan, plan=unwrap(trimTimeMap(full,full.durationFrames-2,full.durationFrames));
  assert.equal(unwrap(timeMapHasSlowMotion(plan)),false);
  assert.equal(unwrap(compileInterpolationPhase(full)).available,false);
  const off=await f.stage({source,timing:{...optics.timing,interpolation:'off'},plan});
  const fast=await f.stage({source,timing:optics.timing,plan,interpolationPlan:full});
  assert.equal(fast.path,off.path);
  assert.deepEqual(await readLuma(fast.file),await readLuma(off.file));

  const gray=path.join(f.root,'gray.mov');
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
    'nullsrc=s=64x64:r=30,format=gray,geq=lum=N','-frames:v','12','-c:v','png','-threads:v','1',gray]);
  const blended={source:{path:gray},timing:{...optics.timing,interpolation:'blend'} as const};
  await assert.rejects(f.stage({...blended,plan:full}),{code:'UNSUPPORTED_FORMAT'});
  const fastBlend=await f.stage({...blended,plan,interpolationPlan:full});
  assert.equal(fastBlend.path,'lookup');
  assert.equal(fastBlend.frameCount,2);
});

test('blend rejects 10-bit, RGB and YUVJ decoded sources before staging', async t => {
  const f=await fixture(t), compiled=timing(6,'blend');
  for (const [format,codec] of [['yuv420p10le','ffv1'],['bgr0','ffv1'],['yuvj420p','mjpeg']] as const) {
    const file=path.join(f.root,format+'.mkv'), source={path:file};
    await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-n','-filter_threads','1','-f','lavfi','-i',
      `testsrc=s=64x64:r=30,format=${format}`,'-frames:v','6','-c:v',codec,'-threads:v','1','-pix_fmt','+'+format,file]);
    await assert.rejects(inspectSpeedVideoInterpolation({source,plan:compiled.plan}),{code:'UNSUPPORTED_FORMAT'});
    await assert.rejects(f.stage({...compiled,source}),{code:'UNSUPPORTED_FORMAT'});
  }
  assert.deepEqual((await readdir(f.root)).sort(),['bgr0.mkv','yuv420p10le.mkv','yuvj420p.mkv']);
});
