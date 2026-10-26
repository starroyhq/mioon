import type {MediaStreamingRunOptions} from '../packages/business/src/media-runtime.ts';
type FloatCall={command:string;args:string[];options:MediaStreamingRunOptions};
type FloatPermit=string & {command?:never;args?:never;options?:never};
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimelineFloatAudioAccumulator,createTimelineFloatAudioChecker,parseTimelineFloatAudioProbe,
  assertTimelineFloatAudioAllowed,rememberTimelineFloatAudioFailure,isOwnedTimelineFloatAudioMeasurement,readTimelineFloatAudioCheckFailure,TIMELINE_FLOAT_AUDIO_LIMITS} from '../packages/business/src/timeline-float-audio-check.ts';
const pcm=(frames: number|undefined=1600,value: ((arg0: number,arg1: number) => number)|undefined=(_frame?: unknown,channel?: unknown)=>channel?-1.5:1.25)=>{const bytes=Buffer.alloc(frames*8);for(let frame=0;frame<frames;frame++)for(let channel=0;channel<2;channel++)bytes.writeFloatLE(value(frame,channel),frame*8+channel*4);return bytes;};
const metadata=()=>({format:{format_name:'concat'},streams:[{index:0,codec_type:'video'},{index:1,codec_type:'audio',codec_name:'pcm_f32le',sample_fmt:'flt',sample_rate:'48000',channels:2,channel_layout:'stereo'}]});
const options=(overrides?: { signal?: AbortSignal; beforeEffect?: (() => void)|(() => void); remainingMs?: (() => number)|(() => number)|(() => number); ownedSegments?: { file: string; outputFrames: number; }[]|{ file: string; outputFrames: number; }[]; }|undefined)=>({beforeEffect(){},ownedSegments:[{file:'/private/segment-0.mov',outputFrames:1}],...overrides});
function runtime(overrides: {withProbePermit?: ((signal: unknown,work: () => unknown) => Promise<unknown>)|((signal: { addEventListener: (arg0: string,arg1: () => void,arg2: { once: boolean; }) => void; }) => Promise<void>); runStreaming?: ((command: string,args: string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }) => Promise<void>)|((command: string,args: string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }) => Promise<{ stdoutBytes: number; }>)|(() => Promise<never>)|(() => Promise<never>); run?: ((command?: string,args?: string[]) => Promise<string>)|(() => Promise<void>);}={}){const calls: (FloatCall|FloatPermit)[]=[];return {calls,terminationMs:3000,
  checkMediaEffect(fn: () => unknown,signal: { aborted: unknown; }){if(signal?.aborted)throw Object.assign(Error('Cancelled'),{code:'MEDIA_CANCELLED'});const result=fn() as {then?:unknown;catch(work:()=>void):unknown};if(result?.then){result.catch(()=>{});throw Object.assign(Error('async fence'),{code:'MEDIA_INVALID_CONFIGURATION'});}},
  async withProbePermit(signal: unknown,work: () => unknown){calls.push('permit' as FloatPermit);return work();},
  async run(command: string,args: string[],options: { beforeSpawn: () => void; beforeEffect: () => void; }){calls.push((({command,args,options}) as unknown as Parameters<typeof calls.push>[0]));options.beforeSpawn();options.beforeEffect();const value=metadata();if(args.includes('mov')){value.format.format_name='mov,mp4,m4a,3gp,3g2,mj2';Object.assign(value.streams[1],{time_base:'1/48000',duration_ts:1600});}return JSON.stringify(value);},
  async runStreaming(command: string,args: string[],options: { beforeSpawn: () => void; beforeEffect: () => void; onStdout: (arg0: Buffer<ArrayBuffer>) => void; }){calls.push((({command,args,options}) as unknown as Parameters<typeof calls.push>[0]));options.beforeSpawn();options.beforeEffect();const bytes=pcm();options.onStdout(bytes);return {stdoutBytes:bytes.length};},...overrides};}

