import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {AppError,hasRequestNotAppliedProof,isTimelineMutationResponse} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest} from '../packages/contracts/src/timeline-loudness-apply.ts';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices,hash} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createTimelineMixLoudnessServices} from '../packages/business/src/timeline-mix-loudness.ts';
import {createTimelineLoudnessApplyServices} from '../packages/business/src/timeline-loudness-apply.ts';
import {readTimelinePreflightSnapshot,readTimelineSourceGraph} from '../packages/business/src/timeline-sources.ts';
import {validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {planTimelineMixLoudnessDecode} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {validateManagedSource,verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';
interface AssetView {id: string; projectId: string; name: string; mimeType: string; relativePath: string; sha256: string; sizeBytes: number; duration: number; hasAudio: boolean; hasVideo: boolean; width: number; height: number; url: string; createdAt: string}
interface ClipView {id: string; trackId: string; gain: number; startFrame: number; durationFrames: number; [key: string]: unknown}
interface TrackView {id: string; kind: string; muted: boolean; [key: string]: unknown}
interface TimelineView {id: string; projectId: string; revision: number; clips: ClipView[]; tracks: TrackView[]; updatedAt: string; [key: string]: unknown}
interface ReportView {applyAllowed: boolean; candidate: {meetsTruePeak: boolean; gains: {clipId: string; afterGain: number}[]}; identity: {snapshotSha256: string}; [key: string]: unknown}
interface InputView {projectId: string; expectedRevision: number; requestId: string; snapshotSha256: string; candidateDigest: string; mixProfile: string; measurementProfile: string; target: {integratedLufs: number; truePeakCeilingDbtp: number}; [key: string]: unknown}
interface ResponseView {timeline: TimelineView; requestId?: string; [key: string]: unknown}
interface EditTaskView {task: {id: string; digest: string}; instanceId: string}
interface TransactionsView {prepare(input: InputView): {replayed: boolean; response?: unknown}; accept(input: InputView, admission: {finalFence(): void; application: {gains: {clipId: string; beforeGain: number; afterGain: number}[]}}): ResponseView; rejectBeforeApply(input: InputView, error: unknown): unknown}
interface Fixture {root: string; decodes: number; owner: boolean; onNow: (() => void) | null; store: ReturnType<typeof openStore>; services: ReturnType<typeof createServices>; project: {id: string}; asset: AssetView; timeline: TimelineView; runtime: {decode(...args: unknown[]): Promise<unknown>; [key: string]: unknown}; transactions: TransactionsView; shared: {history(projectId: string): {length: number; undoEntry: {operation?: string}}}; mix: ReturnType<typeof createTimelineMixLoudnessServices>; review(): Promise<{report: ReportView; input: InputView}>; apply(input: InputView): Promise<ResponseView>; restart(): Promise<void>}
const operation='timeline.loudness.apply',sha=(bytes: Uint8Array | string): string=>createHash('sha256').update(bytes).digest('hex');
const clone=<T>(value: T): T=>structuredClone(value);
function readSaved(store: ReturnType<typeof openStore>,projectId: string): {timeline: TimelineView; assets: AssetView[]} | null {
  const {db}=store,outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
  try{const {timeline}=readTimelinePreflightSnapshot(store as never,projectId,undefined) as unknown as {timeline: TimelineView};if(!timeline)return null;
    const assets=readTimelineSourceGraph(db as never,projectId,timeline as never) as unknown as Map<string, AssetView>;validateTimeline(timeline as never,assets as never,{structureOnly:true});return {timeline,assets:[...assets.values()]};
  }finally{if(!outer&&db.isTransaction)db.exec('COMMIT');}
}
const byName=(a: {name: string},b: {name: string})=>a.name<b.name?-1:a.name>b.name?1:0;
function rows(db: ReturnType<typeof openStore>['db']): Record<string, Record<string, unknown>[]> {return Object.fromEntries(schemaObjects(db).filter(({type})=>type==='table').sort(byName)
  .map(({name}: {name: string})=>[name,db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[]]));}
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: import('node:test').TestContext,name='Foreign project'): Promise<{id: string}> {
  const root=await mkdtemp(path.join(tmpdir(),'mioon-atomic-gain-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=openStore(root),services=createServices(store,new Map());
  try{return await services.call('project.create',{name}) as {id: string};}
  finally{await services.drain();store.close();}
}
async function syntheticDecode(timeline: TimelineView,assets: AssetView[],options: {beforeEffect(): void; onPcm(chunk: Buffer): void}): Promise<{sampleRate: number; channels: number} & Record<string, unknown>> {
  const plan=planTimelineMixLoudnessDecode(timeline as never,assets as never),tracks=new Map<string, TrackView>(timeline.tracks.map((track: TrackView)=>[track.id,track]));options.beforeEffect();
  for(let begin=0;begin<plan.sampleFrames;begin+=8192){const length=Math.min(8192,plan.sampleFrames-begin),chunk=Buffer.alloc(length*8);
    for(let i=0;i<length;i++){const frame=(begin+i)/1600,gain=timeline.clips.reduce((sum: number,clip: ClipView)=>
      sum+(!(tracks.get(clip.trackId)?.muted)&&frame>=clip.startFrame&&frame<clip.startFrame+clip.durationFrames?clip.gain:0),0);
      const sample=.1*gain*Math.sin(2*Math.PI*997*(begin+i)/48000);chunk.writeFloatLE(sample,i*8);chunk.writeFloatLE(-sample,i*8+4);}
    options.onPcm(chunk);
  }return {sampleRate:48000,channels:2,...plan};
}
async function fixture(t: import('node:test').TestContext,{group=false}: {group?: boolean} = {}): Promise<Fixture> {
  const root=await mkdtemp(path.join(tmpdir(),'mioon-atomic-gain-'));let store=openStore(root),services=createServices(store,new Map()),mix: ReturnType<typeof createTimelineMixLoudnessServices> | undefined;
  const f = {root,decodes:0,owner:true,onNow:null,get store(){return store;},get services(){return services;}} as Fixture;
  const project=await services.call('project.create',{name:'Atomic gain'}) as {id: string},assetId=randomUUID(),bytes=Buffer.alloc(96*1024,7);
  const asset: AssetView={id:assetId,projectId:project.id,name:'Source.wav',mimeType:'audio/wav',relativePath:`media/${assetId}.wav`,sha256:sha(bytes),sizeBytes:bytes.length,
    duration:10,hasAudio:true,hasVideo:false,width:0,height:0,url:`/media/${assetId}`,createdAt:new Date().toISOString()};
  await writeFile(path.join(root,asset.relativePath),bytes,{mode:0o600});store.put('assets',asset as never);
  let timeline=await services.call('timeline.get',{projectId:project.id}) as TimelineView;
  const call=async(op: string,fields: Record<string, unknown>): Promise<TimelineView>=>timeline=await services.call(op as never,{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields} as never) as TimelineView;
  const audioTrack=timeline.tracks.find((track: TrackView)=>track.kind==='audio');assert.ok(audioTrack);const audio=audioTrack.id;
  await call('timeline.clip.add',{trackId:audio,assetId,startFrame:0,durationFrames:group?30:60,gain:.75,fadeInFrames:0});
  if(group){
    await call('timeline.clip.add',{trackId:audio,assetId,startFrame:30,durationFrames:30,gain:.4});
    await call('timeline.track.add',{kind:'audio',name:'Zero'});const zero=timeline.tracks.at(-1)?.id;
    await call('timeline.clip.add',{trackId:zero,assetId,startFrame:0,durationFrames:60,gain:0});
    await call('timeline.track.add',{kind:'audio',name:'Muted'});const muted=timeline.tracks.at(-1)?.id;
    await call('timeline.clip.add',{trackId:muted,assetId,startFrame:0,durationFrames:60,gain:1.25});
    await call('timeline.track.update',{trackId:muted,patch:{muted:true}});
  }
  function connect(): void {
    const required=(table: string,id: string)=>{const value=store.get(table,id);if(!value)throw new AppError('NOT_FOUND','Missing',404);return value as Record<string, unknown> & {revision: number};};
    const check=(value: {revision: number},revision: number)=>{if(value.revision!==revision)throw new AppError('REVISION_CONFLICT','Changed',409);};
    const assertAvailable=()=>{if(getWorkspaceRestoreContext(store))throw new AppError('RESTORE_OPERATION_UNAVAILABLE','Restored',409);
      if(!f.owner||!ownsStoreLock(store))throw new AppError('TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED','Owner required',403);};
    const shared=createTimelineServices(store as never,{required,check,hash,now:()=>{f.onNow?.();return new Date().toISOString();}} as never);
    const runtime={assertOrdinaryWorkspace:assertAvailable,ownsLock:()=>f.owner&&ownsStoreLock(store),readSavedTimeline:(projectId: string)=>readSaved(store,projectId),
      validateSource:validateManagedSource,hash:verifiedManagedHash,decode:async(...args: unknown[])=>{f.decodes++;return syntheticDecode(args[0] as TimelineView,args[1] as AssetView[],args[2] as {beforeEffect(): void; onPcm(chunk: Buffer): void});},
      terminate:async()=>[],waitForClose:async()=>[],boundedShutdown:async (work: Promise<unknown>)=>{await work;}};
    mix=createTimelineMixLoudnessServices(store as never,{runtime} as never) as ReturnType<typeof createTimelineMixLoudnessServices>;
    assert.ok(mix);
    f.transactions=shared.createLoudnessApplyTransactions(assertAvailable) as unknown as TransactionsView;f.shared=shared as unknown as Fixture['shared'];f.runtime=runtime;
    f.apply=createTimelineLoudnessApplyServices({measurement:mix,transactions:f.transactions as never,assertAvailable} as never).handlers[operation] as unknown as Fixture['apply'];
    f.review=async()=>{const current=store.get('timelines',timeline.id) as TimelineView,input={projectId:project.id,expectedRevision:current.revision,mixProfile:'timeline-float-mix-v1',
      measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
      const measurement=mix;assert.ok(measurement);const report=await (measurement.handlers['timeline.loudness.prepare'] as (value: unknown)=>Promise<ReportView>)(input);return {report,input:{...input,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,
        candidateDigest:await timelineLoudnessCandidateDigest(report as never)}} as {report: ReportView; input: InputView};};
  }
  connect();f.project=project;f.asset=asset;f.timeline=timeline;
  f.restart=async()=>{assert.ok(mix);await mix.drain();await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());connect();};
  t.after(async()=>{await mix?.drain().catch(()=>{});await services.drain().catch(()=>{});store.close();await rm(root,{recursive:true,force:true});});return f;
}
test('real shared SQLite transaction changes exact gains once; zero/muted, unrelated fields and old ACK bytes survive undo/redo',async t=>{
  const f=await fixture(t,{group:true}),{input,report}=await f.review(),before=clone(f.store.get('timelines',f.timeline.id) as TimelineView),historyBefore=f.shared.history(f.project.id),
    oldReceipts=f.store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all();
  const response=await f.apply(input),after=f.store.get('timelines',f.timeline.id) as TimelineView,gains=new Map(report.candidate.gains.map((gain: {clipId: string; afterGain: number})=>[gain.clipId,gain.afterGain]));
  assert.equal(gains.size,2);assert.equal(after.revision,before.revision+1);assert.equal(isTimelineMutationResponse(operation,input,response),true);
  const expected=clone(before);for(const clip of expected.clips)if(gains.has(clip.id))clip.gain=gains.get(clip.id) as number;expected.revision=after.revision;expected.updatedAt=after.updatedAt;
  assert.deepEqual(after,expected);assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all().slice(0,-1),oldReceipts);
  const history=f.shared.history(f.project.id);assert.equal(history.length,historyBefore.length+1);assert.equal(history.undoEntry.operation,operation);
  const undone=await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:after.revision,requestId:randomUUID()}) as unknown as TimelineView;
  assert.deepEqual(undone.clips,before.clips);assert.deepEqual(undone.tracks,before.tracks);
  const redone=await f.services.call('timeline.redo',{projectId:f.project.id,expectedRevision:undone.revision,requestId:randomUUID()}) as unknown as TimelineView;assert.deepEqual(redone.clips,after.clips);
});
test('same key replays exact stored ACK after undo/restart/missing media and decoder; wrong content and cross-operation conflict',async t=>{
  const f=await fixture(t),{input}=await f.review(),response=await f.apply(input),raw=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId) as {response: string}).response;
  await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID()} as never);
  await unlink(path.join(f.root,f.asset.relativePath));await f.restart();(f.runtime as {decode: (...args: unknown[]) => Promise<unknown>}).decode=async()=>{throw new Error('Decoder unavailable');};
  const before=rows(f.store.db),count=f.decodes;assert.equal(JSON.stringify(await f.apply(input)),raw);assert.equal(f.decodes,count);assert.deepEqual(rows(f.store.db),before);
  for(const patch of [{target:{...input.target,integratedLufs:-29}},{projectId:randomUUID()},{candidateDigest:'timeline-loudness-candidate-v1:'+ 'f'.repeat(64)}])
    await assert.rejects(f.apply({...input,...patch} as InputView),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.services.call('timeline.clip.update',{projectId:input.projectId,expectedRevision:input.expectedRevision,requestId:input.requestId,
    clipId:f.timeline.clips[0]?.id,patch:{gain:.5}} as never),{code:'IDEMPOTENCY_CONFLICT'});assert.deepEqual(rows(f.store.db),before);
});
test('receipt replay keeps historical source/lineage DB ownership without requiring a current clip',async t=>{
  const f=await fixture(t),{input}=await f.review(),response=await f.apply(input);
  await f.services.call('timeline.clip.remove',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID(),clipId:f.timeline.clips[0]?.id} as never);
  assert.deepEqual(await f.apply(input),response);
  const foreign=await foreignProject(t,'Foreign'),changed={...f.asset,projectId:foreign.id};
  withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(foreign.id,JSON.stringify(changed),f.asset.id));
  await assert.rejects(f.apply(input),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
});
test('revision maximum and ordinary CAS conflicts reject before decoder with exact owner-bound not-applied proof',async t=>{
  const f=await fixture(t),{input}=await f.review();let timeline=f.store.get('timelines',f.timeline.id) as TimelineView;timeline.revision++;f.store.put('timelines',timeline as never);
  const before=rows(f.store.db),count=f.decodes;await assert.rejects(f.apply(input),(error: unknown)=>(error as {code?: string}).code==='REVISION_CONFLICT'&&hasRequestNotAppliedProof(error as never,input as never,{operation}));
  assert.equal(f.decodes,count);assert.deepEqual(rows(f.store.db),before);
  timeline={...timeline,revision:Number.MAX_SAFE_INTEGER};f.store.put('timelines',timeline as never);const maximum={...input,expectedRevision:timeline.revision,requestId:randomUUID()};
  await assert.rejects(f.apply(maximum),(error: unknown)=>(error as {code?: string}).code==='TIMELINE_REVISION_LIMIT'&&hasRequestNotAppliedProof(error as never,maximum as never,{operation}));assert.equal(f.decodes,count);
});
test('candidate stale proof is specific and revoked ownership never receives a proof',async t=>{
  const f=await fixture(t),{input}=await f.review(),bad={...input,candidateDigest:'timeline-loudness-candidate-v1:'+ 'f'.repeat(64)},before=rows(f.store.db);
  await assert.rejects(f.apply(bad),(error: unknown)=>(error as {code?: string}).code==='TIMELINE_LOUDNESS_APPLY_STALE'&&hasRequestNotAppliedProof(error as never,bad as never,{operation}));assert.deepEqual(rows(f.store.db),before);
  const original=f.transactions.rejectBeforeApply;f.transactions.rejectBeforeApply=(value: InputView,error: unknown)=>{f.owner=false;return original(value,error);};
  await assert.rejects(f.apply({...bad,requestId:randomUUID()} as InputView),(error: unknown)=>(error as {code?: string}).code==='TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED'&&!(error as {details?: {mutationOutcome?: unknown}}).details?.mutationOutcome);
  assert.deepEqual(rows(f.store.db),before);
});
test('the final fence rejects a revision change after validation before writing any gain/history/receipt',async t=>{
  const f=await fixture(t),{input}=await f.review(),before=rows(f.store.db);let changed=false;
  f.onNow=()=>{if(changed)return;changed=true;const timeline=f.store.get('timelines',f.timeline.id) as TimelineView;timeline.revision++;f.store.put('timelines',timeline as never);};
  await assert.rejects(f.apply(input),{code:'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT'});assert.equal(changed,true);assert.deepEqual(rows(f.store.db),before);
});
const writeFaults: [string, RegExp][]=[['timeline',/^INSERT INTO timelines\(/u],['delete redo',/^DELETE FROM timeline_history WHERE/u],
  ['history',/^INSERT INTO timeline_history\(/u],['cursor',/^INSERT INTO timeline_history_cursors\(/u],['receipt',/^INSERT INTO timeline_requests\(/u]];
for(const [name,pattern]of writeFaults)for(const moment of ['before','after'])test(`atomic rollback at ${moment} ${name} preserves all raw rows and never claims not_applied`,async t=>{
  const f=await fixture(t,{group:true}),{input}=await f.review(),db=f.store.db,before=rows(db),prepare=db.prepare.bind(db);let fired=false;
  db.prepare=function(this: unknown,sql: string){const statement=prepare(sql);if(!pattern.test(sql))return statement;return new Proxy(statement,{get(target,key){
    const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
    if(key!=='run')return value.bind(target);return (...args: unknown[])=>{if(!fired&&moment==='before'){fired=true;throw Object.assign(new Error('Injected write'),{code:'INJECTED_WRITE'});}
      const result=Reflect.apply(value as (...values: unknown[])=>unknown,target,args);if(!fired&&moment==='after'){fired=true;throw Object.assign(new Error('Injected write'),{code:'INJECTED_WRITE'});}return result;};}});};
  try{await assert.rejects(f.apply(input),(error: unknown)=>(error as {code?: string}).code==='INJECTED_WRITE'&&!(error as {details?: {mutationOutcome?: unknown}}).details?.mutationOutcome);assert.equal(fired,true);}finally{db.prepare=prepare;}
  assert.equal(db.isTransaction,false);assert.deepEqual(rows(db),before);
});
test('no post-success fence can reclassify a committed application when owner closes immediately afterwards',async t=>{
  const f=await fixture(t),{input}=await f.review(),accept=f.transactions.accept;
  f.transactions.accept=(value: InputView,admission: {finalFence(): void; application: {gains: {clipId: string; beforeGain: number; afterGain: number}[]}})=>{const result=accept(value,admission);f.owner=false;return result;};
  const response=await f.apply(input);assert.equal(response.timeline.revision,input.expectedRevision+1);
  assert.ok(f.store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId));
});

function pcmWav(){
  const frames=3*48000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
  bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++){const sample=Math.round(.15*32767*Math.sin(2*Math.PI*997*i/48000));bytes.writeInt16LE(sample,44+i*4);bytes.writeInt16LE(-sample,46+i*4);}return bytes;
}
test('actual createServices media + durable lost-after-commit recovers original ACK after undo and restart without a second apply',async t=>{
  const f=await fixture(t),bytes=pcmWav(),asset={...f.asset,sizeBytes:bytes.length,sha256:sha(bytes),duration:3};
  await writeFile(path.join(f.root,asset.relativePath),bytes,{mode:0o600});f.store.put('assets',asset as never);
  const current=f.store.get('timelines',f.timeline.id) as TimelineView,prepareInput={projectId:f.project.id,expectedRevision:current.revision,mixProfile:'timeline-float-mix-v1',
    measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  const report=await f.services.call('timeline.loudness.prepare',prepareInput as never) as ReportView;assert.equal(report.applyAllowed,false);assert.equal(report.candidate.meetsTruePeak,true);
  const input={...prepareInput,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
  let tasks=createEditTasks({store:f.store,services:f.services,fault:(point: string)=>{if(point==='afterBusinessCommit')throw Error('Lost result after commit');}} as never);
  const saved=tasks.prepare({projectId:f.project.id,operation,input,origin:'new'}) as unknown as EditTaskView;
  await assert.rejects(tasks.execute({projectId:f.project.id,taskId:saved.task.id,digest:saved.task.digest,instanceId:saved.instanceId}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  const raw=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId) as {response: string}).response,response=JSON.parse(raw) as TimelineView & {timeline: TimelineView};
  assert.equal(isTimelineMutationResponse(operation,input as never,response as never),true);assert.equal((f.store.db.prepare('SELECT status FROM edit_tasks WHERE id=?').get(saved.task.id) as {status: string}).status,'dispatching');
  await f.services.call('timeline.undo',{projectId:f.project.id,expectedRevision:response.timeline.revision,requestId:randomUUID()} as never);
  await tasks.drain();await unlink(path.join(f.root,asset.relativePath));await f.restart();
  let dispatched=0;tasks=createEditTasks({store:f.store,services:{call(){dispatched++;throw Error('A retained receipt must not redispatch');}}} as never);
  assert.deepEqual(tasks.reconcileStartup(),{processed:1,unavailable:0});const recovered=tasks.get({projectId:f.project.id,taskId:saved.task.id}) as unknown as {task:{id:string;status:string;requestId:string;digest:string};instanceId:string};
  assert.equal(recovered.task.status,'applied');assert.equal(recovered.task.requestId,input.requestId);
  const replayed=await tasks.execute({projectId:f.project.id,taskId:recovered.task.id,digest:recovered.task.digest,instanceId:recovered.instanceId}) as unknown as {result: unknown};
  assert.equal(JSON.stringify(replayed.result),raw);assert.equal(dispatched,0);
  assert.equal(JSON.stringify(await f.services.call(operation as never,input as never)),raw);assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_history WHERE operation=?').get(operation) as {n: number}).n,1);
  await tasks.drain();
});

for(const moment of ['before','after'])test(`uncertain COMMIT ${moment} never carries not-applied proof and recovery uses the existing key`,async t=>{
  const f=await fixture(t),{input}=await f.review(),db=f.store.db,before=rows(db),exec=db.exec.bind(db);let fired=false;
  db.exec=function(this: unknown,sql: string){if(sql==='COMMIT'&&!fired&&db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId)){
    fired=true;if(moment==='after')exec(sql);throw Object.assign(new Error('Uncertain COMMIT'),{code:'SQLITE_IOERR'});}return exec(sql);};
  try{await assert.rejects(f.apply(input),(error: unknown)=>(error as {code?: string}).code==='SQLITE_IOERR'&&!(error as {details?: {mutationOutcome?: unknown}}).details?.mutationOutcome);assert.equal(fired,true);}finally{db.exec=exec;}
  if(moment==='before')assert.deepEqual(rows(db),before);
  else{const raw=(db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId) as {response: string}).response,count=f.decodes;
    assert.equal(JSON.stringify(await f.apply(input)),raw);assert.equal(f.decodes,count);}
});
test('a rollback replacement error cannot borrow the original candidate/CAS rejection proof',async t=>{
  const f=await fixture(t),{input}=await f.review(),db=f.store.db,timeline=f.store.get('timelines',f.timeline.id) as TimelineView;timeline.revision++;f.store.put('timelines',timeline as never);
  const before=rows(db),exec=db.exec.bind(db),replacement=new AppError('REVISION_CONFLICT','Rollback acknowledgement missing',409);let fired=false;
  db.exec=function(this: unknown,sql: string){if(sql==='ROLLBACK'&&!fired){fired=true;exec(sql);throw replacement;}return exec(sql);};
  try{await assert.rejects(f.apply(input),(error: unknown)=>error===replacement&&!(error as {details?: {mutationOutcome?: unknown}}).details?.mutationOutcome);assert.equal(fired,true);}finally{db.exec=exec;}
  assert.equal(db.isTransaction,false);assert.deepEqual(rows(db),before);
});
