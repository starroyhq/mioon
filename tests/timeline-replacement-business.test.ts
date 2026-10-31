import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type { SQLInputValue } from 'node:sqlite';
import {schemaObjects} from './helpers/project-database.ts';

const operation='timeline.clip.replaceSource';
const clone=<T>(value: T): T => JSON.parse(JSON.stringify(value));
const domain=(value: { tracks: unknown; clips: unknown; durationFrames: unknown; })=>clone({tracks:value.tracks,clips:value.clips,durationFrames:value.durationFrames});
const at='2026-10-10T00:00:00.000Z';
const outsideTables=['projects','assets','shots','nodes','edges','jobs','versions','exports'];
const definiteRejections=new Set(['REVISION_CONFLICT','SOURCE_UNCHANGED','INVALID_CLIP_TYPE','SOURCE_BOUNDS','INVALID_FADE','FADE_AUDIO_UNSUPPORTED']);
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext,name='Foreign project'){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-replacement-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=(openStore(root) as FixtureStore),services=(createServices(store,new Map()) as FixtureServices);
 try{return await services.call('project.create',{name});}
 finally{await services.drain();store.close();}
}
// The other project is not in this store; write the damaged row as a corrupt file would hold it.
const withoutForeignKeys=<T>(db: FixtureStore['db'],write: () => T): T=>{db.exec('PRAGMA foreign_keys=OFF');try{return write();}finally{db.exec('PRAGMA foreign_keys=ON');}};
const byName=(a: {name: string},b: {name: string})=>a.name<b.name?-1:a.name>b.name?1:0;
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-replacement-'));
 let store=(openStore(root) as FixtureStore),services=(createServices(store,new Map()) as FixtureServices);
 const _strictFixtureBase={root,get store(){return store;},call:<O extends string>(op: O, input?: unknown) => services.call(op,input) as Promise<FixtureServiceResult<O>>,
  restart(){store.close();store=(openStore(root) as FixtureStore);services=(createServices(store,new Map()) as FixtureServices);},
  capture(tables: string[]|undefined=['timelines','timeline_history','timeline_history_cursors','timeline_requests']){
   return Object.fromEntries(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  },
  asset(mimeType: string|undefined='video/mp4',patch: {duration?: number|undefined; hasAudio?: boolean; projectId?: unknown; name?: string;}={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Synthetic source',mimeType,
   duration:10,width:720,height:1280,hasVideo:!mimeType.startsWith('audio/'),hasAudio:!mimeType.startsWith('image/'),provenance:'user-import',
   sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:at,...patch});},
  async generated(patch: {projectId?: unknown;}={}){
   const asset=f.asset('video/mp4',(({provenance:'generated',...patch}) as unknown as Parameters<NonNullable<(typeof f)["asset"]>>[1])),projectId=asset.projectId;
   const shot=await f.call('shot.create',{projectId,title:'Synthetic shot'}),jobId=randomUUID(),versionId=randomUUID();
   const snapshot={projectId,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
   const job=store.put('jobs',{id:jobId,projectId,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot});
   const version=store.put('versions',{id:versionId,projectId,shotId:shot.id,assetId:asset.id,jobId,number:1,sha256:asset.sha256,snapshot});
   return {asset,shot,job,version};
  },
  update(table: string,id: string,patch: { id?: unknown; name?: string; projectId?: unknown; padding?: string; sha256?: string; assetId?: unknown; versionId?: `${string}-${string}-${string}-${string}-${string}`; shotId?: `${string}-${string}-${string}-${string}-${string}`; referenceAssetIds?: unknown[]; snapshot?: { projectId: unknown; }|{ referenceAssets: { id: unknown; }[]; }; provenance?: string; }={},sql: Record<string,import('node:sqlite').SQLInputValue>={}){
   if(table==='versions')store.db.exec('DROP TRIGGER IF EXISTS immutable_versions');
   const record={...(store.get(table,id) as Record<string,unknown>),...patch};
   store.db.prepare(`UPDATE ${table} SET data=?${Object.keys(sql).map(key=>`,${key}=?`).join('')} WHERE id=?`).run(JSON.stringify(record),...Object.values(sql),id);
  },
  async timeline(asset: {id?: unknown; mimeType?: string;}=f.asset(),patch: {fadeInFrames?: number; fadeOutFrames?: number;}={}){
   let timeline=await f.call('timeline.get',{projectId:f.projectId});
   timeline=await f.call('timeline.clip.add',params(f,timeline,{assetId:asset.id,trackId:(timeline.tracks.find((track)=>track.kind===((asset.mimeType)!.startsWith('audio/')?'audio':'video')))!.id,
    name:'Keep this clip',startFrame:23,sourceInFrame:(asset.mimeType)!.startsWith('image/')?0:7,durationFrames:60,gain:.65,rect:{x:40,y:80,width:360,height:640},...patch}));
   return timeline;
  }
 };
 const f = _strictFixtureBase as typeof _strictFixtureBase & {projectId: string; otherId: string};
 f.projectId=(await f.call('project.create',{name:t.name.slice(0,150)})).id;
 f.otherId=(await foreignProject(t,'Other private project')).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const params=<P extends Record<string,unknown>=Record<never,never>>(f: Awaited<ReturnType<typeof fixture>>,timeline: { revision: number; },extra: P={} as P):P & {projectId:string;expectedRevision:number;requestId:string}=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...extra});
