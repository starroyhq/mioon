import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {FixtureProject, FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {StrictPreflightService} from './helpers/strict-timeline-handler-types.ts';
type PreflightProbeResult = Awaited<ReturnType<NonNullable<NonNullable<Parameters<typeof createTimelinePreflightServices>[1]>['probe']>>>;
type PreflightProbeOptions = Parameters<NonNullable<NonNullable<Parameters<typeof createTimelinePreflightServices>[1]>['probe']>>[1];
import type {TypedServices as FixtureServices, TypedStore as FixtureStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {readdirSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS,isTimelineRenderRecord,isExportPreflightResponse,hasRequestNotAppliedProof} from '@mioon/contracts';
import {openStore, type WorkspaceStore} from '../packages/business/src/db.ts';
import {createServices,hash, type OrdinaryServices} from '../packages/business/src/services.ts';
import {createTimelinePreflightServices,timelineSnapshotHash} from '../packages/business/src/timeline-preflight.ts';
import {readTimelinePreflightSnapshot} from '../packages/business/src/timeline-sources.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';

// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext,name='Foreign project'){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-range-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=(openStore(root) as FixtureStore),services=(createServices(store,new Map()) as FixtureServices);
 try{return await services.call('project.create',{name});}
 finally{await services.drain();store.close();}
}
const byName=(a: {name: string},b: {name: string})=>a.name<b.name?-1:a.name>b.name?1:0;
async function fixture(t: test.TestContext,{empty=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-range-'));let store=(openStore(root) as FixtureStore),probes=0,services!: FixtureServices;
 const open=()=>(createServices(store,new Map(),{exportOptions:{inspect:async()=>{probes++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};}}}) as FixtureServices);services=open();
 const _strictFixtureBase={root,get store(){return store;},get services(){return services;},get probes(){return probes;},input:()=>({projectId:f.project.id,expectedRevision:f.timeline?.revision??1,requestId:randomUUID(),purpose:'export'}),state:()=>Object.fromEntries(schemaObjects(store.db).filter(({type})=>type==='table').sort(byName).map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])),async restart(){await services.drain();store.close();store=(openStore(root) as FixtureStore);services=open();}};
 const f = _strictFixtureBase as typeof _strictFixtureBase & {project: FixtureProject; timeline?: FixtureTimeline};
 f.project=await services.call('project.create',{name:'Range export'});
 if(!empty){f.timeline=await services.call('timeline.get',{projectId:f.project.id});const bytes=Buffer.from('synthetic bytes'),id=randomUUID(),relativePath='media/source.mp4';await writeFile(path.join(root,relativePath),bytes);(f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; createdAt: string; })}).asset=store.put('assets',{id,projectId:f.project.id,name:'Original',mimeType:'video/mp4',sha256:createHash('sha256').update(bytes).digest('hex'),relativePath,width:720,height:1280,duration:2,hasAudio:false,sizeBytes:bytes.length,createdAt:new Date().toISOString()});f.timeline=await services.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),trackId:f.timeline.tracks[0].id,assetId:id,startFrame:0,durationFrames:60});}
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}

