import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {deriveTimelineColourSourceEvidence as derive,classifyTimelineColourSourceEvidence as classify,validateTimelineColourSourceInterpretation as validate,
 createTimelineColourSourceServices,createTimelineColourSourceProbe,TIMELINE_COLOUR_SOURCE_LIMITS as LIMITS} from '../packages/business/src/timeline-colour-source.ts';
const sha='a'.repeat(64);
const video=(patch: {index?: number; color_transfer?: string;}={})=>({index:2,codec_type:'video',codec_name:'h264',width:64,height:64,pix_fmt:'yuv420p',color_primaries:'bt709',color_transfer:'bt709',color_space:'bt709',color_range:'tv',...patch});
const probe=(patch: {color_primaries?: string | undefined; color_space?: undefined | string; color_transfer?: undefined | string; pix_fmt?: undefined | string; bits_per_raw_sample?: undefined | string;bits_per_sample?:string; color_range?: undefined | string;}={})=>({streams:[{index:0,codec_type:'audio',codec_name:'aac'},video(((patch) as unknown as Parameters<typeof video>[0]))]});
const source=(patch: {assetSha256?: string | undefined; streamIndex?: undefined | number; range?: undefined | string;}={})=>({assetSha256:sha,streamIndex:2,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:'2026-10-14T00:00:00.000Z',...patch});
const guard=(raw: { streams: unknown[]; }=probe(),interpretation: unknown=source(),extra: {assetSha256?: string; streamIndex?: number|undefined; source?: unknown; probe?: unknown;}={})=>validate({source:interpretation,probe:raw,assetSha256:sha,streamIndex:2,...extra});

