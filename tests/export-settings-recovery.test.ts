import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS,AppError,publicValue,isTimelineExportSnapshot,resolveTimelineExportDelivery} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import type {TestContext} from 'node:test';
import type {WorkspaceStore} from '../packages/business/src/db.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';

interface RecoveryTimeline {id: string; revision: number; tracks: Array<{id: string}>; clips: Array<{id: string} >; width: number; height: number}
interface RecoveryAsset {id: string; projectId: string; relativePath: string}
interface ExportSnapshotShape {delivery?: {effective: {width: number}; exportSettings: {rateControl: {quality?: string; [key: string]: unknown}}; timeline?: unknown}; [key: string]: unknown}
interface ExportRecordShape {id: string; purpose?: string; snapshot: ExportSnapshotShape; [key: string]: unknown}
const exportRecord = (value: unknown): ExportRecordShape => value as ExportRecordShape;
interface RecoveryFixture {
  root: string; readonly store: WorkspaceStore; readonly services: ReturnType<typeof createServices>; readonly probes: number;
  setInspect: (fn: (...args: unknown[]) => Promise<unknown>) => void;
  input: () => Record<string, unknown>; restart: () => Promise<void>; state: () => Record<string, unknown>;
  project: {id: string}; timeline: RecoveryTimeline; asset: RecoveryAsset;
}

const settings=()=>structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS);
async function fixture(t: Pick<TestContext,'after'>): Promise<RecoveryFixture>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-recovery-'));let store=openStore(root),probes=0;
 let inspect: (...args: unknown[]) => Promise<unknown> = async()=>{probes++;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};};
 let services=createServices(store,new Map(),{exportOptions:{inspect: inspect as never}});
 const f: RecoveryFixture={root,get store(){return store;},get services(){return services;},get probes(){return probes;},
  setInspect(fn: (...args: unknown[]) => Promise<unknown>): void{inspect=fn;},
  input:()=>({projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:settings()}),
  async restart(): Promise<void>{await services.drain();store.close();store=openStore(root);services=createServices(store,new Map(),{exportOptions:{inspect: inspect as never}});},
  state:()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name as string,store.db.prepare(`SELECT * FROM "${name as string}" ORDER BY rowid`).all()]))} as unknown as RecoveryFixture;
 f.project=await services.call('project.create',{name:'Recovery'}) as {id:string};f.timeline=await services.call('timeline.get',{projectId:f.project.id}) as RecoveryTimeline;
 const id=randomUUID();f.asset=store.put('assets',{id,projectId:f.project.id,name:'Unopened image',mimeType:'image/png',sha256:'a'.repeat(64),relativePath:`media/${id}.png`,width:720,height:1280,duration:0,hasAudio:false,sizeBytes:20,createdAt:new Date().toISOString()}) as RecoveryAsset;
 f.timeline=await services.call('timeline.clip.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),trackId:f.timeline.tracks[0]!.id,assetId:id,startFrame:0,durationFrames:30}) as RecoveryTimeline;
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});return f;
}

test('lost ACK recovery after restart returns byte-identical retained response before capability/freshness and never requeues',async t=>{
 const f=await fixture(t),input=f.input(),accepted=exportRecord(await f.services.call('timeline.render',input)),wire=JSON.stringify(accepted),raw=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string}).response;
 f.store.put('exports',{...exportRecord(f.store.get('exports',accepted.id)),status:'failed',error:{code:'EXPORT_FAILED',message:'Earlier worker failed',retryable:true},updatedAt:new Date().toISOString()});
 f.timeline=await f.services.call('timeline.clip.remove',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),clipId:f.timeline.clips[0]!.id}) as RecoveryTimeline;
 f.setInspect(async()=>{throw Error('Capability probe must never run for exact replay');});await f.restart();const before=f.state();
 assert.equal(JSON.stringify(await f.services.call('timeline.render',input)),wire);assert.equal((f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string}).response,raw);assert.deepEqual(f.state(),before);assert.equal(f.store.list('exports').length,1);assert.equal((f.store.get('exports',accepted.id) as {status:string}).status,'failed');assert.equal(f.probes,1);
});

test('omitted legacy receipts/snapshots remain absent and byte-exact through later edits and restart',async t=>{
 const f=await fixture(t),input=f.input();delete input.exportSettings;
 const result=exportRecord(await f.services.call('timeline.render',input)),wire=JSON.stringify(result),raw=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string}).response;
 assert.equal(Object.hasOwn(result.snapshot,'delivery'),false);assert.equal(f.probes,0);
 f.timeline=await f.services.call('timeline.track.add',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'}) as RecoveryTimeline;await f.restart();const before=f.state();
 assert.equal(JSON.stringify(await f.services.call('timeline.render',input)),wire);assert.equal((f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string}).response,raw);assert.deepEqual(f.state(),before);assert.equal(f.probes,0);
});