test('float accumulator preserves headroom, counts scalar samples and handles every split offset',()=>{
 for(let split=0;split<16;split++){
  const bytes=pcm(),sum=createTimelineFloatAudioAccumulator(1);sum.write(bytes.subarray(0,split));sum.write(bytes.subarray(split));const measured=sum.finish();
  assert.deepEqual(measured,{sampleRate:48000,channels:2,sampleFormat:'f32le',sampleFrames:1600,sampleCount:3200,peakLinear:1.5,overRangeSampleCount:3200,
   channelPeaks:[{channel:0,peakLinear:1.25,overRangeSampleCount:1600},{channel:1,peakLinear:1.5,overRangeSampleCount:1600}]});
  assert.equal(isOwnedTimelineFloatAudioMeasurement(measured),true);assert.equal(isOwnedTimelineFloatAudioMeasurement({...measured}),false);
  assert.ok(Object.isFrozen(measured.channelPeaks[0]));assert.ok(Buffer.byteLength(JSON.stringify(measured))<8192);assert.throws(()=>sum.finish());assert.throws(()=>sum.write(Buffer.alloc(0)));
 }
});

test('float complete <=1 passes; overrange rejection exposes only privately branded evidence',()=>{
 for(const value of ([0,1,-1,0.99999] as const)){const sum=createTimelineFloatAudioAccumulator(1);sum.write(pcm(1600,((()=>value) as unknown as Parameters<typeof pcm>[1])));const measured=sum.finish();assertTimelineFloatAudioAllowed(measured);assert.equal(measured.overRangeSampleCount,0);}
 const sum=createTimelineFloatAudioAccumulator(1);sum.write(pcm());const measured=sum.finish();let failure;
 try{assertTimelineFloatAudioAllowed(measured);}catch(error){failure=error;}
 assert.equal((failure as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean;terminationUnconfirmed?:boolean}).code,'EXPORT_AUDIO_OVER_RANGE');assert.deepEqual(readTimelineFloatAudioCheckFailure(failure),{code:'EXPORT_AUDIO_OVER_RANGE',measurement:measured});
 assert.equal(readTimelineFloatAudioCheckFailure({code:'EXPORT_AUDIO_OVER_RANGE',audioCheck:measured}),undefined);
 assert.throws(()=>assertTimelineFloatAudioAllowed({...measured}),{code:'MEDIA_INVALID_CONFIGURATION'});
});

test('float accumulator rejects short, extra, residual and poisoned PCM permanently',()=>{
 for(const frames of ([0,-1,1.1,18001,NaN,Infinity] as const))assert.throws(()=>createTimelineFloatAudioAccumulator(frames),{code:'MEDIA_INVALID_CONFIGURATION'});
 for(const value of ([NaN,Infinity,-Infinity] as const)){const sum=createTimelineFloatAudioAccumulator(1);assert.throws(()=>sum.write(pcm(1600,((()=>value) as unknown as Parameters<typeof pcm>[1]))),{code:'EXPORT_AUDIO_INVALID_PCM'});assert.throws(()=>sum.finish(),{code:'EXPORT_AUDIO_INVALID_PCM'});}
 const short=createTimelineFloatAudioAccumulator(1);short.write(pcm(1599));assert.throws(()=>short.finish(),{code:'EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH'});
 const tail=createTimelineFloatAudioAccumulator(1);tail.write(pcm().subarray(0,-1));assert.throws(()=>tail.finish(),{code:'EXPORT_AUDIO_INVALID_PCM'});
 for(const excess of ([1,8] as const)){const sum=createTimelineFloatAudioAccumulator(1);sum.write(pcm());assert.throws(()=>sum.write(Buffer.alloc(excess)),{code:'EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH'});assert.throws(()=>sum.finish(),{code:'EXPORT_AUDIO_SAMPLE_COUNT_MISMATCH'});}
 assert.equal(TIMELINE_FLOAT_AUDIO_LIMITS.pcmBytes,230400000);assert.equal(TIMELINE_FLOAT_AUDIO_LIMITS.sampleFrames,28800000);
});

