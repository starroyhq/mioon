import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS,isTimelineExportCapabilitiesResponse,hasRequestNotAppliedProof,isExportPreflightResponse} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelinePreflightServices,timelineSnapshotHash} from '../packages/business/src/timeline-preflight.ts';
import type {TestContext} from 'node:test';
import type {WorkspaceStore} from '../packages/business/src/db.ts';
import {readTimelinePreflightSnapshot,validatePreparedTimelineSources} from '../packages/business/src/timeline-sources.ts';
import {schemaObjects} from './helpers/project-database.ts';

type PreparedSourceValue = Parameters<typeof validatePreparedTimelineSources>[3] extends Map<string, infer P> ? P : never;
interface ServiceError {code?: string; message?: string; details?: {mutationOutcome?: boolean; [key: string]: unknown}}
const serviceError = (value: unknown): ServiceError => value as ServiceError;
interface FixtureTimeline {id: string; revision: number; width: number; height: number; tracks: Array<{id: string}>}
interface FixtureAsset {id: string; projectId: string; width: number; height: number; duration: number; hasAudio: boolean; sha256: string; mimeType: string; relativePath: string}
interface Fixture {
  root: string; store: WorkspaceStore; services: ReturnType<typeof createServices>;
  project: {id: string}; other: {id: string}; probes: number;
  timeline?: FixtureTimeline; asset?: FixtureAsset;
  input: () => Record<string, unknown>; state: () => Record<string, unknown>;
}

const byName=(a: {name: string},b: {name: string})=>a.name<b.name?-1:a.name>b.name?1:0;
// The other project is not in this store; write the damaged row as a corrupt file would hold it.
const withoutForeignKeys=(db: WorkspaceStore['db'],write: () => void)=>{db.exec('PRAGMA foreign_keys=OFF');try{write();}finally{db.exec('PRAGMA foreign_keys=ON');}};
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: Pick<TestContext,'after'>): Promise<{id: string}>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-settings-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=openStore(root),services=createServices(store,new Map());
 try{return await services.call('project.create',{name:'Foreign project'}) as {id:string};}
 finally{await services.drain();store.close();}
}
const settings=()=>structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS);
const available=()=>({status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'});
const deferred=(): {promise: Promise<void>; resolve: () => void} => {let resolve: () => void = () => {};return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
async function fixture(t: Pick<TestContext,'after'>,{inspect=async()=>available(),empty=false}: {inspect?: (...args: unknown[]) => Promise<unknown>; empty?: boolean} = {}): Promise<Fixture>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-settings-')),store=openStore(root);
 let probes=0;
 const probeHandler=async(...args: unknown[]): Promise<unknown>=>{probes++;assert.equal(store.db.isTransaction,false);return inspect(...args);};
 const services=createServices(store,new Map(),{exportOptions:{inspect:probeHandler as never}});
 const project=await services.call('project.create',{name:'Export settings tests'}) as {id:string},other=await foreignProject(t);
 const f: Fixture={root,store,services,project,other,get probes(){return probes;},input:(): Record<string, unknown>=>({projectId:project.id,expectedRevision:f.timeline?.revision??1,requestId:randomUUID(),purpose:'export',exportSettings:settings()}),state:(): Record<string, unknown>=>Object.fromEntries(schemaObjects(store.db).filter(({type})=>type==='table').sort(byName).map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))};
 if(!empty){
  f.timeline=await services.call('timeline.get',{projectId:project.id}) as FixtureTimeline;
  const id=randomUUID(),bytes=Buffer.from('managed image fixture'),relativePath=`media/${id}.png`;await writeFile(path.join(root,relativePath),bytes);
  f.asset=store.put('assets',{id,projectId:project.id,name:'Image',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),relativePath,width:720,height:1280,duration:0,hasAudio:false,sizeBytes:bytes.length,createdAt:new Date().toISOString()});
  f.timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:f.timeline!.revision,requestId:randomUUID(),trackId:f.timeline!.tracks[0]!.id,assetId:id,startFrame:0,durationFrames:30}) as FixtureTimeline;
 }
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}