test('explicit 709 opaque YUV has real evidence, selected playable stream and compatible status',()=>{
 const raw=probe();raw.streams.unshift((({...video({index:1,color_transfer:'smpte2084'}),disposition:{attached_pic:1}}) as unknown as Parameters<NonNullable<((typeof raw)["streams"])["unshift"]>>[0]));
 assert.deepEqual(derive(raw),{primaries:'bt709',transfer:'bt709',matrix:'bt709',range:'limited',pixelFormat:'yuv420p',bitDepth:8,hdrMetadata:false});
 assert.deepEqual(classify(derive(raw)),{status:'compatible',reason:null});assert.deepEqual(guard(raw),derive(raw));
 for(const [pix_fmt,bitDepth] of ([['yuv422p10le',10],['p010le',10],['nv12',8]] as const)){
  const evidence=derive(probe((({pix_fmt,bits_per_raw_sample:String(bitDepth)}) as unknown as Parameters<typeof probe>[0])));assert.equal(evidence.bitDepth,bitDepth);assert.equal(classify(evidence).status,'compatible');
 }
});
test('missing and unspecified tags need explicit interpretation without pretending it is evidence',()=>{
 for(const missing of ([undefined,'unknown','unspecified'] as const)){
  const raw=probe((({color_primaries:missing,color_transfer:missing,color_space:missing,color_range:missing}) as unknown as Parameters<typeof probe>[0]));
  assert.equal(classify(derive(raw)).status,'needs_interpretation');assert.equal((guard(raw).primaries as unknown),null);
  assert.throws(()=>guard(raw,((null) as unknown as Parameters<typeof guard>[1])),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 }
});
test('known non709, Log, HDR, RGB, alpha, depth contradictions and unsupported ranges cannot be overridden',()=>{
 for(const patch of ([{color_primaries:'bt2020'},{color_space:'bt2020nc'},{color_transfer:'smpte2084'},{color_transfer:'arib-std-b67'},
  {color_transfer:'log100'},{color_transfer:'log316'},{color_transfer:'smpte428'},{pix_fmt:'rgb24'},{pix_fmt:'gbrp'},{pix_fmt:'yuva420p'},
  {pix_fmt:'yuv444p12be'},{pix_fmt:'yuv420p16le'},{pix_fmt:'yuv422p9le'},{pix_fmt:'rgba'},{pix_fmt:'gray'},{pix_fmt:'unknown'},{bits_per_raw_sample:'10'},{color_range:'unsupported'}] as const)){
  assert.equal(classify(derive(probe(patch))).status,'unsupported',JSON.stringify(patch));assert.throws(()=>guard(probe(patch)),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 }
 for(const side_data_type of (['Mastering display metadata','Content light level metadata','DOVI configuration record','HDR Dynamic Metadata SMPTE2094-40'] as const)){
  const raw=probe((({side_data_list:[{side_data_type}]}) as unknown as Parameters<NonNullable<typeof probe>>[0]));assert.equal(derive(raw).hdrMetadata,true);assert.throws(()=>guard(raw),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 }
 const raw=probe();(raw as typeof raw & {frames:({ stream_index: number; side_data_list: { side_data_type: string; }[]; }[])}).frames=[{stream_index:2,side_data_list:[{side_data_type:'Mastering display metadata'}]}];assert.equal(derive(raw).hdrMetadata,true);
});
test('asset hashes, selected stream and known ranges are actual-byte bound',()=>{
 for(const patch of ([{assetSha256:'b'.repeat(64)},{streamIndex:1},{range:'full'}] as const))assert.throws(()=>guard(probe(),((source(patch)) as unknown as Parameters<typeof guard>[1])),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 assert.throws(()=>guard(probe(),((source()) as unknown as Parameters<typeof guard>[1]),{assetSha256:'b'.repeat(64)}),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 assert.throws(()=>guard(probe(),((source()) as unknown as Parameters<typeof guard>[1]),{streamIndex:3}),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 assert.equal(guard(probe({color_range:'pc'}),((source({range:'full'})) as unknown as Parameters<typeof guard>[1])).range,'full');
 assert.throws(()=>guard(probe({pix_fmt:'yuvj420p',color_range:undefined})),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
 assert.equal(guard(probe({pix_fmt:'yuvj420p',color_range:undefined}),((source({range:'full'})) as unknown as Parameters<typeof guard>[1])).pixelFormat,'yuvj420p');
 const two={streams:[video({index:1}),video()]};assert.throws(()=>guard(two),{code:'TIMELINE_COLOUR_SOURCE_MISMATCH'});
});
test('malformed probe is bounded and a missing video is unsupported rather than inferred',()=>{
 for(const raw of ([null,{}, {streams:Array(257).fill(video())},{streams:[video(),video()]},probe((({index:-1}) as unknown as Parameters<NonNullable<typeof probe>>[0])),probe({color_primaries:'x'.repeat(81)}),probe({bits_per_sample:'evil'})] as const))assert.throws(()=>derive(raw),{code:'TIMELINE_COLOUR_SOURCE_INVALID_PROBE'});
 const noVideo={streams:[{index:0,codec_type:'audio',codec_name:'aac'}]};assert.equal(classify(derive(noVideo)).status,'unsupported');
});
function fixture(t: test.TestContext){
 const db=new DatabaseSync(':memory:'),projectId=randomUUID(),assetId=randomUUID();let owned=true,restored=false,hashHook!: ((options:{beforeEffect:()=>void;onBytes:(n:number)=>void})=>unknown)|undefined,probeHook!: ((options?:unknown)=>unknown)|undefined,identityHook!: (()=>void)|undefined,readHook!: (()=>void)|undefined,terminateHook!: (()=>unknown)|undefined;
 const asset={id:assetId,projectId,relativePath:'media/test.mp4',sha256:sha,sizeBytes:4,mimeType:'video/mp4'},info={dev:1,ino:2,size:4,mtimeMs:1,ctimeMs:1};
 const calls={hash:0,probe:0,terminate:0};
 const runtime={assertOrdinaryWorkspace(){if(restored)throw Object.assign(Error('Denied'),{code:'RESTORE_OPERATION_UNAVAILABLE'});},ownsLock:()=>owned,
  readOwnedAsset:()=>{readHook?.();return asset;},validateSource:()=>{identityHook?.();return {file:'/owned/media/test.mp4',info:{...info}};},
  async hash(root: unknown,value: unknown,options: { beforeEffect: () => void; onBytes: (arg0: number) => void; }){calls.hash++;await hashHook?.(options);options.beforeEffect();options.onBytes(4);return {file:'/owned/media/test.mp4',info:{...info},sha256:sha,sizeBytes:4};},
  async probe(file: unknown,options: { beforeEffect: () => void; }){calls.probe++;await probeHook?.(options);options.beforeEffect();return probe();},
  async terminate(){calls.terminate++;return await terminateHook?.()??[];},async waitForClose(){return [];},boundedShutdown:(work?: unknown)=>work};
 const services=createTimelineColourSourceServices({db,root:'/owned'},(({runtime}) as unknown as Parameters<typeof createTimelineColourSourceServices>[1]));
 t.after(async()=>{await services.drain().catch(()=>{});db.close();});
 return {db,asset,info,calls,runtime,services,input:{projectId,assetId},inspect:(input: Record<string, unknown>={projectId,assetId},context?: { signal?: AbortSignal; }|undefined)=>services.handlers['timeline.colour.source.inspect'](input,context),
  hooks(value:{probe?:typeof probeHook;hash?:typeof hashHook;terminate?:typeof terminateHook;identity?:typeof identityHook;read?:typeof readHook}){({hash:hashHook,probe:probeHook,identity:identityHook,read:readHook,terminate:terminateHook}=value);},owner(value: boolean){owned=value;},restored(value: boolean){restored=value;}};
}
test('owned inspection hashes before/after probe, exposes only DTO and has no SQLite writes',async t=>{
 const f=fixture(t),before=(f.db.prepare('SELECT total_changes() n').get())!.n,result=await f.inspect();
 assert.equal(result.status,'compatible');assert.equal(result.assetSha256,sha);assert.equal(result.streamIndex,2);assert.deepEqual(f.calls,{hash:2,probe:1,terminate:1});
 assert.equal((f.db.prepare('SELECT total_changes() n').get())!.n,before);for(const forbidden of (['relativePath','file','sizeBytes'] as const))assert.equal(JSON.stringify(result).includes(forbidden),false);
});
test('owner/restored/foreign/source limits reject before hashing and probing',async t=>{
 const f=fixture(t);f.owner(false);await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_OWNER_REQUIRED'});f.owner(true);f.restored(true);
 await assert.rejects(f.inspect(),{code:'RESTORE_OPERATION_UNAVAILABLE'});f.restored(false);
 await assert.rejects(f.inspect({...f.input,projectId:randomUUID()}),{code:'TIMELINE_COLOUR_SOURCE_UNAVAILABLE'});
 f.asset.sizeBytes=LIMITS.sourceBytes+1;await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_LIMIT'});assert.equal(f.calls.hash,0);assert.equal(f.calls.probe,0);
});
test('hostile accessors and caller file paths never execute or reach runtime',async t=>{
 const f=fixture(t);let called=0;
 await assert.rejects(f.inspect({...f.input,get file(){called++;return '/outside';}}),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.inspect({...f.input,file:'/outside'}),{code:'VALIDATION_ERROR'});assert.equal(called,0);assert.equal(f.calls.hash,0);
});
test('SHA/row/path changes and ownership loss across await invalidate rather than publish',async t=>{
 for(const mutation of ([(f: Awaited<ReturnType<typeof fixture>>)=>f.asset.sha256='b'.repeat(64),(f: Awaited<ReturnType<typeof fixture>>)=>f.asset.relativePath='media/other.mp4',(f: Awaited<ReturnType<typeof fixture>>)=>f.info.ino++,(f: Awaited<ReturnType<typeof fixture>>)=>f.owner(false)] as const)){
  const f=fixture(t);f.hooks({probe(){mutation(f);}});await assert.rejects(f.inspect(),error=>['TIMELINE_COLOUR_SOURCE_STALE','TIMELINE_COLOUR_SOURCE_OWNER_REQUIRED'].includes((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code));assert.equal(f.calls.hash,1);
 }
 const f=fixture(t);f.runtime.hash=((async()=>({sha256:'b'.repeat(64)})) as unknown as (root: unknown, value: unknown, options: { beforeEffect: () => void; onBytes: (arg0: number) => void; }) => Promise<{ file: string; info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; }; sha256: string; sizeBytes: number; }>);await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_STALE'});assert.equal(f.calls.probe,0);
});
test('single active operation survives public cancellation until noncooperative work actually settles',async t=>{
 const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.hooks({hash:()=>gate});
 const controller=new AbortController(),pending=f.inspect(f.input,{signal:controller.signal});await Promise.resolve();
 await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_BUSY'});controller.abort();await assert.rejects(pending,{code:'OPERATION_CANCELLED'});
 await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_BUSY'});let done=false;const draining=f.services.drain().then(()=>{done=true;});
 await Promise.resolve();assert.equal(done,false);(release)!();await draining;assert.equal(f.calls.probe,0);await assert.rejects(f.inspect(),{code:'OPERATION_CANCELLED'});
});
test('read-only inspection never starts file/process work from inside a SQLite write',async t=>{
 const f=fixture(t);f.db.exec('BEGIN IMMEDIATE');await assert.rejects(f.inspect(),{code:'TIMELINE_COLOUR_SOURCE_UNAVAILABLE'});f.db.exec('ROLLBACK');assert.equal(f.calls.hash,0);
});
test('unconfirmed process shutdown permanently poisons the local inspection owner',async t=>{
 const f=fixture(t);f.hooks({terminate:()=>[{status:'unconfirmed'}]});await assert.rejects(f.inspect(),{code:'MEDIA_TERMINATION_UNCONFIRMED'});
 await assert.rejects(f.inspect(),{code:'MEDIA_TERMINATION_UNCONFIRMED'});assert.equal(f.calls.probe,1);
});
test('fixed metadata probe is file-only, bounded, selected-field and lifetime-fenced',async()=>{
 let invocation!:Parameters<NonNullable<NonNullable<Parameters<typeof createTimelineColourSourceProbe>[0]>['run']>>,fences=0;
 const decode=createTimelineColourSourceProbe({run:async(...args)=>{invocation=args;return JSON.stringify(probe());},withProbePermit:async(signal,work)=>work(),checkMediaEffect:fence=>fence()});
 const result=await decode('/owned/media/test.mp4',{signal:new AbortController().signal,beforeEffect:()=>{fences++;},remainingMs:()=>500});
 assert.deepEqual(result,probe());assert.equal((invocation)![0],'ffprobe');assert.equal((invocation)![1].includes('-protocol_whitelist'),true);assert.equal((invocation)![1][(invocation)![1].indexOf('-protocol_whitelist')+1],'file');
 assert.equal((invocation)![1].includes('-show_entries'),true);assert.equal((invocation)![2].maxStdoutBytes,LIMITS.probeBytes);assert.equal((invocation)![2].maxStderrBytes,LIMITS.stderrBytes);assert.equal((invocation)![2].timeout,500);assert.equal(fences,2);
});
