/** Fixed media-runtime transport is mocked; owned SQLite, source graph, managed
 * file hash/inode preparation and private capabilities are the actual runtime. */
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {openOpacityCandidateStore, getOpacityCandidateAssembly} from '../../packages/business/src/opacity-candidate-store.ts';
import {installWorkspaceRestoreSchemaV43} from '../../packages/business/src/workspace-restore-schema-v43.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';
import {mkdtempPortable} from '../helpers/temp-root.ts';

const realRuntime = await import('../../packages/business/src/media-runtime.ts');
let probeCalls = 0;
mock.module('../../packages/business/src/media-runtime.ts', {namedExports: {...realRuntime,
  run: async (binary: string, argv: readonly string[], options: {beforeSpawn?: ()=>void; beforeEffect?: ()=>void}) => {
    assert.equal(binary, 'ffprobe');assert.ok(argv.includes('-show_streams'));options.beforeSpawn?.();options.beforeEffect?.();probeCalls++;
    return JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,duration:'1'}],format:{duration:'1'}});
  }, runStreaming: () => {throw Error('No external streaming media is permitted');},
}});
const {createServices} = await import('../../packages/business/src/services.ts');
const {claimOpacityCandidateExport, recoverOpacityCandidateExport, isOpacityCandidateExportClaim, matchesOpacityCandidateExport,
  prepareOpacityCandidateRenderInputs, createOpacityCandidateRenderAttempt, assertOpacityCandidateRenderAttempt, revokeOpacityCandidateExportClaim} = await import('../../packages/business/src/opacity-candidate-render-authority.ts');