test('capability reads never create a missing timeline or write records; ready results bind selection',async t=>{
 const absent=await fixture(t,{empty:true}),before=absent.state(),input=absent.input();delete input.requestId;delete input.purpose;
 const missing=await absent.services.call('timeline.export.capabilities',input) as {status:string; issues:Array<{code:string}>};assert.equal(missing.status,'blocked');assert.equal(missing.issues[0]!.code,'TIMELINE_MISSING');assert.equal(absent.probes,0);assert.deepEqual(absent.state(),before);
 const f=await fixture(t),i=f.input();delete i.requestId;delete i.purpose;const state=f.state(),result=await f.services.call('timeline.export.capabilities',i) as {status:string};
 assert.ok(isTimelineExportCapabilitiesResponse(result,i));assert.equal(result.status,'available');assert.equal(f.probes,1);assert.deepEqual(f.state(),state);assert.ok(!JSON.stringify(result).includes(f.root));
 const stale=await f.services.call('timeline.export.capabilities',{...i,expectedRevision:(i.expectedRevision as number)+1}) as {status:string};assert.equal(stale.status,'stale');assert.equal(f.probes,1);
});

test('fresh custom render freezes selected delivery exactly; replay and changed same-key reuse never probe',async t=>{
 const f=await fixture(t),input=f.input(),timeline=structuredClone(f.timeline!),result=await f.services.call('timeline.render',input) as {snapshot:{delivery?: {exportSettings: unknown}; [key: string]: unknown}};
 assert.equal(f.probes,1);assert.deepEqual(result.snapshot.delivery?.exportSettings,input.exportSettings);assert.deepEqual(f.store.get('timelines',timeline.id),timeline);
 const before=f.state();assert.deepEqual(await f.services.call('timeline.render',input),result);assert.equal(f.probes,1);assert.deepEqual(f.state(),before);
 await assert.rejects(f.services.call('timeline.render',{...input,exportSettings:{...(input.exportSettings as Record<string,unknown>),resolution:'short_360'}}),(e: unknown)=>{const error=serviceError(e);return error.code==='IDEMPOTENCY_CONFLICT'&&!error.details?.mutationOutcome;});assert.equal(f.probes,1);assert.deepEqual(f.state(),before);
 const format=await f.services.call('timeline.format.get',{projectId:f.project.id}) as {blockedReasons:string[]};assert.ok(format.blockedReasons.includes('EXPORT_HISTORY'));
 const old=f.input();delete old.exportSettings;const oldResult=await f.services.call('timeline.render',old) as {snapshot:Record<string,unknown>};assert.equal(f.probes,1);assert.equal(Object.hasOwn(oldResult.snapshot,'delivery'),false);
});

test('custom capability rejection is a proven pre-write owned rollback; raw helper errors remain sanitized',async t=>{
 for(const outcome of [{status:'unavailable',code:'EXPORT_CAPABILITY_UNSUPPORTED'},{status:'incomplete',code:'EXPORT_CAPABILITY_TIMEOUT'},{status:'available',code:'untrusted',stderr:'/secret'}]){
  const f=await fixture(t,{inspect:async()=>outcome as Record<string,unknown>}) as Fixture,input=f.input(),before=f.state();
  await assert.rejects(f.services.call('timeline.render',input),(e: unknown)=>hasRequestNotAppliedProof(e,input,{operation:'timeline.render'})&&!JSON.stringify(e).includes('/secret'));
  assert.deepEqual(f.state(),before);assert.equal(f.probes,1);
 }
});

test('revision and ownership changes during capability await cannot accept or forge ownership proofs',async t=>{
 for(const kind of ['revision','assetOwner','timelineOwner','metadata'])await t.test(kind,async t=>{
  const gate=deferred(),entered=deferred(),f=await fixture(t,{inspect:async()=>{entered.resolve();await gate.promise;return available();}}) as Fixture,input=f.input();
  const pending=f.services.call('timeline.render',input);await entered.promise;
  if(kind==='revision')f.store.put('timelines',{...f.timeline!,revision:f.timeline!.revision+1});
  if(kind==='metadata')f.store.put('assets',{...f.asset!,width:1280,height:720});
  if(kind==='assetOwner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.asset!.id));
  if(kind==='timelineOwner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE timelines SET projectId=? WHERE id=?').run(f.other.id,f.timeline!.id));
  const before=f.state();gate.resolve();
  await assert.rejects(pending,(e: unknown)=>{
   const error=serviceError(e);
   assert.equal(Boolean(error.details?.mutationOutcome),['revision','metadata'].includes(kind));
   assert.ok(!JSON.stringify(e).includes(f.other.id));return true;
  });assert.deepEqual(f.state(),before);assert.equal(f.store.list('exports').length,0);
 });
});

