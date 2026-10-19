import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChildProcess} from 'node:child_process';
import type {TestContext} from 'node:test';
import {once} from 'node:events';
import {resolveTimelineExportDelivery,TIMELINE_OUTPUT_PRESETS,timelineExportCapabilityResultSchema} from '@mioon/contracts';
import {inspectTimelineExportCapability,timelineExportVideoArgs,TIMELINE_EXPORT_CAPABILITY_LIMITS} from '../packages/business/src/timeline-export-capabilities.ts';
import {onMediaProcess,terminateMediaProcesses,hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.ts';
import type {TimelineExportDelivery} from '@mioon/contracts';
import type {MediaProcessEvent} from '../packages/business/src/media-processes.ts';

interface TestRateControl {mode: string; quality?: string; targetKbps?: number}
const settings=(resolution='native',rateControl: TestRateControl={mode:'crf',quality:'standard'}): {profileId: string; resolution: string; rateControl: TestRateControl} => ({profileId:'mp4_h264_v1',resolution,rateControl});
const resolveDelivery=(preset: number, exportSettings: unknown): TimelineExportDelivery => resolveTimelineExportDelivery(TIMELINE_OUTPUT_PRESETS[preset], exportSettings);
const delivery=resolveDelivery(0, settings());
const listing='Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264 synthetic H.264\n A..... aac synthetic AAC\n';
const pause=(ms: number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function sandbox(t: Pick<TestContext,'after'>): Promise<string>{const root=await mkdtemp(path.join(tmpdir(),'mioon-export-capability-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function fixture(t: Pick<TestContext,'after'>,body: string){
 const root=await sandbox(t),file=path.join(root,'synthetic tool with spaces.mjs');
 await writeFile(file,`#!${process.execPath}\n${body}\n`,{mode:0o700});
 const before=process.env.MIOON_FFMPEG_PATH;process.env.MIOON_FFMPEG_PATH=file;
 t.after(()=>{if(before===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=before;});
 return {root,file};
}
const encoderThen=(body: string)=>`if(process.argv.includes('-encoders'))process.stdout.write(${JSON.stringify(listing)});else{${body}}`;
function expected(actual: unknown,status: string,code: string): void{assert.deepEqual(actual,{status,code});assert.equal(timelineExportCapabilityResultSchema.safeParse(actual).success,true);}
function readyForEncode(){let resolve: (()=>void)|undefined;const ready=new Promise<void>(done=>{resolve=done;});let count=0;const off=onMediaProcess(event=>{if(event.type==='started'&&++count===2)resolve?.();});return {ready,off};}

test('fixed closed encoder arguments cover both exclusive rate branches and reject forged delivery before spawning',async()=>{
 assert.deepEqual(timelineExportVideoArgs(delivery),['-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r','30','-video_track_timescale','30000'],'native standard retains the exact historical segment argv');
 for(const [quality,crf] of [['compact',28],['standard',23],['high',18]] as const){
  const args=timelineExportVideoArgs(resolveDelivery(0, settings('native',{mode:'crf',quality})));
  assert.equal(args[args.indexOf('-crf')+1],String(crf));assert.equal(args.includes('-b:v'),false);
 }
 for(const targetKbps of [2000,4000,8000]){
  const args=timelineExportVideoArgs(resolveDelivery(0, settings('short_1080',{mode:'bitrate',targetKbps})));
  assert.equal(args[args.indexOf('-b:v')+1],`${targetKbps}k`);assert.equal(args.includes('-crf'),false);
 }
 const events: MediaProcessEvent[]=[],off=onMediaProcess(event=>events.push(event));
 try{
  for(const forged of [null,{}, {...delivery,effective:{...delivery.effective,width:8192}}, {...delivery,effective:{...delivery.effective,videoCodec:'h264_nvenc'}}, {...delivery,path:'/private/input'}]){
   expected(await inspectTimelineExportCapability(forged as unknown as TimelineExportDelivery),'incomplete','EXPORT_CAPABILITY_CONFIGURATION');
   assert.throws(()=>timelineExportVideoArgs(forged as unknown as TimelineExportDelivery),{code:'INVALID_TIMELINE_SNAPSHOT'});
  }
  assert.deepEqual(events,[]);
 }finally{off();}
 assert.equal(TIMELINE_EXPORT_CAPABILITY_LIMITS.concurrent,1);assert.equal(TIMELINE_EXPORT_CAPABILITY_LIMITS.queued,0);
 assert.ok(TIMELINE_EXPORT_CAPABILITY_LIMITS.totalMs<=15000);assert.ok(TIMELINE_EXPORT_CAPABILITY_LIMITS.computeMs<=12000);
 assert.ok(TIMELINE_EXPORT_CAPABILITY_LIMITS.stdoutBytes<=1024*1024);
});

test('actual installed FFmpeg proves selected CRF and bitrate profiles with bounded pipe output and no scratch files',async t=>{
 const root=await sandbox(t),before=await readdir(root),events: MediaProcessEvent[]=[],off=onMediaProcess(event=>events.push(event));
 try{
  for(const selected of [delivery,resolveDelivery(1, settings('short_1080',{mode:'bitrate',targetKbps:8000}))])
   expected(await inspectTimelineExportCapability(selected),'available','EXPORT_CAPABILITY_AVAILABLE');
  assert.equal(events.filter(event=>event.type==='started').length,4);
  assert.equal(events.filter(event=>event.type==='exited').length,4);
  assert.deepEqual(await readdir(root),before);
 }finally{off();}
});

for(const [name,body,status,code] of [
 ['missing encoder','process.stdout.write("Encoders:\\n A..... = Audio\\n ------\\n A..... aac Synthetic AAC\\n V....D libaom-av1 Synthetic AV1\\n");','unavailable','EXPORT_CAPABILITY_UNSUPPORTED'],
 ['empty listing','process.stdout.write("");','incomplete','EXPORT_CAPABILITY_FAILED'],
 ['malformed listing','process.stdout.write("unrecognized encoder output");','incomplete','EXPORT_CAPABILITY_FAILED'],
 ['malformed rows','process.stdout.write("Encoders:\\n ------\\n malformed\\n");','incomplete','EXPORT_CAPABILITY_FAILED'],
 ['advertised encoder that fails actual encode',encoderThen('process.stderr.write("synthetic-private-path-and-secret");process.exitCode=23;'),'incomplete','EXPORT_CAPABILITY_FAILED'],
 ['success exit with bogus MP4',encoderThen('process.stdout.write("not an MP4 despite zero exit");'),'incomplete','EXPORT_CAPABILITY_FAILED'],
 ['encode stdout overflow',encoderThen('process.stdout.write(Buffer.alloc(1048577));'),'incomplete','EXPORT_CAPABILITY_OUTPUT_LIMIT'],
 ['encode stderr overflow',encoderThen('process.stderr.write(Buffer.alloc(65537));'),'incomplete','EXPORT_CAPABILITY_OUTPUT_LIMIT'],
 ['listing stdout overflow','process.stdout.write(Buffer.alloc(131073));','incomplete','EXPORT_CAPABILITY_OUTPUT_LIMIT'],
])test(`capability classifies ${name} safely`,async t=>{
 if(process.platform==='win32'){t.skip('POSIX executable fixture; no native Windows verification claim');return;}
 const {file}=await fixture(t,body),outcome=await inspectTimelineExportCapability(delivery);
 expected(outcome,status,code);assert.equal(JSON.stringify(outcome).includes(file),false);assert.doesNotMatch(JSON.stringify(outcome),/synthetic-private|secret/);
 assert.deepEqual(await terminateMediaProcesses(),[]);
});

test('a missing executable is unavailable, while invalid configured paths are incomplete',async t=>{
 const root=await sandbox(t),before=process.env.MIOON_FFMPEG_PATH;t.after(()=>{if(before===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=before;});
 process.env.MIOON_FFMPEG_PATH=path.join(root,'missing-private-tool');expected(await inspectTimelineExportCapability(delivery),'unavailable','EXPORT_CAPABILITY_TOOL_UNAVAILABLE');
 process.env.MIOON_FFMPEG_PATH='invalid-relative-path';expected(await inspectTimelineExportCapability(delivery),'incomplete','EXPORT_CAPABILITY_CONFIGURATION');
});

test('one process-wide capability runs with no queue; abort reaps exact owned child and releases its slot',async t=>{
 if(process.platform==='win32'){t.skip('POSIX executable fixture');return;}
 await fixture(t,encoderThen('setInterval(()=>{},1000);'));
 const controller=new AbortController(),events: MediaProcessEvent[]=[],off=onMediaProcess(event=>events.push(event)),watch=readyForEncode();
 try{
  const pending=inspectTimelineExportCapability(delivery,{signal:controller.signal}),rejected=assert.rejects(pending,{code:'MEDIA_CANCELLED'});
  await watch.ready;
  for(let n=0;n<8;n++)expected(await inspectTimelineExportCapability(delivery),'incomplete','EXPORT_CAPABILITY_BUSY');
  assert.equal(events.filter(event=>event.type==='started').length,2);
  controller.abort();await rejected;
  assert.equal(events.filter(event=>event.type==='exited').length,2);assert.deepEqual(await terminateMediaProcesses(),[]);
  // A new call starts, proving that the previous owner released only after its
  // exact child settled; this call is cancelled independently.
  const next=new AbortController(),started=inspectTimelineExportCapability(delivery,{signal:next.signal});
  next.abort();await assert.rejects(started,{code:'MEDIA_CANCELLED'});
 }finally{controller.abort();watch.off();off();}
});

test('already cancelled capability and scoped shutdown preserve cancellation semantics',async t=>{
 if(process.platform==='win32'){t.skip('POSIX executable fixture');return;}
 await fixture(t,encoderThen('setInterval(()=>{},1000);'));
 const controller=new AbortController();controller.abort();const events: MediaProcessEvent[]=[],off=onMediaProcess(event=>events.push(event));
 try{await assert.rejects(inspectTimelineExportCapability(delivery,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});assert.deepEqual(events,[]);}finally{off();}
 const owner=new AbortController(),watch=readyForEncode();
 try{
  const pending=inspectTimelineExportCapability(delivery,{signal:owner.signal}),rejected=assert.rejects(pending,{code:'MEDIA_CANCELLED'});
  await watch.ready;await terminateMediaProcesses({signal:owner.signal});await rejected;
  assert.deepEqual(await terminateMediaProcesses(),[]);
 }finally{owner.abort();watch.off();}
});

test('compute timeout plus a TERM-ignoring child remains within the fixed cleanup budget',{timeout:20000},async t=>{
 if(process.platform==='win32'){t.skip('POSIX signal fixture');return;}
 await fixture(t,encoderThen('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'));
 const before=performance.now();expected(await inspectTimelineExportCapability(delivery),'incomplete','EXPORT_CAPABILITY_TIMEOUT');
 assert.ok(performance.now()-before<16000,'12s compute + <=3s cleanup, with 1s scheduling tolerance');assert.deepEqual(await terminateMediaProcesses(),[]);
});

test('unconfirmed child keeps capability ownership held until real close, including late duplicate callbacks',{timeout:10000},async t=>{
 if(process.platform==='win32'){t.skip('POSIX executable fixture');return;}
 await fixture(t,encoderThen('setInterval(()=>{},1000);'));
 const controller=new AbortController(),watch=readyForEncode(),originalKill=ChildProcess.prototype.kill;let owned: ChildProcess|undefined;
 const mocked=t.mock.method(ChildProcess.prototype,'kill',function(this: ChildProcess){owned=this;return false;});
 try{
  const pending=inspectTimelineExportCapability(delivery,{signal:controller.signal});
  const rejected=assert.rejects(pending,(failure: unknown)=>{const value=failure as {code?: string; terminationUnconfirmed?: boolean};return value.code==='MEDIA_CANCELLED'&&value.terminationUnconfirmed===true;});
  await watch.ready;controller.abort();await rejected;
  assert.equal(hasUnconfirmedMediaProcesses(),true);
  expected(await inspectTimelineExportCapability(delivery),'incomplete','EXPORT_CAPABILITY_BUSY');
  mocked.mock.restore();const child=owned as ChildProcess;const closed=once(child,'close');originalKill.call(child,'SIGKILL');await closed;await pause(0);
  assert.equal(hasUnconfirmedMediaProcesses(),false);
  child.emit('close',null,'SIGKILL');
  const next=new AbortController(),following=inspectTimelineExportCapability(delivery,{signal:next.signal});next.abort();await assert.rejects(following,{code:'MEDIA_CANCELLED'});
 }finally{mocked.mock.restore();watch.off();const child=owned as ChildProcess|undefined;if(child?.exitCode===null&&child?.signalCode===null)originalKill.call(child,'SIGKILL');}
});