const {bindTimelineOpacityRenderAttempt, getTimelineOpacityRenderBinding} = await import('../../packages/business/src/timeline-opacity-render-binding.ts');
const stamp = '2026-10-16T00:00:00.000Z';
interface LooseTimeline {clips: {opacityEnvelope: {points: unknown; [key: string]: unknown}; [key: string]: unknown}[]; [key: string]: unknown}
interface LooseSnapshot {timeline: LooseTimeline; delivery?: unknown; [key: string]: unknown}
interface LooseRow {snapshot: LooseSnapshot; id: string; status: string; requestId?: string; purpose?: string; renderAttemptId?: string; assetId?: string; url?: string; [key: string]: unknown}
interface LooseBinding {readLut: unknown; effectFence(callback?: unknown): ()=>void; filterForSegment(clipId: string,start: number,end: number,mode: string): string; validationSnapshot: LooseSnapshot; snapshot: LooseSnapshot; signal: AbortSignal; assert(): void; close(): void}
type LooseAssets = Map<string, Record<string, unknown>>;
const claimExport = (store: unknown,row: unknown,at: string): LooseRow => claimOpacityCandidateExport(store as never,row as never,at) as unknown as LooseRow;
const recoverExport = (store: unknown,row: unknown,at: string): boolean => recoverOpacityCandidateExport(store as never,row as never,at);
const isExportClaim = (store: unknown,row: unknown): boolean => isOpacityCandidateExportClaim(store as never,row as never);
const matchesExport = (store: unknown,row: unknown): boolean => matchesOpacityCandidateExport(store as never,row as never);
const prepareInputs = (store: unknown,row: unknown,options?: unknown): Promise<LooseAssets> => prepareOpacityCandidateRenderInputs(store as never,row as never,options as never) as unknown as Promise<LooseAssets>;
const createAttempt = (store: unknown,row: unknown,assets: LooseAssets): LooseBinding => createOpacityCandidateRenderAttempt(store as never,row as never,assets as never) as unknown as LooseBinding;
const assertAttempt = (attempt: unknown): void => assertOpacityCandidateRenderAttempt(attempt as never);
const revokeClaim = (store: unknown,row: unknown): void => revokeOpacityCandidateExportClaim(store as never,row as never);
const bindAttempt = (store: unknown,row: unknown,assets: LooseAssets,options?: {signal?: AbortSignal}): LooseBinding => bindTimelineOpacityRenderAttempt(store as never,row as never,assets as never,options as never) as unknown as LooseBinding;
const readBinding = (snapshot: unknown,assets?: LooseAssets): LooseBinding => getTimelineOpacityRenderBinding(snapshot as never,assets as never) as unknown as LooseBinding;
const denied = (error: unknown): boolean => ['RESTORE_OPERATION_UNAVAILABLE', 'OPACITY_RENDER_BINDING_UNAVAILABLE'].includes((error as {code?: string})?.code ?? '');
function fixture(t: unknown) {
  const root = mkdtempPortable('mioon-opacity-authority-');
  const ids = Object.fromEntries(['project','asset','timeline','track','clip'].map(key => [key, randomUUID()]));
  const bytes = Buffer.from('synthetic source: real hash, no media decoder');
  let store!: ReturnType<typeof openOpacityCandidateStore>, services!: ReturnType<typeof createServices>;
  const events: unknown[] = [], off = onMediaProcess((event: unknown) => events.push(event));
  const providers = new Proxy(new Map(), {get() {throw Error('No provider access');}}) as never;
  const open = () => {store = openOpacityCandidateStore(root);services = createServices(store, providers);};open();
  writeFileSync(path.join(root,'media','source.mp4'), bytes, {mode:0o600});
  store.put('projects', {id:ids.project,name:'Synthetic',revision:1,createdAt:stamp,updatedAt:stamp});
  store.put('assets', {id:ids.asset,projectId:ids.project,name:'Synthetic source',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:false,
    sha256:createHash('sha256').update(bytes).digest('hex'),relativePath:'media/source.mp4',createdAt:stamp});
  store.put('timelines', {id:ids.timeline,projectId:ids.project,revision:1,fps:30,width:720,height:1280,tracks:[{id:ids.track,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:ids.clip,trackId:ids.track,assetId:ids.asset,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
      opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]}}],durationFrames:30,createdAt:stamp,updatedAt:stamp});
  const f = {root, ids, get store(){return store;}, get services(){return services;},
    async accept(context: Record<string, unknown>={}): Promise<LooseRow> {return services.call('timeline.render',{projectId:ids.project,requestId:randomUUID(),expectedRevision:1,purpose:'preview'},context as never) as unknown as LooseRow;},
    claim(row: unknown): LooseRow {return store.tx(() => claimExport(store as never,row as never,stamp));},
    async prepare(row: LooseRow,options?: unknown): Promise<LooseAssets> {return prepareInputs(store as never,row as never,options as never);},
    async close() {await services.drain();store.close();},
    async reopen() {await f.close();open();},
    async restore() {await f.close();const db=new DatabaseSync(path.join(root,'workbench.sqlite'));const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp};
      try {db.exec('PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,metadata);} finally {db.close();}open();return metadata;},
  };
  (t as {after(callback: ()=>Promise<void>): void}).after(async()=>{try {await f.close();assert.deepEqual(events,[]);} finally {off();rmSync(root,{recursive:true,force:true});}});
  return f;
}

test('actual42 admission, claim, fixed hash preparation and exact snapshot binding compile a usable stage', async t => {
  const f=fixture(t), queued=await f.accept(), row=f.claim(queued), before=probeCalls, assets=await f.prepare(row);
  assert.equal(probeCalls,before+1);assert.equal(isExportClaim(f.store,row),true);
  assert.equal(Object.isFrozen(assets.get(f.ids.asset)),true);
  const binding=bindAttempt(f.store,row,assets), raw=JSON.stringify(row.snapshot);
  assert.equal(readBinding(row.snapshot,assets),binding);
  assert.throws(()=>readBinding(row.snapshot),denied);
  assert.throws(()=>readBinding(row.snapshot,new Map(assets)),denied);
  const substituted=new Map([...assets].map(([id,asset])=>[id,{...asset,path:'/never-opened/foreign.mp4'}]));
  assert.throws(()=>readBinding(row.snapshot,substituted),denied);
  assert.equal(readBinding(row.snapshot,assets),binding);
  assert.equal(binding.readLut,undefined);
  let fenced=0;binding.effectFence(()=>{fenced++;})();assert.equal(fenced,1);
  assert.doesNotThrow(binding.effectFence());
  assert.throws(()=>binding.effectFence({assert(){}}),denied);
  assert.match(binding.filterForSegment(f.ids.clip,0,3,'straight'),/geq=/u);
  assert.equal(Object.hasOwn(binding.validationSnapshot.timeline.clips[0],'opacityEnvelope'),false);
  assert.equal(Object.isFrozen(row.snapshot.timeline.clips[0].opacityEnvelope.points),true);
  assert.equal(JSON.stringify(row.snapshot),raw);
  assert.throws(()=>readBinding(structuredClone(row.snapshot),assets),denied);
  assert.throws(()=>readBinding(JSON.parse(raw),assets),denied);
  assert.throws(()=>binding.filterForSegment(f.ids.clip,0,3,'premultiplied'),denied);
  const finalFence=binding.effectFence();binding.close();
  assert.throws(finalFence,denied);assert.throws(()=>readBinding(row.snapshot,assets),denied);
});

test('copied store, row, Map, attempt and cross-store handles cannot confer candidate authority', async t => {
  const f=fixture(t), g=fixture(t), queued=await f.accept(), row=f.claim(queued), assets=await f.prepare(row);
  assert.equal(matchesExport({...f.store},row),false);
  assert.equal(isExportClaim(f.store,structuredClone(row)),false);
  assert.throws(()=>createAttempt(f.store,row,new Map(assets)),denied);
  assert.throws(()=>createAttempt(g.store,row,assets),denied);
  // The cross-store refusal permanently consumes the invalid proof, so obtain
  // a fresh actual preparation before exercising the legitimate attempt.
  const fresh=await f.prepare(row), attempt=createAttempt(f.store,row,fresh);
  assert.equal(attempt.snapshot,row.snapshot);assert.doesNotThrow(attempt.assert);
  assert.throws(()=>assertAttempt({...attempt}),denied);
  assert.throws(()=>createAttempt(f.store,row,fresh),denied);
  attempt.close();assert.throws(attempt.assert,denied);
});

test('worker attempt survives settled RPC but abort permanently revokes binding', async t => {
  const f=fixture(t), row=f.claim(await f.accept()), controller=new AbortController(), assets=await f.prepare(row);
  const binding=bindAttempt(f.store,row,assets,{signal:controller.signal});
  assert.equal(binding.signal,controller.signal);
  await Promise.resolve();assert.doesNotThrow(binding.assert);
  assert.throws(binding.effectFence(()=>controller.abort()),denied);assert.throws(binding.assert,denied);
  assert.throws(()=>readBinding(row.snapshot,assets),denied);
  const g=fixture(t), secondRow=g.claim(await g.accept()), preparedOwner=new AbortController(), extraOwner=new AbortController();
  const secondAssets=await g.prepare(secondRow,{signal:preparedOwner.signal});
  const second=bindAttempt(g.store,secondRow,secondAssets,{signal:extraOwner.signal});
  assert.equal(second.signal.aborted,false);preparedOwner.abort();
  assert.equal(extraOwner.signal.aborted,false);assert.equal(second.signal.aborted,true);
  assert.throws(second.assert,denied);
});

test('replacing a prepared entry with equal copied evidence permanently revokes the exact proof', async t => {
  const f=fixture(t), row=f.claim(await f.accept()), assets=await f.prepare(row), binding=bindAttempt(f.store,row,assets);
  const actual=assets.get(f.ids.asset);assert.ok(actual);assets.set(f.ids.asset,{...actual});
  assert.throws(binding.assert,denied);assets.set(f.ids.asset,actual);assert.throws(binding.assert,denied);
});

test('source byte or inode changes are fenced even without a colour plan', async t => {
  const f=fixture(t), row=f.claim(await f.accept()), assets=await f.prepare(row), binding=bindAttempt(f.store,row,assets);
  assert.equal(Object.hasOwn(row.snapshot,'colourPlan'),false);
  const file=path.join(f.root,'media','source.mp4'), bytes=readFileSync(file);
  const fence=binding.effectFence(()=>writeFileSync(file,Buffer.from('different source'),{mode:0o600}));
  assert.throws(fence);writeFileSync(file,bytes,{mode:0o600});assert.throws(binding.assert,denied);
});

test('observed row status change revokes permanently and a later same-status claim cannot revive an old object', async t => {
  const f=fixture(t), row=f.claim(await f.accept()), assets=await f.prepare(row), binding=bindAttempt(f.store,row,assets);
  f.store.put('exports',{...row,status:'queued'});assert.throws(binding.assert,denied);
  const next=f.claim(f.store.get('exports',row.id));assert.equal(isExportClaim(f.store,row),false);
  assert.equal(isExportClaim(f.store,next),true);assert.throws(binding.assert,denied);
  const g=fixture(t), other=g.claim(await g.accept()), prepared=await g.prepare(other), guarded=bindAttempt(g.store,other,prepared);
  g.store.put('exports',{...other,assetId:randomUUID(),url:'/media/invalid-running-output'});
  assert.throws(guarded.assert,denied);
  g.store.put('exports',other);assert.throws(guarded.assert,denied);
});

test('cold reopen recovers an interrupted accepted row but never steals a live private claim', async t => {
  const f=fixture(t), row=f.claim(await f.accept());
  assert.equal(f.store.tx(()=>recoverExport(f.store,row,stamp)),false);
  await f.reopen();const captured=f.store.get('exports',row.id);
  assert.equal(f.store.tx(()=>recoverExport(f.store,captured,stamp)),true);
  assert.equal((f.store.get('exports',row.id) as LooseRow).status,'queued');
  const next=f.claim(f.store.get('exports',row.id));assert.equal(isExportClaim(f.store,next),true);
  revokeClaim(f.store,next);assert.equal(isExportClaim(f.store,next),false);
});

test('restored43 captured exports stay held while fresh explicit-origin export uses actual origin receipt and preparation', async t => {
  const f=fixture(t), captured=await f.accept(), metadata=await f.restore();
  assert.equal(matchesExport(f.store,captured),false);
  assert.throws(()=>f.claim(captured),denied);
  await assert.rejects(f.accept(),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  const queued=await f.accept({expectedWorkspaceOrigin:metadata.workspaceOrigin});
  const origin=f.store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(queued.id) as {workspaceOrigin: string; requestScope: string};
  assert.equal(origin.workspaceOrigin,metadata.workspaceOrigin);assert.equal(origin.requestScope,'timeline.render');
  const row=f.claim(queued), assets=await f.prepare(row), binding=bindAttempt(f.store,row,assets);
  assert.doesNotThrow(binding.assert);assert.equal(getOpacityCandidateAssembly(f.store)?.getRestoreContext()?.schemaVersion,43);
  await f.reopen();assert.throws(binding.assert);assert.equal(matchesExport(f.store,f.store.get('exports',queued.id)),true);
});

test('candidate float outcomes retain the raw snapshot digest and independently owned output hash guards', async t => {
  const f=fixture(t), original=await f.accept();
  const {resolveTimelineExportDelivery}=await import('../../packages/contracts/src/index.ts');
  const {floatSnapshotSha256}=await import('../../packages/business/src/timeline-float-outcome.ts');
  const {TIMELINE_EXPORT_FLOAT_PROFILE_ID,TIMELINE_EXPORT_FLOAT_POLICY_ID}=await import('../../packages/contracts/src/timeline-export-float.ts');
  const settings={profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
  const input={projectId:f.ids.project,requestId:randomUUID(),expectedRevision:1,purpose:'export',exportSettings:settings};
  const queued={...structuredClone(original),id:randomUUID(),requestId:input.requestId,purpose:'export'};
  queued.snapshot.delivery=resolveTimelineExportDelivery(queued.snapshot.timeline,settings);
  const digest=(value: unknown): string=>createHash('sha256').update(JSON.stringify(value,(_key,part)=>part&&typeof part==='object'&&!Array.isArray(part)?Object.fromEntries(Object.entries(part).sort(([a],[b])=>a.localeCompare(b))):part)).digest('hex');
  const requestHash=digest({operation:'timeline.render',input}), assembly=getOpacityCandidateAssembly(f.store);assert.ok(assembly);
  assembly.withInvocation('timeline.render',input,{},frozen=>f.store.tx(()=>{
    f.store.put('exports',queued);f.store.db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(queued));
    assembly.bindExport('timeline.render',frozen,queued,requestHash);
  }));
  const running=f.claim(queued), outputId=randomUUID(), outputSha='c'.repeat(64);
  assert.equal(typeof running.renderAttemptId,'string');assert.equal(isExportClaim(f.store,running),true);
  f.store.put('assets',{...(f.store.get('assets',f.ids.asset) as Record<string, unknown>),id:outputId,provenance:'export',sha256:outputSha,relativePath:'media/synthetic-output.mp4'});
  const succeeded={...running,status:'succeeded',assetId:outputId,url:`/media/${outputId}`,audioCheck:{schemaVersion:1,profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,
    policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,stage:'preencode_float_mix',projectId:f.ids.project,exportId:running.id,attemptId:running.renderAttemptId,
    snapshotSha256:floatSnapshotSha256(running.snapshot),outputFrames:30,checkedAt:stamp,status:'complete',code:'EXPORT_AUDIO_WITHIN_LIMIT',
    measurement:{sampleRate:48000,channels:2,sampleFormat:'f32le',sampleFrames:48000,sampleCount:96000,peakLinear:.5,overRangeSampleCount:0,
      channelPeaks:[{channel:0,peakLinear:.5,overRangeSampleCount:0},{channel:1,peakLinear:0,overRangeSampleCount:0}]},output:{assetId:outputId,sha256:outputSha}}};
  f.store.put('exports',succeeded);assert.equal(matchesExport(f.store,succeeded),true);
  const wrongSnapshot={...succeeded,audioCheck:{...succeeded.audioCheck,snapshotSha256:'d'.repeat(64)}};
  f.store.put('exports',wrongSnapshot);assert.equal(matchesExport(f.store,wrongSnapshot),false);
  const wrongOutput={...succeeded,audioCheck:{...succeeded.audioCheck,output:{assetId:outputId,sha256:'e'.repeat(64)}}};
  f.store.put('exports',wrongOutput);assert.equal(matchesExport(f.store,wrongOutput),false);
  f.store.put('exports',succeeded);assert.equal(matchesExport(f.store,succeeded),true);
});
