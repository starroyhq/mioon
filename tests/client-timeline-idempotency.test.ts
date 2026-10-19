import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import {prepareSubmission,readPending,clearPending,pendingForProject,reconcilePending} from '../apps/web/src/submissions.ts';
import type {PendingEntry} from '../apps/web/src/submissions.ts';
type RenderInput = {projectId: string; requestId: string; expectedRevision: number; purpose: string};
type TimelineRequest = PendingEntry & {input: RenderInput};
class SessionStore{
 values=new Map<string,string>();get length(){return this.values.size;}key(n: number): string|null{return [...this.values.keys()][n]??null;}getItem(k: string): string|null{return this.values.get(k)??null;}setItem(k: string,v: unknown){this.values.set(k,String(v));}removeItem(k: string){this.values.delete(k);}
}
function fixture(t: TestContext){const prior=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const storage=new SessionStore();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});t.after(()=>{if(prior)Object.defineProperty(globalThis,'sessionStorage',prior);else delete (globalThis as {sessionStorage?: unknown}).sessionStorage;});return storage;}
const request=(operation: string='timeline.clip.update',key: string='timeline:mutation'): TimelineRequest=>({projectId:'project-v2',key,operation,createdAt:'2026-10-09T10:00:00.000Z',input:{projectId:'project-v2',expectedRevision:7,requestId:'timeline-original-request',clipId:'clip-original',patch:{trackId:'track-two',startFrame:47,durationFrames:82,sourceInFrame:11,rect:{x:100,y:200,width:300,height:400},gain:0.5}}} as unknown as TimelineRequest);
test('timeline mutations retain exact frame, rect, revision and request identity across a lost response',(t: TestContext)=>{fixture(t);const original=request();prepareSubmission(original);const replacement=request('timeline.track.add');replacement.input={...replacement.input,expectedRevision:8,requestId:'must-never-replace'};assert.deepEqual(prepareSubmission(replacement),original);assert.deepEqual(readPending('project-v2','timeline:mutation'),original);});
test('fetching a newer timeline cannot prove an uncertain mutation succeeded; only explicit replay clears it',(t: TestContext)=>{fixture(t);const original=request();prepareSubmission(original);reconcilePending('project-v2',{timeline:{revision:99,clips:[]},jobs:[],exports:[]});assert.deepEqual(pendingForProject('project-v2'),[original]);clearPending('project-v2','timeline:mutation');assert.equal(pendingForProject('project-v2').length,0);});
test('all supported timeline mutation operations and render accept durable recovery records',(t: TestContext)=>{fixture(t);for(const [i,op] of ['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.clip.replaceSource','timeline.seed','timeline.render','timeline.undo','timeline.redo'].entries()){const entry=request(op,`timeline:${i}`);(entry.input as {requestId: string}).requestId+=i;assert.deepEqual(prepareSubmission(entry),entry);}assert.equal(pendingForProject('project-v2').length,12);});
const id = (value: number): string => `81000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function renderRecord(input: RenderInput, status: string = 'queued') {
  const timeline = { id: id(2), projectId: input.projectId, revision: input.expectedRevision, fps: 30, width: 720, height: 1280,
    durationFrames: 30, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
    tracks: [{ id: id(3), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
    clips: [{ id: id(4), trackId: id(3), assetId: id(5), name: 'Clip', startFrame: 0, durationFrames: 30, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } }] };
  return { id: id(6), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose, timelineRevision: input.expectedRevision,
    snapshot: { timeline, assets: [{ id: id(5), sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 5, width: 720, height: 1280, hasAudio: true }] },
    status, assetId: status === 'succeeded' ? id(7) : null, url: status === 'succeeded' ? `/media/${id(7)}` : null,
    error: status === 'failed' ? { code: 'RENDER_FAILED', message: 'Synthetic failure', retryable: false } : null,
    createdAt: timeline.createdAt, updatedAt: timeline.updatedAt };
}

test('preview and export recovery identities stay separate and public render records never release either key', (t: TestContext) => {
  fixture(t); const projectId = id(1);
  const preview = { ...request('timeline.render', 'timeline:render:preview'), projectId, input: { projectId, expectedRevision: 7, requestId: 'preview-original', purpose: 'preview' } };
  const exported = { ...preview, key: 'timeline:render:export', input: { ...preview.input, requestId: 'export-original', purpose: 'export' } };
  prepareSubmission(preview); prepareSubmission(exported);
  const valid = renderRecord(preview.input, 'succeeded');
  const invalid = [{ requestId: preview.input.requestId }, { ...valid, mode: 'sequence' }, { ...valid, projectId: id(99) },
    { ...valid, purpose: 'export' }, { ...valid, timelineRevision: 8 }, { ...valid, snapshot: {} },
    { ...valid, requestId: 'different-request' }, { ...valid, assetId: id(99) }];
  for (const value of invalid) {
    reconcilePending(projectId, { exports: [value], jobs: [{ requestId: preview.input.requestId }] });
    assert.deepEqual(readPending(projectId, preview.key), preview);
    assert.deepEqual(readPending(projectId, exported.key), exported);
  }
  reconcilePending(projectId, { exports: [valid] });
  assert.equal(isTimelineRenderRecord(valid, preview.input), true);
  assert.deepEqual(readPending(projectId, preview.key), preview);
  assert.deepEqual(readPending(projectId, exported.key), exported);
  reconcilePending(projectId, { exports: [renderRecord(exported.input, 'failed')] });
  assert.deepEqual(readPending(projectId, exported.key), exported);
});

test('every valid public render lifecycle record preserves the original receipt after same-session reload', (t: TestContext) => {
  fixture(t); const projectId = id(1);
  const statuses: string[] = ['queued', 'running', 'succeeded', 'failed'];
  for (const status of statuses) {
    const entry = { ...request('timeline.render', 'timeline:render:export'), projectId, input: { projectId, expectedRevision: 7, requestId: `original-${status}`, purpose: 'export' } };
    prepareSubmission(entry);
    assert.deepEqual(pendingForProject(projectId, { strict: true }), [entry]);
    const record = renderRecord(entry.input, status);
    assert.equal(isTimelineRenderRecord(record, entry.input), true, status);
    reconcilePending(projectId, { exports: [record] });
    assert.deepEqual(readPending(projectId, entry.key), entry, status);
    clearPending(projectId, entry.key);
  }
});

test('digest-bound render receipts require exact replay because public records cannot prove their private-path digest', t => {
  fixture(t); const projectId = id(1);
  const entry = { ...request('timeline.render', 'timeline:render:export'), projectId,
    input: { projectId, expectedRevision: 7, requestId: 'digest-bound-original', purpose: 'export', preflightSnapshotHash: 'b'.repeat(64) } };
  prepareSubmission(entry);
  for (const status of ['queued', 'running', 'succeeded', 'failed']) {
    reconcilePending(projectId, { exports: [renderRecord(entry.input, status)] });
    assert.deepEqual(readPending(projectId, entry.key), entry, status);
  }
  assert.deepEqual(prepareSubmission({ ...entry, input: { ...entry.input, preflightSnapshotHash: 'c'.repeat(64), requestId: 'must-not-replace' } }), entry);
});

test('undo and redo replay the exact original request even after a changed history cursor', t => {
  fixture(t);
  for (const operation of ['timeline.undo', 'timeline.redo']) {
    const original = { projectId: 'project-v2', key: 'timeline:mutation', operation, createdAt: '2026-10-09T10:00:00.000Z', input: { projectId: 'project-v2', expectedRevision: 7, requestId: `${operation}-original` } };
    prepareSubmission(original);
    reconcilePending('project-v2', { timeline: { revision: 8 }, timelineHistory: { cursor: 0, length: 3 } });
    assert.deepEqual(prepareSubmission({ ...original, operation: 'timeline.clip.add', input: { ...original.input, expectedRevision: 8, requestId: 'must-not-replace' } }), original);
    assert.deepEqual(readPending('project-v2', 'timeline:mutation'), original);
    clearPending('project-v2', 'timeline:mutation');
  }
});

test('read-only history requests are never accepted as durable mutations', t => {
  fixture(t);
  assert.throws(() => prepareSubmission(request('timeline.history.get')), /记录损坏/);
});


test('lost replacement keeps the exact fixed source and optional version despite newer state or matching unrelated receipts', t => {
  fixture(t);
  for (const provenance of [{}, {versionId: 'chosen-version'}]) {
    const original = {projectId: 'project-v2', key: 'timeline:mutation', operation: 'timeline.clip.replaceSource', createdAt: '2026-10-10T00:00:00.000Z', input: {projectId: 'project-v2', expectedRevision: 7, requestId: 'original-replacement', clipId: 'fixed-clip', assetId: 'chosen-asset', ...provenance}};
    assert.deepEqual(prepareSubmission(original), original);
    reconcilePending('project-v2', {timeline: {revision: 99, clips: [{id: 'fixed-clip', assetId: 'chosen-asset'}]}, jobs: [{requestId: original.input.requestId}], exports: [{requestId: original.input.requestId}]});
    const changed = {...original, input: {...original.input, expectedRevision: 99, requestId: 'must-not-rekey', clipId: 'other-clip', assetId: 'other-asset', versionId: 'current-selected-version'}};
    assert.deepEqual(prepareSubmission(changed), original);
    assert.deepEqual(readPending('project-v2', 'timeline:mutation'), original);
    assert.deepEqual(pendingForProject('project-v2', {strict: true}), [original]);
    assert.equal(Object.hasOwn(readPending('project-v2', 'timeline:mutation')!.input, 'versionId'), Object.hasOwn(provenance, 'versionId'));
    clearPending('project-v2', 'timeline:mutation');
  }
});

test('replacement cannot dispatch without a persisted exact recovery receipt', t => {
  const storage = fixture(t);
  const original = {projectId: 'project-v2', key: 'timeline:mutation', operation: 'timeline.clip.replaceSource', input: {projectId: 'project-v2', expectedRevision: 7, requestId: 'original-replacement', clipId: 'fixed-clip', assetId: 'chosen-asset'}};
  let sent = 0;
  storage.setItem = () => { throw Error('QuotaExceededError'); };
  assert.throws(() => { prepareSubmission(original); sent++; }, /无法保存请求恢复记录/);
  storage.setItem = () => {};
  assert.throws(() => { prepareSubmission(original); sent++; }, /未能保存/);
  assert.equal(sent, 0);
});