test('float probe refuses other audio formats and missing/ambiguous streams',()=>{
 assert.equal(parseTimelineFloatAudioProbe(JSON.stringify(metadata())),1);
 for(const change of ([{codec_name:'pcm_s16le'},{sample_fmt:'s16'},{sample_rate:'44100'},{channels:1},{channel_layout:'mono'},{index:0}] as const)){const value=metadata();Object.assign(value.streams[1],change);assert.throws(()=>parseTimelineFloatAudioProbe(JSON.stringify(value)),{code:'EXPORT_AUDIO_FORMAT_MISMATCH'});}
 for(const update of ([(value: { streams: unknown[]; })=>value.streams.push({...(value.streams[1] as Record<string, unknown>),index:2}),(value: { streams: unknown[]; })=>value.streams.pop(),(value: { format: { format_name: string; }; })=>value.format.format_name='mov'] as const)){const value=metadata();update(value);assert.throws(()=>parseTimelineFloatAudioProbe(JSON.stringify(value)));}
});

test('checker measures owned concat naturally with unchanged 48k stereo floats and original signal',async()=>{
 const r=runtime(),controller=new AbortController();let fences=0;
 const measured=await createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/segments.txt',1,options({signal:controller.signal,beforeEffect(){fences++;}}));assert.equal(measured.peakLinear,1.5);assert.ok(fences>=8);
 const call=r.calls.find(value=>value.command==='ffmpeg');assert.equal(((call)!.options)!.signal,controller.signal);assert.equal(((call)!.options)!.maxStdoutBytes,230400000);assert.ok((((call)!.options)!.timeout)!<=117000);
 assert.equal(((call)!.args)![((call)!.args)!.indexOf('-f')+1],'concat');assert.equal(((call)!.args)![((call)!.args)!.indexOf('-af')+1],'asetpts=N/SR/TB');assert.equal(((call)!.args)![((call)!.args)!.indexOf('-map')+1],'0:1');assert.equal(((call)!.args)![((call)!.args)!.indexOf('-reinit_filter')+1],'0');assert.ok(((call)!.args)!.includes('-xerror'));
 for(const forbidden of (['-ar','-ac','-t','-ss','-frames:a','-filter_complex'] as const))assert.ok(!((call)!.args)!.includes(forbidden),forbidden);
});

test('checker fences before permits, after permit and immediately before spawn',async()=>{
 const r=runtime(),check=createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]));
 await assert.rejects(check('/private/list',1,options({signal:AbortSignal.abort()})),{code:'MEDIA_CANCELLED'});assert.deepEqual((r.calls as unknown),[]);
 let revoked=false;const denied=Object.assign(Error('Replaced inode'),{code:'INVALID_TIMELINE_SNAPSHOT'});
 const queued=runtime({async withProbePermit(signal: unknown,work: () => unknown){revoked=true;return work();}});
 await assert.rejects(createTimelineFloatAudioChecker(((queued) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options({beforeEffect(){if(revoked)throw denied;}})),error=>error===denied);assert.deepEqual((queued.calls as unknown),[]);
 const expired=runtime();await assert.rejects(createTimelineFloatAudioChecker(((expired) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options({remainingMs:()=>0})),{code:'EXPORT_AUDIO_TIMEOUT'});assert.deepEqual((expired.calls as unknown),[]);
});

test('checker preserves callback poison/unconfirmed accounting and never returns a partial report',async()=>{
 for(const unconfirmed of ([false,true] as const)){
  const r=runtime({async runStreaming(command: string,args: string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }){try{options.onStdout(pcm(1600,((()=>NaN) as unknown as Parameters<typeof pcm>[1])));}catch{throw Object.assign(Error('Safe wrapper'),{code:'MEDIA_STREAM_FAILED',...(unconfirmed?{terminationUnconfirmed:true}:{})});}}});
  await assert.rejects(createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options()),error=>{assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code,'EXPORT_AUDIO_INVALID_PCM');if(unconfirmed){assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).terminationUnconfirmed,true);assert.equal(readTimelineFloatAudioCheckFailure(error),undefined);}else assert.deepEqual(readTimelineFloatAudioCheckFailure(error),{code:'EXPORT_AUDIO_INVALID_PCM',measurement:null});return true;});
 }
 const inconsistent=runtime({async runStreaming(command: string,args: string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }){options.onStdout(pcm());return {stdoutBytes:1};}});
 await assert.rejects(createTimelineFloatAudioChecker(((inconsistent) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options()),{code:'EXPORT_AUDIO_INVALID_PCM'});
});