test('range freezes complete original composition; exact replay survives shorter current timeline and restart',async t=>{
 for(const custom of ([false,true] as const))await t.test(custom?'custom':'legacy encoding',async t=>{
  const f=await fixture(t),input={...f.input(),exportRange:{startFrame:11,endFrame:49},...(custom?{exportSettings:structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS),deliveryName:'Boundary test'}:{})},original=structuredClone(f.timeline),accepted=await f.services.call('timeline.render',input),wire=JSON.stringify(accepted),raw=f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);
  assert.deepEqual(accepted.snapshot.exportRange,input.exportRange);assert.deepEqual(accepted.snapshot.timeline,original);assert.deepEqual(f.store.get('timelines',(original)!.id),original);assert.equal((raw)!.requestHash,hash({operation:'timeline.render',input}));assert.ok(isTimelineRenderRecord(accepted,input));assert.equal(f.probes,custom?1:0);
  f.timeline=await f.services.call('timeline.clip.update',{projectId:f.project.id,requestId:randomUUID(),expectedRevision:(f.timeline)!.revision,clipId:(f.timeline)!.clips[0].id,patch:{durationFrames:20}});await f.restart();const before=f.state();assert.equal(JSON.stringify(await f.services.call('timeline.render',input)),wire);assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId),raw);assert.deepEqual(f.state(),before);
  for(const next of ([{...input,exportRange:{startFrame:11,endFrame:48}},Object.fromEntries(Object.entries(input).filter(([key])=>key!=='exportRange'))] as const))await assert.rejects(f.services.call('timeline.render',next),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='IDEMPOTENCY_CONFLICT'&&!(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details?.mutationOutcome);
  assert.deepEqual(f.state(),before);assert.equal(f.probes,custom?1:0);
 });
});

test('fresh range bounds fail before writes/capability and carry request-bound rollback proof; missing timeline stays absent',async t=>{
 for(const empty of ([false,true] as const))for(const custom of ([false,true] as const))await t.test(`${empty?'absent':'saved'} ${custom?'custom':'legacy'}`,async t=>{
  const f=await fixture(t,{empty}),input={...f.input(),exportRange:{startFrame:10,endFrame:61},...(custom?{exportSettings:structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS)}:{})},before=f.state();
  await assert.rejects(f.services.call('timeline.render',input),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code===(empty?'EMPTY_TIMELINE':'EXPORT_RANGE_BOUNDS')&&(empty||hasRequestNotAppliedProof(error,input,{operation:'timeline.render'})));
  assert.deepEqual(f.state(),before);assert.equal(f.probes,0);
 });
});

test('range preflight is read-only, full-source summary and range-specific digest; stale wins over out-of-current-bounds',async t=>{
 const f=await fixture(t),preflight=(createTimelinePreflightServices(f.store,{probe:((async()=>({width:720,height:1280,duration:2,hasAudio:false,hasVideo:true,videoStreamIndex:0})) as unknown as ((file: string, options: PreflightProbeOptions) => Promise<PreflightProbeResult>) | undefined)}) as StrictPreflightService);t.after(()=>preflight.drain());
 const input={projectId:f.project.id,expectedRevision:(f.timeline)!.revision,exportRange:{startFrame:11,endFrame:49}},before=f.state(),report=await preflight.handlers['timeline.export.preflight'](input);
 assert.equal(report.status,'ready');assert.ok(isExportPreflightResponse(report,input));assert.deepEqual((report.summary)!.exportRange,input.exportRange);assert.equal((report.summary)!.durationFrames,60);assert.equal((report.summary)!.clipCount,1);assert.equal(report.checks.checkedAssets,1);assert.deepEqual(f.state(),before);
 assert.equal(report.snapshotHash,timelineSnapshotHash(readTimelinePreflightSnapshot(f.store,f.project.id,undefined,input).snapshot));
 const full=await preflight.handlers['timeline.export.preflight']({projectId:f.project.id,expectedRevision:(f.timeline)!.revision});assert.notEqual(full.snapshotHash,report.snapshotHash);assert.equal(Object.hasOwn(((full.summary) as unknown as Parameters<typeof Object.hasOwn>[0]),'exportRange'),false);
 await assert.rejects(f.services.call('timeline.render',{...f.input(),exportRange:{startFrame:12,endFrame:49},preflightSnapshotHash:report.snapshotHash}),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='PREFLIGHT_STALE');
 const accepted=await f.services.call('timeline.render',{...f.input(),exportRange:input.exportRange,preflightSnapshotHash:report.snapshotHash});assert.deepEqual(accepted.snapshot.exportRange,input.exportRange);
 f.timeline=await f.services.call('timeline.clip.update',{projectId:f.project.id,requestId:randomUUID(),expectedRevision:(f.timeline)!.revision,clipId:(f.timeline)!.clips[0].id,patch:{durationFrames:20}});
 const stale=await preflight.handlers['timeline.export.preflight'](input);assert.equal(stale.status,'stale');assert.equal(stale.issues[0].code,'PREFLIGHT_STALE');assert.equal((stale.summary as unknown),null);assert.equal((stale.snapshotHash as unknown),null);assert.ok(isExportPreflightResponse(stale,input));
 const invalid=await preflight.handlers['timeline.export.preflight']({...input,expectedRevision:f.timeline.revision});assert.equal(invalid.status,'blocked');assert.equal(invalid.issues[0].code,'EXPORT_RANGE_BOUNDS');assert.equal((invalid.summary as unknown),null);assert.equal((invalid.snapshotHash as unknown),null);assert.equal(invalid.checks.checkedAssets,0);assert.ok(isExportPreflightResponse(invalid,{...input,expectedRevision:f.timeline.revision}));
});