test('post-commit lost transport acknowledgement never acquires not-applied proof, and exact recovery creates no duplicate',async t=>{
 const f=await fixture(t),input=f.input(),store=f.store;
 const uncertain=createServices({...store,tx:(fn: () => unknown)=>{const count=(store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests').get() as {n:number}).n,result=store.tx(fn as never);if((store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests').get() as {n:number}).n>count)throw new AppError('EXPORT_CAPABILITY_FAILED','Transport acknowledgement lost after commit',409);return result;}} as unknown as Parameters<typeof createServices>[0],new Map(),{exportOptions:{inspect:async()=>({status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'})}});t.after(()=>uncertain.drain());
 await assert.rejects(uncertain.call('timeline.render',input),(e: unknown)=>{const error=e as {code?:string; details?:{mutationOutcome?:boolean}};return error.code==='EXPORT_CAPABILITY_FAILED'&&error.details?.mutationOutcome===undefined;});
 const row=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string},expected=publicValue(JSON.parse(row.response));assert.equal(store.list('exports').length,1);
 const before=f.state();assert.deepEqual(await f.services.call('timeline.render',input),expected);assert.deepEqual(f.state(),before);assert.equal(f.probes,0);
});

test('corrupt frozen delivery and ACK settings fail closed without fresh probe or key-release proof',async t=>{
 for(const target of ['export','receipt'])await t.test(target,async t=>{
  const f=await fixture(t),input=f.input(),result=exportRecord(await f.services.call('timeline.render',input));
  if(target==='export'){f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');const current=exportRecord(f.store.get('exports',result.id));const delivery=current.snapshot.delivery as {effective:{width:number}};delivery.effective.width+=2;assert.equal(isTimelineExportSnapshot(current.snapshot,{purpose:current.purpose}),false);f.store.put('exports',current);}
  else{f.store.db.exec('DROP TRIGGER immutable_timeline_responses');const row=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId as string) as {response:string},value=JSON.parse(row.response) as {snapshot:{delivery:{exportSettings:{rateControl:{quality:string}}}}};value.snapshot.delivery.exportSettings.rateControl.quality='high';f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(value),input.requestId as string);}
  const before=f.state();await assert.rejects(f.services.call('timeline.render',input),(e: unknown)=>{const error=e as {code?:string; details?:{mutationOutcome?:boolean}};return ['INVALID_TIMELINE_SNAPSHOT','TIMELINE_SOURCE_UNAVAILABLE'].includes(error.code??'')&&error.details?.mutationOutcome===undefined;});assert.deepEqual(f.state(),before);assert.equal(f.probes,1);
 });
});

test('worker rejects delivery on preview or invalid purpose before any local media process',async t=>{
 for(const purpose of ['preview','invalid',undefined])await t.test(String(purpose),async t=>{
  const f=await fixture(t),result=exportRecord(await f.services.call('timeline.render',f.input())),current=exportRecord(f.store.get('exports',result.id));current.purpose=purpose;f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');f.store.put('exports',current);
  assert.equal(isTimelineExportSnapshot(current.snapshot,{purpose}),false);
  let processes=0;const off=onMediaProcess(()=>processes++),worker=startWorker(f.store,f.services,new Map());
  try{await worker.tick();assert.deepEqual(f.store.get('exports',result.id),JSON.parse(JSON.stringify(current)) as unknown);assert.equal(processes,0);}finally{off();await worker.stop();}
 });
});


test('worker does not accept internally consistent delivery substituted for its immutable receipt',async t=>{
 const f=await fixture(t),result=exportRecord(await f.services.call('timeline.render',f.input())),current=exportRecord(f.store.get('exports',result.id));
 f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');current.snapshot.delivery=resolveTimelineExportDelivery(current.snapshot.timeline,{...settings(),resolution:'short_360'});f.store.put('exports',current);
 assert.equal(isTimelineExportSnapshot(current.snapshot,{purpose:current.purpose}),true);const before=f.state();
 let processes=0;const off=onMediaProcess(()=>processes++),worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();assert.deepEqual(f.state(),before);assert.equal(processes,0);}finally{off();await worker.stop();}
});

test('normal SQLite writes cannot alter frozen custom delivery, purpose, or original acknowledgement',async t=>{
 const f=await fixture(t),input=f.input(),result=exportRecord(await f.services.call('timeline.render',input)),before=f.state();
 const changed=exportRecord(f.store.get('exports',result.id));changed.snapshot.delivery=resolveTimelineExportDelivery(changed.snapshot.timeline,{...settings(),resolution:'short_360'});
 assert.throws(()=>f.store.put('exports',changed),/snapshots are immutable/);
 assert.throws(()=>f.store.put('exports',{...exportRecord(f.store.get('exports',result.id)),purpose:'preview'}),/snapshots are immutable/);
 assert.throws(()=>f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run('{}',input.requestId as string),/immutable/);
 assert.deepEqual(f.state(),before);
});


test('removing delivery before the first worker read cannot turn an accepted custom export into legacy encoding',async t=>{
 const f=await fixture(t),result=exportRecord(await f.services.call('timeline.render',f.input())),current=exportRecord(f.store.get('exports',result.id));
 f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');delete current.snapshot.delivery;f.store.put('exports',current);const before=f.state();
 let processes=0;const off=onMediaProcess(()=>processes++),worker=startWorker(f.store,f.services,new Map());
 try{await worker.tick();assert.deepEqual(f.state(),before);assert.equal(processes,0);}finally{off();await worker.stop();}
});
