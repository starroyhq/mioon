import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineMixLoudnessServices} from '../packages/business/src/timeline-mix-loudness.ts';
import {createTimelineLoudnessApplyServices} from '../packages/business/src/timeline-loudness-apply.ts';
import {planTimelineMixLoudnessDecode} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {timelineLoudnessCandidateDigest,createTimelineLoudnessApplyContracts} from '../packages/contracts/src/timeline-loudness-apply.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
const {isTimelineLoudnessApplyResponse}=createTimelineLoudnessApplyContracts({isTimelineRecord});
interface ClipView {id: string; trackId: string; assetId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; rect: {x: number; y: number; width: number; height: number}}
interface TimelineFixtureView {id: string; projectId: string; revision: number; fps: number; width: number; height: number; tracks: {id: string; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean}[]; clips: ClipView[]; durationFrames: number; createdAt: string; updatedAt: string}
interface AssetView {id: string; projectId: string; relativePath: string; sha256: string; sizeBytes: number; mimeType: string; duration: number; hasAudio: boolean}
interface SnapshotView {timeline: TimelineFixtureView; assets: AssetView[]}
interface FileInfoView {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}
interface DecodeOptions {beforeEffect(): void; onPcm(chunk: Buffer): void}
interface EffectContext {beforeEffect(): void; onBytes(value: number): void}
interface GainView {clipId: string; assetId?: string; beforeGain: number; afterGain: number}
interface ReportView {candidate: {status: string; meetsTarget: boolean; meetsTruePeak: boolean; gainMultiplier: number; gains: GainView[]}; identity: {snapshotSha256: string}; original: {integratedLufs: number; [key: string]: unknown}; applyAllowed: boolean}
interface InputView {projectId: string; requestId: string; snapshotSha256: string; candidateDigest: string; target: {integratedLufs: number; truePeakCeilingDbtp: number}; [key: string]: unknown}
interface ResponseView {requestId: string; timeline: TimelineFixtureView; application: {gains: GainView[]; marginDb: number; target: unknown; candidateDigest: string; [key: string]: unknown}}
interface PrepareInputView {projectId: string; expectedRevision: number; mixProfile: string; measurementProfile: string; target: {integratedLufs: number; truePeakCeilingDbtp: number}}
interface RuntimeMock {assertOrdinaryWorkspace(): void; ownsLock(): boolean; readSavedTimeline(): SnapshotView; validateSource(): {file: string; info: FileInfoView}; hash(root: string, source: AssetView, context: EffectContext): Promise<{sha256: string; sizeBytes: number; file: string; info: FileInfoView}>; decode(timeline: TimelineFixtureView, assets: AssetView[], context: DecodeOptions): Promise<unknown>; terminate(): Promise<unknown[]>; waitForClose(): Promise<unknown[]>; boundedShutdown(work: Promise<unknown>): Promise<unknown>}
interface TransactionsMock {prepare(input: InputView): {replayed: boolean; response?: unknown}; accept(input: InputView, admission: {finalFence(): void; application: {gains: GainView[]}}): ResponseView; rejectBeforeApply(input: InputView, error: unknown): unknown}
interface ApplyBusinessFixture {db: DatabaseSync; owner: AbortController; snapshot: SnapshotView; info: FileInfoView; owned: boolean; ordinary: boolean; decodes: number; hashes: number; retired: number; accepts: number; rejected: number; receipt: ResponseView | null; history: TimelineFixtureView[]; phase: string[]; runtime: RuntimeMock; mix: ReturnType<typeof createTimelineMixLoudnessServices>; prepareInput: PrepareInputView; transactions: TransactionsMock; apply(input: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<ResponseView>; review(input?: PrepareInputView): Promise<{report: ReportView; input: InputView}>}
const deferred=<T = unknown>(): {promise: Promise<T>; resolve: (value: T) => void} => {let resolve!: (value: T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const tick=(): Promise<void>=>new Promise<void>(r=>{setImmediate(r);});
async function decode(timeline: TimelineFixtureView, assets: AssetView[], options: DecodeOptions, scale = 1): Promise<{sampleRate: number; channels: number} & Record<string, unknown>> {
  const plan=planTimelineMixLoudnessDecode(timeline as never,assets as never),gain=timeline.clips[0]?.gain ?? 0;
  options.beforeEffect();
  for(let begin=0;begin<plan.sampleFrames;begin+=8192){
    const frames=Math.min(8192,plan.sampleFrames-begin),chunk=Buffer.alloc(frames*8);
    for(let i=0;i<frames;i++){const sample=.1*gain*scale*Math.sin(2*Math.PI*997*(begin+i)/48000);
      chunk.writeFloatLE(sample,i*8);chunk.writeFloatLE(-sample,i*8+4);}
    options.onPcm(chunk);
  }
  return {sampleRate:48000,channels:2,...plan};
}
// These unit tests exercise the admission service and private measurement
// lifetime. The production shared timeline transaction is tested separately.
async function fixture(t: import('node:test').TestContext, options: {runtime?: Record<string, unknown>} = {}): Promise<ApplyBusinessFixture> {
  const db=new DatabaseSync(':memory:'),owner=new AbortController(),trackId=randomUUID(),assetId=randomUUID(),projectId=randomUUID();
  const timeline: TimelineFixtureView={id:randomUUID(),projectId,revision:4,fps:30,width:1280,height:720,
    tracks:[{id:trackId,name:'Audio',kind:'audio',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:randomUUID(),trackId,assetId,name:'Tone',startFrame:0,durationFrames:60,sourceInFrame:0,
      gain:.75,rect:{x:0,y:0,width:1280,height:720}}],durationFrames:60,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'};
  const asset: AssetView={id:assetId,projectId,relativePath:`media/${assetId}.wav`,sha256:'a'.repeat(64),sizeBytes:32,
    mimeType:'audio/wav',duration:10,hasAudio:true};
  const snapshot: SnapshotView={timeline,assets:[asset]},info: FileInfoView={dev:1,ino:2,size:32,mtimeMs:1,ctimeMs:1};
  const f = {db,owner,snapshot,info,owned:true,ordinary:true,decodes:0,hashes:0,retired:0,accepts:0,rejected:0,receipt:null,history:[],phase:[]} as unknown as ApplyBusinessFixture;
  const runtime: RuntimeMock={assertOrdinaryWorkspace(){if(!f.ordinary)throw Object.assign(new Error('Restored'),{code:'RESTORE_OPERATION_UNAVAILABLE'});},
    ownsLock:()=>f.owned,readSavedTimeline:()=>snapshot,
    validateSource:()=>({file:'/synthetic/owned.wav',info:{...info}}),
    async hash(root: string,source: AssetView,context: EffectContext){f.hashes++;context.beforeEffect();context.onBytes(32);
      return {sha256:source.sha256,sizeBytes:32,file:'/synthetic/owned.wav',info:{...info}};},
    async decode(timeline: TimelineFixtureView,assets: AssetView[],context: DecodeOptions){f.decodes++;return decode(timeline,assets,context);},
    async terminate(){f.retired++;return [];},async waitForClose(){return [];},async boundedShutdown(work: Promise<unknown>){await work;},...options.runtime} as RuntimeMock;
  f.runtime=runtime;
  f.mix=createTimelineMixLoudnessServices({db,root:'/synthetic'} as never,{runtime,signal:owner.signal} as never);
  f.prepareInput={projectId,expectedRevision:4,mixProfile:'timeline-float-mix-v1',measurementProfile:'bs1770-5-48k-stereo-fir4x-v1',
    target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
  f.transactions={prepare(input: InputView){f.phase.push('receipt');return f.receipt?{replayed:true,response:f.receipt}:{replayed:false};},
    accept(input: InputView,admission: {finalFence(): void; application: {gains: GainView[]}}){f.phase.push('accept');if(f.receipt)return f.receipt;admission.finalFence();f.accepts++;
      f.history.push(structuredClone(snapshot.timeline));
      for(const gain of admission.application.gains){const clip=snapshot.timeline.clips.find((value: ClipView)=>value.id===gain.clipId);assert.ok(clip);
        assert.equal(clip.gain,gain.beforeGain);clip.gain=gain.afterGain;}
      snapshot.timeline.revision++;f.receipt={operation:'timeline.loudness.apply',requestId:input.requestId,
        timeline:structuredClone(snapshot.timeline),application:admission.application} as unknown as ResponseView;return f.receipt;},
    rejectBeforeApply(input: InputView,error: unknown){f.rejected++;if(f.receipt)return f.receipt;throw error;}};
  f.apply=createTimelineLoudnessApplyServices({measurement:f.mix,transactions:f.transactions as never,assertAvailable(){
    runtime.assertOrdinaryWorkspace();if(!f.owned)throw Object.assign(new Error('Owner'),{code:'TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED'});
    if(owner.signal.aborted)throw Object.assign(new Error('Stopped'),{code:'OPERATION_CANCELLED'});
  }} as never).handlers['timeline.loudness.apply'] as unknown as ApplyBusinessFixture['apply'];
  f.review=async(input: PrepareInputView = f.prepareInput)=>{const report=await (f.mix.handlers['timeline.loudness.prepare'] as (value: unknown) => Promise<ReportView>)(input);
    return {report,input:{...input,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)}};};
  t.after(async()=>{await f.mix.drain().catch(()=>{});db.close();});return f;
}
test('apply performs a new complete double measurement and double hash, then exact group admission',async t=>{
  const f=await fixture(t),{input,report}=await f.review();assert.equal(report.applyAllowed,false);
  assert.equal(f.decodes,2);assert.equal(f.hashes,2);
  const response=await f.apply(input);assert.equal(f.decodes,4);assert.equal(f.hashes,4);assert.equal(f.retired,2);
  assert.equal(f.accepts,1);assert.equal(f.history.length,1);assert.equal(isTimelineLoudnessApplyResponse(response,input),true);
  assert.deepEqual(response.application.gains,report.candidate.gains);assert.equal(response.timeline.revision,5);
  assert.equal(response.application.marginDb,.5);assert.ok(Object.isFrozen(response.application));
});
test('same-key retained ACK precedes media even after undo, source loss, unavailable decoder and restart wrapper',async t=>{
  const f=await fixture(t),{input}=await f.review(),original=await f.apply(input),text=JSON.stringify(original);
  f.snapshot.timeline=structuredClone(f.history[0]);f.snapshot.timeline.revision=6;
  f.runtime.decode=async()=>{throw new Error('Missing decoder');};f.runtime.validateSource=()=>{throw new Error('Missing media');};
  const counts=[f.hashes,f.decodes];assert.equal(await f.apply(input),original);assert.equal(JSON.stringify(await f.apply(input)),text);
  const restarted=createTimelineLoudnessApplyServices({measurement:{withFreshMeasurement(){throw new Error('Must not measure');}},
    transactions:f.transactions as never,assertAvailable(){}} as never).handlers['timeline.loudness.apply'];
  assert.equal(JSON.stringify(await restarted(input)),text);assert.deepEqual([f.hashes,f.decodes],counts);assert.equal(f.accepts,1);
});
test('receipt conflicts propagate before any measurement',async t=>{
  const f=await fixture(t),{input}=await f.review(),conflict=Object.assign(new Error('different key content'),{code:'IDEMPOTENCY_CONFLICT'});
  f.transactions.prepare=()=>{throw conflict;};const counts=[f.hashes,f.decodes];
  await assert.rejects(f.apply(input),(error: unknown)=>error===conflict);assert.deepEqual([f.hashes,f.decodes],counts);assert.equal(f.accepts,0);
});
test('strict scalar input is validated before receipts or media; restoration precedes getters',async t=>{
  const f=await fixture(t),{input}=await f.review(),counts=[f.hashes,f.decodes];let getters=0;
  for(const extra of [{approved:true},{gains:[]},{checkedAt:'yesterday'},{path:'/private'}])await assert.rejects(f.apply({...input,...extra}),{code:'VALIDATION_ERROR'});
  await assert.rejects(f.apply({...input,get approved(){getters++;return true;}} as never),{code:'VALIDATION_ERROR'});
  f.ordinary=false;await assert.rejects(f.apply({get projectId(){getters++;return input.projectId;}} as never),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters,0);assert.equal(f.phase.length,0);assert.deepEqual([f.hashes,f.decodes],counts);
});
test('reviewed digest and snapshot mismatches cannot rebase to freshly calculated gains',async t=>{
  for(const field of ['candidateDigest','snapshotSha256'])await t.test(field,async t=>{
    const f=await fixture(t),{input}=await f.review();(input as Record<string, unknown>)[field]=field==='candidateDigest'?'timeline-loudness-candidate-v1:'+ 'f'.repeat(64):'f'.repeat(64);
    await assert.rejects(f.apply(input),{code:'TIMELINE_LOUDNESS_APPLY_STALE'});assert.equal(f.accepts,0);assert.equal(f.history.length,0);assert.equal(f.rejected,1);
  });
});
test('actual measured target and true peak both gate acceptance; no fallback target or clamp',async t=>{
  const f=await fixture(t),{input,report}=await f.review({...f.prepareInput,target:{integratedLufs:-20,truePeakCeilingDbtp:-20}});
  assert.equal(report.candidate.status,'measured');assert.equal(report.candidate.meetsTarget,true);assert.equal(report.candidate.meetsTruePeak,false);
  await assert.rejects(f.apply(input),{code:'TIMELINE_LOUDNESS_APPLY_UNSAFE'});assert.equal(f.accepts,0);
});
test('a mathematically unchanged candidate cannot append an edit',async t=>{
  const f=await fixture(t),first=await f.review();const {input,report}=await f.review({...f.prepareInput,target:{...f.prepareInput.target,integratedLufs:first.report.original.integratedLufs}});
  assert.equal(report.candidate.gainMultiplier,1);await assert.rejects(f.apply(input),{code:'TIMELINE_LOUDNESS_APPLY_UNCHANGED'});assert.equal(f.accepts,0);
});
test('private final fence checks owner, full graph and source identity synchronously and expires on return',async t=>{
  for(const change of ['owner','graph','source','cancel'])await t.test(change,async t=>{
    const f=await fixture(t),{input}=await f.review();f.transactions.accept=(input: InputView,admission: {finalFence(): void; application: {gains: GainView[]}})=>{
      if(change==='owner')f.owned=false;if(change==='graph')f.snapshot.assets[0].mimeType='audio/mpeg';
      if(change==='source')f.info.ino++;if(change==='cancel')f.owner.abort();admission.finalFence();throw new Error('Fence failed to stop');};
    await assert.rejects(f.apply(input),(error: unknown)=>['TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED','TIMELINE_MIX_LOUDNESS_STALE','OPERATION_CANCELLED'].includes(String((error as {code?: string}).code)));
    assert.equal(f.accepts,0);assert.equal(f.rejected,0);
  });
  const f=await fixture(t),{input}=await f.review(),accept=f.transactions.accept;let escaped: (() => void) | undefined;
  f.transactions.accept=(input: InputView,admission: {finalFence(): void; application: {gains: GainView[]}})=>{escaped=admission.finalFence;return accept(input,admission);};await f.apply(input);
  assert.throws(()=>{const fence=escaped;assert.ok(fence);return fence();},{code:'TIMELINE_MIX_LOUDNESS_STALE'});
});
test('child retirement is awaited before mutation, with no public DTO substitute for live fence',async t=>{
  const f=await fixture(t),{input,report}=await f.review(),retire=deferred<void>();let entered=false;
  f.runtime.terminate=async()=>{entered=true;await retire.promise;return [];};
  const result=f.apply(input);await tick();assert.equal(entered,true);assert.equal(f.accepts,0);assert.equal(Object.hasOwn(report,'finalFence'),false);
  retire.resolve();await result;assert.equal(f.accepts,1);
});
test('transport disconnect does not cancel accepted business work',async t=>{
  const f=await fixture(t),{input}=await f.review(),client=new AbortController();client.abort();
  const result=await f.apply(input,{signal:client.signal});assert.equal(result.timeline.revision,5);assert.equal(f.accepts,1);
});
test('post-write and unknown transaction errors retain identity and are never decoder-normalized or safely rejected',async t=>{
  const f=await fixture(t),{input}=await f.review(),uncertain=Object.assign(new Error('COMMIT uncertain'),{code:'SQLITE_IOERR'});
  f.transactions.accept=()=>{throw uncertain;};await assert.rejects(f.apply(input),(error: unknown)=>error===uncertain);
  assert.equal(f.rejected,0);assert.equal((uncertain as {details?: unknown}).details,undefined);
});
test('raced retained receipt is returned unchanged without a post-commit fence',async t=>{
  const f=await fixture(t),{input}=await f.review(),accept=f.transactions.accept;
  f.transactions.accept=(input: InputView,admission: {finalFence(): void; application: {gains: GainView[]}})=>{const response=accept(input,admission);f.snapshot.timeline.revision++;f.info.ino++;return response;};
  const response=await f.apply(input);assert.equal(response.timeline.revision,5);assert.equal(f.snapshot.timeline.revision,6);assert.equal(f.accepts,1);
});
test('unconfirmed child termination cannot reach apply or produce a not-applied proof',async t=>{
  const f=await fixture(t),{input}=await f.review();f.runtime.terminate=async()=>[{status:'unknown'}];f.runtime.waitForClose=async()=>[{status:'exited'}];
  await assert.rejects(f.apply(input),{code:'MEDIA_TERMINATION_UNCONFIRMED'});assert.equal(f.accepts,0);assert.equal(f.rejected,0);
});
test('accepted scalar intent is frozen independently of later caller changes',async t=>{
  const f=await fixture(t),{input}=await f.review(),retire=deferred<void>();let entered=false;
  f.runtime.terminate=async()=>{entered=true;await retire.promise;return [];};
  const expected=structuredClone(input),result=f.apply(input);await tick();assert.equal(entered,true);
  input.requestId=randomUUID();input.target.integratedLufs=-5;input.candidateDigest='timeline-loudness-candidate-v1:'+ 'f'.repeat(64);
  retire.resolve();const response=await result;assert.equal(response.requestId,expected.requestId);
  assert.deepEqual(response.application.target,expected.target);assert.equal(response.application.candidateDigest,expected.candidateDigest);
});
test('last source validation cannot revoke the owner scope unnoticed by the private final fence',async t=>{
  const f=await fixture(t),{input}=await f.review(),validate=f.runtime.validateSource;
  f.transactions.accept=(input,admission)=>{
    f.runtime.validateSource=(...args)=>{const value=validate(...args);f.owner.abort();return value;};
    admission.finalFence();throw new Error('Fence failed to stop');
  };
  await assert.rejects(f.apply(input),{code:'OPERATION_CANCELLED'});assert.equal(f.accepts,0);assert.equal(f.rejected,0);
});