test('range-only identity cannot be removed or changed on receipt/export before startup or dispatch',async t=>{
 for(const target of (['export changed','export removed','receipt changed','receipt removed','preview'] as const))await t.test(target,async t=>{
  const f=await fixture(t),input={...f.input(),exportRange:{startFrame:11,endFrame:49}},accepted=await f.services.call('timeline.render',input);
  if(target.startsWith('receipt')){f.store.db.exec('DROP TRIGGER immutable_timeline_responses');const row=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId),value=JSON.parse((((row)!.response) as unknown as Parameters<typeof JSON.parse>[0]));if(target.endsWith('removed'))delete value.snapshot.exportRange;else value.snapshot.exportRange.endFrame=48;f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(value),input.requestId);}
  else{f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');const value=(f.store.get('exports',accepted.id)! as FixtureExport);if(target==='export removed')delete value!.snapshot.exportRange;else if(target==='preview')value!.purpose='preview';else (value!.snapshot.exportRange)!.endFrame=48;f.store.put('exports',value!);}
  const before=f.state();let media=0;const off=onMediaProcess(()=>media++),worker=startWorker(f.store,f.services,new Map());try{await worker.tick();assert.equal(media,0);assert.deepEqual(f.state(),before);}finally{off();await worker.stop();}
  await assert.rejects(f.services.call('timeline.render',input),error=>['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE'].includes((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code)&&!(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details?.mutationOutcome);assert.deepEqual(f.state(),before);
 });
});


async function syntheticRangeMedia(t: test.TestContext,f: Awaited<ReturnType<typeof fixture>>){
 const binary=path.join(f.root,'synthetic-range-media.ts'),saved={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 const source={streams:[{index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'60'}],format:{duration:'2'}},rendered={streams:[{index:0,codec_type:'video',codec_name:'h264',width:(f.timeline)!.width,height:(f.timeline)!.height,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'38',start_pts:0,start_time:'0',sample_aspect_ratio:'1:1',pix_fmt:'yuv420p',has_b_frames:0,time_base:'1/30000',duration:String(38/30)},{index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:'1/48000',start_pts:0,start_time:'0',duration:String(38/30)}],format:{format_name:'mov,mp4',duration:String(38/30),start_time:'0'}};
 await writeFile(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);if(args.includes('-show_streams'))process.stdout.write(JSON.stringify(args.at(-1).endsWith('source.mp4')?${JSON.stringify(source)}:${JSON.stringify(rendered)}));else writeFileSync(args.at(-1),'synthetic selected output',{flag:args.includes('-n')?'wx':'w'});\n`,{mode:0o700});
 process.env.MIOON_FFMPEG_PATH=binary;process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}

test('range-only worker uses original receipt through owned staged publication without capability compute',async t=>{
 const f=await fixture(t);await syntheticRangeMedia(t,f);const input={...f.input(),exportRange:{startFrame:11,endFrame:49}},accepted=await f.services.call('timeline.render',input),receipt=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId))!.response,events: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[]=[],off=onMediaProcess(event=>events.push(((event) as unknown as Parameters<typeof events.push>[0]))),worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();}finally{off();await worker.stop();}
 const result=(f.store.get('exports',accepted.id)! as FixtureExport);assert.equal(result!.status,'succeeded',JSON.stringify(result!.error));assert.deepEqual(result!.snapshot,JSON.parse(((receipt) as unknown as Parameters<typeof JSON.parse>[0])).snapshot);assert.ok(result!.assetId);assert.deepEqual([f.store.get('assets',result!.assetId)!.width,f.store.get('assets',result!.assetId)!.height],[accepted.snapshot.timeline.width,accepted.snapshot.timeline.height]);assert.equal(f.probes,0);assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,2);assert.equal((f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId))!.response,receipt);assert.deepEqual(await f.services.call('timeline.render',input),accepted);assert.equal((await readdir(path.join(f.root,'media'))).filter(name=>name.endsWith('.part.mp4')||name.startsWith('.timeline-render-')).length,0);
});

test('range-only source ownership change after probe prevents first encoder and preserves originals',async t=>{
 const f=await fixture(t);await syntheticRangeMedia(t,f);const other=await foreignProject(t,'Other'),accepted=await f.services.call('timeline.render',{...f.input(),exportRange:{startFrame:11,endFrame:49}}),events: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[]=[];let changed=false;
 const original=await readFile(path.join(f.root,(f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; createdAt: string; })}).asset.relativePath)),off=onMediaProcess(event=>{events.push(((event) as unknown as Parameters<typeof events.push>[0]));if(event.type==='exited'&&!changed){changed=true;withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other.id,(f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; createdAt: string; })}).asset.id));}}),worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();}finally{off();await worker.stop();}
 assert.equal(changed,true);assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,0);assert.equal((f.store.get('exports',accepted.id)! as FixtureExport).status,'failed');assert.equal(((f.store.get('exports',accepted.id)! as FixtureExport).assetId as unknown),null);assert.deepEqual(await readFile(path.join(f.root,(f as typeof f & {asset:({ id: `${string}-${string}-${string}-${string}-${string}`; projectId: string; name: string; mimeType: string; sha256: string; relativePath: string; width: number; height: number; duration: number; hasAudio: boolean; sizeBytes: number; createdAt: string; })}).asset.relativePath)),original);assert.equal(f.probes,0);
});

test('range-only cancellation/ownership failure cannot delete a replaced staging inode',async t=>{
 const f=await fixture(t);await syntheticRangeMedia(t,f);const accepted=await f.services.call('timeline.render',{...f.input(),exportRange:{startFrame:11,endFrame:49}}),events: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[]=[];let replacement!: unknown;
 const off=onMediaProcess(event=>{events.push(((event) as unknown as Parameters<typeof events.push>[0]));if(event.type==='exited'&&event.kind==='ffmpeg'&&!replacement){const media=path.join(f.root,'media'),part=readdirSync(media).find(name=>name.endsWith('.part.mp4'));assert.ok(part);replacement=path.join(media,part);renameSync(((replacement) as unknown as Parameters<typeof renameSync>[0]),path.join(media,'owned-detached-output'));writeFileSync(((replacement) as unknown as Parameters<typeof writeFileSync>[0]),'unrelated replacement must remain');}}),worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();}finally{off();await worker.stop();}
 assert.ok(replacement);assert.equal(await readFile(((replacement) as unknown as Parameters<NonNullable<typeof readFile>>[0]),'utf8'),'unrelated replacement must remain');assert.equal((f.store.get('exports',accepted.id)! as FixtureExport).status,'failed');assert.equal(((f.store.get('exports',accepted.id)! as FixtureExport).assetId as unknown),null);assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,1);assert.equal(f.probes,0);
});