test('capability reports become stale after asynchronous owner or content drift',async t=>{
 const gate=deferred(),entered=deferred(),f=await fixture(t,{inspect:async()=>{entered.resolve();await gate.promise;return available();}}) as Fixture,input=f.input();delete input.requestId;delete input.purpose;
 const pending=f.services.call('timeline.export.capabilities',input);await entered.promise;f.store.put('timelines',{...f.timeline!,revision:f.timeline!.revision+1});gate.resolve();
 const report=await pending as {status:string};assert.equal(report.status,'stale');assert.ok(isTimelineExportCapabilitiesResponse(report,input));assert.equal(f.store.list('exports').length,0);
});

test('settings-aware source preflight hashes and summarizes delivery without capability compute',async t=>{
 const f=await fixture(t) as Fixture,preflight=createTimelinePreflightServices(f.store,{probe:async()=>({width:720,height:1280,duration:0,hasAudio:false,hasVideo:true,videoStreamIndex:0}) as never});t.after(()=>preflight.drain());
 const input={projectId:f.project.id,expectedRevision:f.timeline!.revision,exportSettings:{...settings(),resolution:'short_360'}},before=f.state();
 const report=await (preflight.handlers['timeline.export.preflight'] as unknown as (value: unknown)=>Promise<Record<string,unknown>>)(input) as {status:string; snapshotHash:string; summary:{delivery:{effective:{width:number}}; width:number}};
 assert.ok(isExportPreflightResponse(report,input));assert.equal(report.status,'ready');assert.equal(report.summary.delivery.effective.width,360);assert.equal(report.summary.width,f.timeline!.width);assert.equal(f.probes,0);assert.deepEqual(f.state(),before);
 const preparedSnapshot=readTimelinePreflightSnapshot(f.store,f.project!.id,input.exportSettings as Record<string, unknown>).snapshot;
 assert.equal(report.snapshotHash,timelineSnapshotHash(preparedSnapshot!));
 const legacy=await (preflight.handlers['timeline.export.preflight'] as unknown as (value: unknown)=>Promise<Record<string,unknown>>)({projectId:f.project.id,expectedRevision:f.timeline!.revision}) as {snapshotHash:string; summary:Record<string,unknown>};
 assert.notEqual(report.snapshotHash,legacy.snapshotHash);assert.equal(Object.hasOwn(legacy.summary,'delivery'),false);
 const result=await f.services.call('timeline.render',{...f.input(),exportSettings:input.exportSettings,preflightSnapshotHash:report.snapshotHash}) as {snapshot:{delivery:{effective:{width:number}}}};
 assert.equal(result.snapshot.delivery.effective.width,360);
 await assert.rejects(f.services.call('timeline.render',{...f.input(),preflightSnapshotHash:report.snapshotHash}),(e: unknown)=>serviceError(e).code==='PREFLIGHT_STALE');assert.equal(f.probes,1);
});


test('post-capability source guard retains discovered metadata flexibility but fences exact immutable source identity',async t=>{
 const f=await fixture(t) as Fixture,snapshot=readTimelinePreflightSnapshot(f.store,f.project.id,settings()).snapshot;if(!snapshot)throw Error('missing snapshot');
 const snapshotArg=snapshot as unknown as Parameters<typeof validatePreparedTimelineSources>[2];
 const prepared=new Map(snapshot.assets.map(asset=>[asset.id,{...asset,width:111,height:222,duration:9,hasAudio:true,path:path.resolve(f.root,asset.relativePath as string)} as unknown as PreparedSourceValue]));
 f.store.put('assets',{...f.asset!,width:333,height:444,duration:8,hasAudio:true});const before=f.state();
 assert.doesNotThrow(()=>validatePreparedTimelineSources(f.store.db,f.project.id,snapshotArg,prepared,{root:f.root}));assert.deepEqual(f.state(),before);
 for(const patch of [{sha256:'b'.repeat(64)},{mimeType:'image/jpeg'},{relativePath:'media/private.png'},{projectId:f.other.id}]){
  f.store.put('assets',{...f.asset!,...patch});const changed=f.state();
  assert.throws(()=>validatePreparedTimelineSources(f.store.db,f.project.id,snapshotArg,prepared,{root:f.root}),(error: unknown)=>{const failure=serviceError(error);return failure.code==='TIMELINE_SOURCE_UNAVAILABLE'&&!(failure.message??'').includes('private');});assert.deepEqual(f.state(),changed);
 }
 f.store.put('assets',f.asset!);prepared.get(f.asset!.id)!.path='/private/changed';
 assert.throws(()=>validatePreparedTimelineSources(f.store.db,f.project.id,snapshotArg,prepared,{root:f.root}),(error: unknown)=>{const failure=serviceError(error);return failure.code==='TIMELINE_SOURCE_UNAVAILABLE'&&!(failure.message??'').includes('private');});
});