test('checker validates every generated segment format/count before concat and rejects mismatched plan',async()=>{
 const r=runtime();await assert.rejects(createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options({ownedSegments:[{file:'/private/s.mov',outputFrames:2}]})),{code:'MEDIA_INVALID_CONFIGURATION'});assert.deepEqual((r.calls as unknown),[]);
 let seen=0;const bad=runtime({async run(command?: string,args?: string[]){seen++;const value=metadata();value.format.format_name='mov,mp4,m4a,3gp,3g2,mj2';Object.assign(value.streams[1],{time_base:'1/48000',duration_ts:1600});if(seen===2)value.streams[1].sample_fmt='s16';return JSON.stringify(value);},async runStreaming(){assert.fail('No decode after a later segment changes format');}});
 await assert.rejects(createTimelineFloatAudioChecker(((bad) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',2,options({ownedSegments:[{file:'/private/a.mov',outputFrames:1},{file:'/private/b.mov',outputFrames:1}]})),{code:'EXPORT_AUDIO_FORMAT_MISMATCH'});assert.equal(seen,2);
});

test('queued probe wait is bounded by the same total deadline without reassigning spawned-child ownership',async()=>{
 let spawned=false;const r=runtime({async withProbePermit(signal: { addEventListener: (arg0: string,arg1: () => void,arg2: { once: boolean; }) => void; }){await new Promise<never>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('cancel'),{code:'MEDIA_CANCELLED'})),{once:true});});},async run(){spawned=true;}});
 const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options({remainingMs:()=>20})),{code:'EXPORT_AUDIO_TIMEOUT'});}finally{clearTimeout(keepAlive);}assert.equal(spawned,false);
});


test('completed check remains owned evidence when later AAC/probe/cleanup fails, never on cancellation or uncertain close',()=>{
 const accumulator=createTimelineFloatAudioAccumulator(1);accumulator.write(pcm(1600,((()=>0.5) as unknown as Parameters<typeof pcm>[1])));const measurement=accumulator.finish();
 for(const code of (['MEDIA_EXIT_FAILED','MEDIA_INVALID_METADATA','EXPORT_AUDIO_STAGING_CHANGED'] as const)){const error=Object.assign(Error('later failure'),{code});rememberTimelineFloatAudioFailure(error,measurement);assert.deepEqual(readTimelineFloatAudioCheckFailure(error),{code:'EXPORT_AUDIO_WITHIN_LIMIT',measurement});}
 for(const failure of ([{code:'MEDIA_CANCELLED'},{code:'INVALID_TIMELINE_SNAPSHOT'},{code:'MEDIA_EXIT_FAILED',terminationUnconfirmed:true}] as const)){rememberTimelineFloatAudioFailure(failure,measurement);assert.equal(readTimelineFloatAudioCheckFailure(failure),undefined);}
 assert.throws(()=>rememberTimelineFloatAudioFailure(Error('forged'),{...measurement}),{code:'MEDIA_INVALID_CONFIGURATION'});
});


test('unconfirmed cancellation retains authoritative flag even when the measurement budget expires simultaneously',async()=>{
 const r=runtime({async runStreaming(){await new Promise(resolve=>setTimeout(resolve,30));throw Object.assign(Error('Unconfirmed cancelled child'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});}});
 await assert.rejects(createTimelineFloatAudioChecker(((r) as unknown as Parameters<typeof createTimelineFloatAudioChecker>[0]))('/private/list',1,options({remainingMs:()=>15})),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='MEDIA_CANCELLED'&&(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).terminationUnconfirmed===true&&readTimelineFloatAudioCheckFailure(error)===undefined);
});