const replace=(f: Awaited<ReturnType<typeof fixture>>,timeline: FixtureTimeline,asset: { id: unknown; },extra: {versionId?: `${string}-${string}-${string}-${string}-${string}`;}={})=>params(f,timeline,{clipId:timeline.clips[0].id,assetId:asset.id,...extra});
function corruptTimelineAggregate(f: Awaited<ReturnType<typeof fixture>>,timeline: { id: unknown; }){
 const db=f.store.db,names=['agent_target_timeline_update_v2','agent_target_timeline_timeline_clip_update_v2','agent_target_timeline_timeline_track_update_v2','agent_target_timeline_timeline_subtitle_update_v2'];
 const current=()=>schemaObjects(db).filter(({name})=>names.includes(name)).sort(byName).map(({schema,name,sql})=>({schema,name,sql}));
 const guards=current();
 assert.deepEqual(guards.map(((value)=>value.name)),[...names].sort());
 const tables=[...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests','agent_task_target_revisions_v2'],before=f.capture(tables);
 assert.throws(((()=>db.prepare('UPDATE timelines SET data=? WHERE id=?').run('{',timeline.id as string)) as unknown as Parameters<NonNullable<(typeof assert)["throws"]>>[0]),/malformed JSON/);
 assert.deepEqual(f.capture(tables),before,'live target guards reject malformed aggregate bytes atomically');
 // Only direct construction of corrupt fixture bytes omits these four JSON
 // readers. Restore their exact SQL before any business rejection is tested,
 // each in the database that held it: an unqualified CREATE TRIGGER would go to main.
 try{
  for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
  db.prepare('UPDATE timelines SET data=? WHERE id=?').run('{',timeline.id as string);
 }finally{for(const guard of guards)db.exec(guard.sql!.replace(/^CREATE TRIGGER /u,`CREATE TRIGGER "${guard.schema}".`));}
 assert.deepEqual(current(),guards);
}
async function rejectAtomic(f: Awaited<ReturnType<typeof fixture>>,input: { assetId: unknown; versionId?: undefined; expectedRevision: unknown; projectId: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ versionId: `${string}-${string}-${string}-${string}-${string}`; assetId?: undefined; expectedRevision: unknown; projectId: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ expectedRevision: unknown; assetId?: undefined; versionId?: undefined; projectId: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; }|{ projectId: unknown; assetId?: undefined; versionId?: undefined; expectedRevision: unknown; requestId: `${string}-${string}-${string}-${string}-${string}`; },code: string|string[]){
 const before=f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']);
 await assert.rejects(f.call(operation,input),error=>{
  assert.ok((Array.isArray(code)?code:[code]).includes((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code),`Expected ${code}, received ${(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code}: ${(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message}`);
  assert.ok(!JSON.stringify(error).includes('FOREIGN_SECRET'),'Errors must not expose a foreign record');
  const fresh=!before.timeline_requests.some(((row)=>row.requestId===input.requestId));
  if(fresh&&definiteRejections.has((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code)){
   assert.equal(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.mutationOutcome,'not_applied');assert.equal(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.requestId,input.requestId);
  }else assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details?.mutationOutcome,undefined,'An existing receipt, unknown error or ownership failure is not not-applied proof');
  return true;
 });
 assert.deepEqual(f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']),before);
}

test('replacement preserves complete clip editing state, pins explicit provenance, and round-trips one history entry',async t=>{
 const f=await fixture(t),old=await f.generated(),next=await f.generated();
 let timeline=await f.timeline(old.asset,{fadeInFrames:5,fadeOutFrames:9});
 Object.assign(timeline.clips[0],{versionId:old.version.id,shotId:old.shot.id,jobId:old.job.id});
 f.store.put('timelines',timeline);
 timeline=await f.call('timeline.clip.add',params(f,timeline,{assetId:old.asset.id,trackId:timeline.tracks[1].id,startFrame:0,durationFrames:30}));
 const frozenExport=await f.call('timeline.render',params(f,timeline,{purpose:'preview'}));
 const before=clone(timeline),outside=f.capture(outsideTables),historyBefore=await f.call('timeline.history.get',{projectId:f.projectId});
 const request=replace(f,timeline,next.asset,{versionId:next.version.id});
 const result=await f.call(operation,request),expected={...before.clips[0],assetId:next.asset.id,versionId:next.version.id,shotId:next.shot.id};delete expected.jobId;
 assert.deepEqual(result.clips[0],expected);assert.deepEqual(result.clips[1],before.clips[1]);
 assert.deepEqual(result.tracks,before.tracks);assert.equal(result.durationFrames,before.durationFrames);assert.equal(result.id,before.id);
 assert.equal(result.revision,before.revision+1);assert.equal(result.createdAt,before.createdAt);
 assert.equal(Object.hasOwn(result.clips[0],'sourceSha256'),false);
 assert.equal(frozenExport.snapshot.timeline.clips[0].assetId,old.asset.id);
 assert.deepEqual(f.capture(outsideTables),outside);
 const history=await f.call('timeline.history.get',{projectId:f.projectId});assert.equal(history.length,historyBefore.length+1);assert.equal((history.undoEntry)!.operation,operation);
 const entry=f.store.db.prepare('SELECT * FROM timeline_history WHERE id=?').get((history.undoEntry)!.id);
 assert.deepEqual(JSON.parse((((entry)!.beforeSnapshot) as unknown as Parameters<typeof JSON.parse>[0])),domain(before));assert.deepEqual(JSON.parse((((entry)!.afterSnapshot) as unknown as Parameters<typeof JSON.parse>[0])),domain(result));
 timeline=await f.call('timeline.undo',params(f,result));assert.deepEqual(domain(timeline),domain(before));
 timeline=await f.call('timeline.redo',params(f,timeline));assert.deepEqual(domain(timeline),domain(result));
 assert.deepEqual(f.capture(outsideTables),outside);
 const selection=await f.call('version.select',{shotId:old.shot.id,versionId:old.version.id,expectedRevision:old.shot.revision});
 assert.equal(selection.selectedVersionId,old.version.id);
 assert.deepEqual((await f.call('timeline.get',{projectId:f.projectId})).clips,result.clips,'Version selection never retargets a clip');
 assert.deepEqual(await f.call(operation,request),result);
});

test('asset-only generated replacement removes stale provenance without inventing links or legacy fade keys',async t=>{
 const f=await fixture(t),old=await f.generated(),next=await f.generated();
 const timeline=await f.timeline(old.asset);
 Object.assign(timeline.clips[0],{versionId:old.version.id,shotId:old.shot.id,jobId:old.job.id});f.store.put('timelines',timeline);
 const result=await f.call(operation,replace(f,timeline,next.asset));
 const expected={...timeline.clips[0],assetId:next.asset.id};for(const key of (['versionId','shotId','jobId'] as const))delete expected[key];
 assert.deepEqual(result.clips[0],expected);
 for(const key of (['versionId','shotId','jobId','sourceSha256','fadeInFrames','fadeOutFrames'] as const))assert.equal(Object.hasOwn(result.clips[0],key),false,key);
});

test('replacement cannot commit a saved extension field rejected by the shared acknowledgement guard',async t=>{
 const f=await fixture(t),timeline=await f.timeline();(timeline.clips[0] as unknown as {unsupportedExtension:("preserve until explicitly migrated")}).unsupportedExtension='preserve until explicitly migrated';f.store.put('timelines',timeline);
 await rejectAtomic(f,((replace(f,timeline,f.asset())) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'INVALID_TIMELINE_SNAPSHOT');
 assert.equal((f.store.get('timelines',timeline.id)!.clips[0] as unknown as {unsupportedExtension:("preserve until explicitly migrated")}).unsupportedExtension,'preserve until explicitly migrated');
});

test('each media category can replace its own kind, including image and audio containers',async t=>{
 for(const [from,to] of ([['video/mp4','video/webm'],['audio/wav','audio/mp4'],['image/png','image/jpeg']] as const))await t.test(`${from} to ${to}`,async t=>{
  const f=await fixture(t),old=f.asset(from),next=f.asset(to),timeline=await f.timeline(old);
  const result=await f.call(operation,replace(f,timeline,next));
  assert.deepEqual(result.clips[0],{...timeline.clips[0],assetId:next.id});
 });
});

test('same source, changed category, short media, incompatible fades and stale revision reject atomically without discarding redo',async t=>{
 const f=await fixture(t),old=f.asset(),timeline=await f.timeline(old,{fadeInFrames:8,fadeOutFrames:6});
 const extra=await f.call('timeline.track.add',params(f,timeline,{kind:'video'})),current=await f.call('timeline.undo',params(f,extra));
 const base=replace(f,current,f.asset());
 await rejectAtomic(f,(({...base,assetId:old.id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'SOURCE_UNCHANGED');
 for(const mimeType of (['image/png','audio/wav'] as const))await rejectAtomic(f,(({...base,requestId:randomUUID(),assetId:f.asset(mimeType).id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'INVALID_CLIP_TYPE');
 for(const duration of ([0,2,undefined] as const))await rejectAtomic(f,(({...base,requestId:randomUUID(),assetId:f.asset('video/mp4',{duration}).id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'SOURCE_BOUNDS');
 await rejectAtomic(f,(({...base,requestId:randomUUID(),assetId:f.asset('video/mp4',{hasAudio:false}).id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'FADE_AUDIO_UNSUPPORTED');
 await rejectAtomic(f,(({...base,expectedRevision:current.revision-1}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'REVISION_CONFLICT');
 await rejectAtomic(f,(({...base,clipId:randomUUID()}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'CLIP_NOT_FOUND');
 assert.equal((await f.call('timeline.history.get',{projectId:f.projectId})).canRedo,true);
});

test('replacement accepts the exact preserved source end and rejects one-frame-short or fractional final frames',async t=>{
 const f=await fixture(t),timeline=await f.timeline();
 for(const duration of ([66/30,66.9/30] as const))await rejectAtomic(f,((replace(f,timeline,f.asset('video/mp4',{duration}))) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'SOURCE_BOUNDS');
 const exact=f.asset('video/mp4',{duration:67/30}),result=await f.call(operation,replace(f,timeline,exact));
 assert.equal(result.clips[0].sourceInFrame,7);assert.equal(result.clips[0].durationFrames,60);
});

test('duplicates, lost acknowledgements and restart replay the exact response after undo, branching, replacement and clip removal',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),next=f.asset(),request=replace(f,timeline,next);
 const responses=await Promise.all(Array.from({length:8},()=>f.call(operation,request)));
 responses.forEach(value=>assert.deepEqual(value,responses[0]));const saved=responses[0];
 assert.equal(saved.revision,timeline.revision+1);f.restart();
 assert.deepEqual(await f.call(operation,request),saved);
 let current=await f.call('timeline.undo',params(f,saved));
 const afterUndo=f.capture();assert.deepEqual(await f.call(operation,request),saved);assert.deepEqual(f.capture(),afterUndo);
 current=await f.call(operation,replace(f,current,f.asset()));
 current=await f.call('timeline.clip.remove',params(f,current,{clipId:request.clipId}));
 f.restart();const afterRemoval=f.capture();assert.deepEqual(await f.call(operation,request),saved);assert.deepEqual(f.capture(),afterRemoval);
 for(const changed of ([{assetId:f.asset().id},{versionId:randomUUID()},{expectedRevision:current.revision},{projectId:f.otherId}] as const))
  await rejectAtomic(f,(({...request,...changed}) as unknown as Parameters<typeof rejectAtomic>[1]),'IDEMPOTENCY_CONFLICT');
 assert.equal((await f.call('timeline.get',{projectId:f.projectId})).clips.length,0);
});

test('missing timelines and missing/foreign assets reject without initialization or information leakage',async t=>{
 const f=await fixture(t),next=f.asset();
 await rejectAtomic(f,(({projectId:f.projectId,expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),assetId:next.id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'CLIP_NOT_FOUND');
 assert.equal(f.store.list('timelines').length,0);
 const timeline=await f.timeline(),base=replace(f,timeline,next);
 await rejectAtomic(f,(({...base,assetId:randomUUID()}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'TIMELINE_SOURCE_UNAVAILABLE');
 // Another project lives in a store of its own: its asset does not exist in this one.
 await rejectAtomic(f,(({...base,assetId:(await fixture(t)).asset('video/mp4',{name:'FOREIGN_SECRET'}).id}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'TIMELINE_SOURCE_UNAVAILABLE');
 await rejectAtomic(f,(({...base,projectId:randomUUID()}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'TIMELINE_SOURCE_UNAVAILABLE');
});

test('new replacement rejects SQL/JSON owner and identity corruption before CAS can expose current data',async t=>{
 const cases=([
  ['project JSON identity',(f: Awaited<ReturnType<typeof fixture>>,tl?: unknown,next?: unknown)=>f.update('projects',f.projectId,{id:f.otherId,name:'FOREIGN_SECRET'})],
  ['timeline SQL owner',(f: Awaited<ReturnType<typeof fixture>>,tl: { id: unknown; },next?: unknown)=>withoutForeignKeys(f.store.db,()=>f.update('timelines',((tl.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}))],
  ['timeline JSON owner',(f: Awaited<ReturnType<typeof fixture>>,tl: { id: unknown; },next?: unknown)=>f.update('timelines',((tl.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['timeline JSON identity',(f: Awaited<ReturnType<typeof fixture>>,tl: { id: unknown; },next?: unknown)=>f.update('timelines',((tl.id) as unknown as Parameters<typeof f.update>[1]),{id:randomUUID()})],
  ['current asset SQL owner',(f: Awaited<ReturnType<typeof fixture>>,tl: { clips: { assetId: unknown; }[]; },next?: unknown)=>withoutForeignKeys(f.store.db,()=>f.update('assets',((tl.clips[0].assetId) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}))],
  ['current asset JSON owner',(f: Awaited<ReturnType<typeof fixture>>,tl: { clips: { assetId: unknown; }[]; },next?: unknown)=>f.update('assets',((tl.clips[0].assetId) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['candidate asset SQL owner',(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: {id:string})=>withoutForeignKeys(f.store.db,()=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}))],
  ['candidate asset JSON owner',(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: {id:string})=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId,name:'FOREIGN_SECRET'})],
  ['candidate asset JSON identity',(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{id:randomUUID()})],
  ['malformed candidate JSON',(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run('{',next.id as string)],
  ['oversized candidate JSON',(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{padding:'x'.repeat(17000)})],
  ['malformed timeline JSON',corruptTimelineAggregate],
 ] as const);
 for(const [name,corrupt] of cases)await t.test(name as string,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),next=f.asset();corrupt(f,timeline,next);
  const input=replace(f,timeline,next);
  await rejectAtomic(f,((input) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
  if(name.startsWith('current')||name.startsWith('timeline')||name.startsWith('project'))
   await rejectAtomic(f,(({...input,expectedRevision:1}) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
 });
});

test('explicit versions and asset-only selection validate complete actual reverse generation ownership',async t=>{
 const cases=([
  ['unknown version',async(f: Awaited<ReturnType<typeof fixture>>,g?: unknown)=>({versionId:randomUUID()})],
  ['wrong asset version',async(f: Awaited<ReturnType<typeof fixture>>,g?: unknown)=>({versionId:(await f.generated()).version.id})],
  // Another project lives in a store of its own: its version does not exist in this one.
  ['foreign version',async(f: Awaited<ReturnType<typeof fixture>>,g?: unknown)=>({versionId:(await (await fixture(t)).generated()).version.id})],
  ['version SQL owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{withoutForeignKeys(f.store.db,()=>f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}));}],
  ['version JSON owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId});}],
  ['version SQL job',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{const other=await f.generated();f.store.db.prepare('DELETE FROM versions WHERE id=?').run(other.version.id);f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{}, {jobId:other.job.id});}],
  ['version hash',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{sha256:'b'.repeat(64)});}],
  ['job JSON owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId});}],
  ['job SQL owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{withoutForeignKeys(f.store.db,()=>f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}));}],
  ['job asset mismatch',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{assetId:f.asset().id});}],
  ['job version mismatch',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{versionId:randomUUID()});}],
  ['job shot mismatch',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{shotId:randomUUID()});}],
  ['shot SQL owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { shot: { id: unknown; }; })=>{withoutForeignKeys(f.store.db,()=>f.update('shots',((g.shot.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}));}],
  ['shot reference asset owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { shot: { id: unknown; }; })=>{f.update('shots',((g.shot.id) as unknown as Parameters<typeof f.update>[1]),{referenceAssetIds:[withoutForeignKeys(f.store.db,()=>f.asset('image/png',{projectId:f.otherId})).id]});}],
  ['version snapshot owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{snapshot:{projectId:f.otherId}});}],
  ['job snapshot source owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { job: { id: unknown; }; })=>{f.update('jobs',((g.job.id) as unknown as Parameters<typeof f.update>[1]),{snapshot:{referenceAssets:[{id:withoutForeignKeys(f.store.db,()=>f.asset('image/png',{projectId:f.otherId})).id}]}});}],
  ['missing reverse version',async(f: Awaited<ReturnType<typeof fixture>>,g: { version: { id: unknown; }; })=>{f.store.db.prepare('DELETE FROM versions WHERE id=?').run(((((((g.version.id) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["run"]>>[0]));}],
  ['hidden foreign reverse owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { asset: { id: unknown; }; version: { id: unknown; }; })=>{f.update('assets',((g.asset.id) as unknown as Parameters<typeof f.update>[1]),{provenance:'user-import'});withoutForeignKeys(f.store.db,()=>f.update('versions',((g.version.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId},{projectId:f.otherId}));}],
  ['duplicate reverse owner',async(f: Awaited<ReturnType<typeof fixture>>,g: { asset: { id: unknown; }; })=>{const other=await f.generated();f.update('versions',other.version.id,{assetId:g.asset.id});}],
 ] as const);
 for(const [name,corrupt] of cases)await t.test(name as string,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),generated=await f.generated(),patch=await corrupt(f,generated);
  await rejectAtomic(f,((replace(f,timeline,generated.asset,{versionId:generated.version.id,...patch})) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'TIMELINE_SOURCE_UNAVAILABLE');
  if(!patch)await rejectAtomic(f,((replace(f,timeline,generated.asset)) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'TIMELINE_SOURCE_UNAVAILABLE');
 });
});

test('saved replacement receipts fail closed when their response structure or exact scope is corrupted',async t=>{
 const cases=([
  ['foreign project',(value?: Record<string,unknown>)=>({...(value as Record<string, unknown>),projectId:randomUUID(),name:'FOREIGN_SECRET'})],
  ['different timeline',(value?: Record<string,unknown>)=>({...(value as Record<string, unknown>),id:randomUUID()})],
  ['wrong revision',(value: { revision: number; })=>({...value,revision:value.revision+1})],
  ['missing target clip',(value?: Record<string,unknown>)=>({...(value as Record<string, unknown>),clips:[]})],
  ['different target source',(value: { clips: {durationFrames:number}[]; })=>({...value,clips:value.clips.map((clip?)=>({...(clip as Record<string, unknown>),assetId:randomUUID()}))})],
  ['invented provenance',(value: {clips: {durationFrames:number}[]})=>({...value,clips:value.clips.map((clip?)=>({...(clip as Record<string, unknown>),versionId:randomUUID()}))})],
  ['wrong total duration',(value: { durationFrames: number; })=>({...value,durationFrames:value.durationFrames+1})],
  ['invalid fades',(value: { clips: unknown[]; })=>({...value,clips:value.clips.map(((clip)=>({...(clip as Record<string, unknown>),fadeInFrames:(clip as {durationFrames:number}).durationFrames+1})))})],
  ['out of source bounds',(value: { clips: unknown[]; })=>({...value,clips:value.clips.map((clip?)=>({...(clip as Record<string, unknown>),sourceInFrame:300}))})],
  ['malformed JSON',()=>'{'],
  ['oversized response',(value?: Record<string,unknown>)=>({...(value as Record<string, unknown>),padding:'x'.repeat(132000)})]
 ] as const);
 for(const [name,change] of cases)await t.test(name as string,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset()),result=await f.call(operation,request);
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');const corrupt=change(((result) as unknown as StrictIntersection<Parameters<NonNullable<typeof change>>[0]>));
  f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(typeof corrupt==='string'?corrupt:JSON.stringify(corrupt),request.requestId);
  await rejectAtomic(f,((request) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE']);
 });
});

test('malformed or oversized replacement receipt hashes are rejected before response decoding',async t=>{
 for(const requestHash of (['x'.repeat(200000),'g'.repeat(64),'0'.repeat(63)] as const))await t.test(`invalid hash length ${requestHash.length}`,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());await f.call(operation,request);
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  f.store.db.prepare('UPDATE timeline_requests SET requestHash=?,response=? WHERE requestId=?').run(requestHash,'FOREIGN_SECRET invalid JSON',request.requestId);
  await rejectAtomic(f,((request) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),'INVALID_TIMELINE_SNAPSHOT');
 });
});

test('historical replay requires current project, aggregate and every saved source to retain ownership',async t=>{
 const cases=([
  ['missing project',async(f: Awaited<ReturnType<typeof fixture>>,tl?: unknown,next?: unknown)=>{f.store.db.exec('PRAGMA foreign_keys=OFF');f.store.db.prepare('DELETE FROM projects WHERE id=?').run(f.projectId);}],
  ['missing timeline',async(f: Awaited<ReturnType<typeof fixture>>,tl: { id: unknown; },next?: unknown)=>f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(((((((tl.id) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["run"]>>[0]))],
  ['reassigned timeline',async(f: Awaited<ReturnType<typeof fixture>>,tl: { id: unknown; },next?: unknown)=>withoutForeignKeys(f.store.db,()=>f.update('timelines',((tl.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId},{projectId:f.otherId}))],
  ['missing saved source',async(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>f.store.db.prepare('DELETE FROM assets WHERE id=?').run(((((((next.id) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["run"]>>[0]))],
  ['reassigned saved source',async(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>withoutForeignKeys(f.store.db,()=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{projectId:f.otherId,name:'FOREIGN_SECRET'},{projectId:f.otherId}))],
  ['saved source SQL/JSON mismatch',async(f: Awaited<ReturnType<typeof fixture>>,tl: unknown,next: { id: unknown; })=>withoutForeignKeys(f.store.db,()=>f.update('assets',((next.id) as unknown as Parameters<typeof f.update>[1]),{}, {projectId:f.otherId}))],
 ] as const);
 for(const [name,change] of cases)await t.test(name as string,async t=>{
  const f=await fixture(t),timeline=await f.timeline(),next=f.asset(),request=replace(f,timeline,next),saved=await f.call(operation,request);
  await f.call('timeline.clip.remove',params(f,saved,{clipId:request.clipId}));await change(f,saved,next);
  await rejectAtomic(f,((request) as unknown as Parameters<NonNullable<typeof rejectAtomic>>[1]),['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND']);
 });
});

test('durable receipt failures and post-write owner corruption roll back timeline, redo branch, history and request together',async t=>{
 for(const mode of (['receipt failure','timeline owner','asset owner','source duration','source audio','response corruption','hash corruption'] as const))await t.test(mode,async t=>{
  const f=await fixture(t),timeline=await f.timeline(undefined,{fadeInFrames:2}),next=f.asset(),extra=await f.call('timeline.track.add',params(f,timeline,{kind:'audio'}));
  const current=await f.call('timeline.undo',params(f,extra)),request=replace(f,current,next);
  if(mode==='receipt failure')f.store.db.exec("CREATE TRIGGER fail_replacement_receipt BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
  if(mode==='timeline owner')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_owner AFTER UPDATE ON timelines BEGIN UPDATE timelines SET projectId='${f.otherId}' WHERE id=NEW.id; END;`);
  if(mode==='asset owner')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_source AFTER UPDATE ON timelines BEGIN UPDATE assets SET projectId='${f.otherId}' WHERE id='${next.id}'; END;`);
  if(mode==='source duration')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_duration AFTER UPDATE ON timelines BEGIN UPDATE assets SET data=json_set(data,'$.duration',1) WHERE id='${next.id}'; END;`);
  if(mode==='source audio')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_audio AFTER UPDATE ON timelines BEGIN UPDATE assets SET data=json_set(data,'$.hasAudio',json('false')) WHERE id='${next.id}'; END;`);
  if(mode==='response corruption')f.store.db.exec(`CREATE TRIGGER corrupt_replacement_receipt AFTER INSERT ON timeline_requests BEGIN DELETE FROM timeline_requests WHERE requestId=NEW.requestId; END;`);
  if(mode==='hash corruption')f.store.db.exec(`DROP TRIGGER immutable_timeline_responses; CREATE TRIGGER corrupt_replacement_hash AFTER INSERT ON timeline_requests BEGIN UPDATE timeline_requests SET requestHash='${'0'.repeat(64)}' WHERE requestId=NEW.requestId; END;`);
  const before=f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']);
  // These triggers move a row to a project this store does not hold, inside the service's own transaction.
  const reassigns=mode==='timeline owner'||mode==='asset owner';if(reassigns)f.store.db.exec('PRAGMA foreign_keys=OFF');
  try{await assert.rejects(f.call(operation,request),error=>{
   assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details?.mutationOutcome,undefined,'Post-write validation or database errors remain unknown to recovery clients');
   return mode==='receipt failure'?/injected receipt failure/.test((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message):['TIMELINE_SOURCE_UNAVAILABLE','CLIP_NOT_FOUND','INVALID_TIMELINE_SNAPSHOT','SOURCE_BOUNDS','FADE_AUDIO_UNSUPPORTED'].includes((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code);
  });}finally{if(reassigns)f.store.db.exec('PRAGMA foreign_keys=ON');}
  assert.deepEqual(f.capture([...outsideTables,'timelines','timeline_history','timeline_history_cursors','timeline_requests']),before);
 });
});

async function race(t: test.TestContext,f: Awaited<ReturnType<typeof fixture>>,inputs: unknown[]){
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({result:await createServices(store,new Map()).call('${operation}',workerData.input)});}catch(error){parentPort.postMessage({error:error.code||error.message});}finally{store.close();}});})().catch(error=>{throw error});`;
 const workers=inputs.map((input?)=>new Worker(source,{eval:true,workerData:{root:f.root,input,db:new URL('../packages/business/src/db.ts',import.meta.url).href,services:new URL('../packages/business/src/services.ts',import.meta.url).href}}));
 t.after(()=>Promise.all(workers.map((worker)=>worker.terminate())));
 await Promise.all(workers.map((worker)=>new Promise<{response:FixtureTimeline;result:FixtureTimeline;code:string;error:string;details:{mutationOutcome:string}}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));
 const pending=workers.map((worker)=>new Promise<{response:FixtureTimeline;result:FixtureTimeline;code:string;error:string;details:{mutationOutcome:string}}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach((worker)=>worker.postMessage('go'));
 return Promise.all(pending);
}
test('independent SQLite writers serialize exact duplicates once and conflicting fresh writers by CAS',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());
 const duplicate=await race(t,f,[request,request,request]);duplicate.forEach(value=>{assert.equal(value.error,undefined);assert.deepEqual(value.result,duplicate[0].result);});
 assert.equal(duplicate[0].result.revision,timeline.revision+1);
 const current=duplicate[0].result,requests=Array.from({length:3},()=>replace(f,current,f.asset()));
 const competing=await race(t,f,requests);assert.equal(competing.filter(value=>value.result).length,1);
 competing.filter(value=>value.error).forEach(value=>assert.equal(value.error,'REVISION_CONFLICT'));
 assert.equal((await f.call('timeline.get',{projectId:f.projectId})).revision,current.revision+1);
 assert.equal((await f.call('timeline.history.get',{projectId:f.projectId})).length,3);
});

test('replacement uses only local metadata and never invokes providers or network',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),request=replace(f,timeline,f.asset());
 let outbound=0;t.mock.method(globalThis,'fetch',()=>{outbound++;throw Error('Forbidden outbound');});
 const provider=new Proxy({}, {get(){outbound++;throw Error('Forbidden provider');}}),services=(createServices(f.store,((new Map([['mock',provider]])) as unknown as Parameters<typeof createServices>[1])) as FixtureServices);
 await services.call(operation,request);assert.equal(outbound,0);
});
