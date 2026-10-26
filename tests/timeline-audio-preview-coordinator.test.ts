import type {TypedServices, Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TestContext} from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AppError} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createSavedTimelineAudioReader, createTimelineAudioPreviewCoordinator} from '../packages/business/src/timeline-audio-preview-coordinator.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
interface ConsumeOptions {consume: (...args: unknown[]) => Promise<unknown>; onResourceSettlement(settlement: Promise<void>): void}
type Coordinator = ReturnType<typeof createTimelineAudioPreviewCoordinator>;
const context = {consume: async () => 'consumed'};
function lanes({source = async () => 'source', block = async () => 'block', sourceDrain = async () => {}, blockDrain = async () => {}}: {source?: (input: unknown, options: ConsumeOptions) => unknown; block?: (input: unknown, options: ConsumeOptions) => unknown; sourceDrain?: () => Promise<void>; blockDrain?: () => Promise<void>} = {}) {
  let continuousSession = false;
  const legacy = {handlers: {'timeline.audioPreview.plan': () => 'legacy plan'}, consumeSource: source, drain: sourceDrain};
  const continuous = {handlers: {'timeline.audioPreview.continuousPlan': () => 'continuous plan'}, consumeBlock: block,
    assertNoContinuousSession() {if (continuousSession) throw new AppError('AUDIO_PREVIEW_BUSY', 'busy', 429);},
    retireSession: async () => {continuousSession = false;}, retireSessionById: async () => {continuousSession = false;}, drain: blockDrain};
  return {legacy, continuous, audio: createTimelineAudioPreviewCoordinator(legacy as unknown as Parameters<typeof createTimelineAudioPreviewCoordinator>[0], continuous as unknown as Parameters<typeof createTimelineAudioPreviewCoordinator>[1], AppError),
    setContinuousSession(value: boolean) {continuousSession = value;}};
}

test('legacy observer completion keeps V2 busy until its exact registered resource settles', async () => {
  const resources = deferred(); let forwarded: Promise<void> | undefined, sourceInput: unknown, blockCalls = 0;
  const f = lanes({source: async (input, options) => {sourceInput = input; options.onResourceSettlement(resources.promise); return 37;},
    block: async (input, options) => {blockCalls++; assert.equal(input, sourceInput); assert.equal(options, context); return 42;}});
  const input = {};
  assert.equal(await f.audio.consumeSource(input, {...context, onResourceSettlement(value: Promise<void>) {forwarded = value;}}), 37);
  assert.equal(forwarded, resources.promise);
  assert.throws(() => f.audio.consumeBlock(input, context), error => error instanceof AppError && (error as Failure).code === 'AUDIO_PREVIEW_BUSY' && error.status === 429);
  assert.equal(blockCalls, 0);
  resources.resolve(); await resources.promise;
  assert.equal(await f.audio.consumeBlock(input, context), 42); assert.equal(blockCalls, 1);
});

test('rejected resource settlement releases only the shared quota and preserves lane failure policy', async () => {
  const resources = deferred(), failure = Object.assign(Error('unconfirmed'), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
  const f = lanes({source: async (_input, options) => {options.onResourceSettlement(resources.promise); return 'observed';}});
  assert.equal(await f.audio.consumeSource({}, context), 'observed');
  assert.throws(() => f.audio.consumeBlock({}, context), {code: 'AUDIO_PREVIEW_BUSY', status: 429});
  resources.reject(failure); await assert.rejects(resources.promise, error => error === failure);
  assert.equal(await f.audio.consumeBlock({}, context), 'block');
});

test('synchronous and asynchronous pre-registration failures, and unregistered success, release admission', async () => {
  const failure = Error('before registration');
  for (const [source, succeeds] of [[() => {throw failure;}, false], [async () => {throw failure;}, false], [async () => 'early result', true]] as const) {
    const f = lanes({source}), pending = f.audio.consumeSource({}, context);
    if (succeeds) assert.equal(await pending, 'early result');
    else await assert.rejects(pending, error => error === failure);
    assert.equal(await f.audio.consumeBlock({}, context), 'block');
  }
});

test('registration callback failure retains quota through cleanup without leaking admission', async () => {
  const first = deferred(), second = deferred(), failure = Error('registration callback'); let calls = 0;
  const f = lanes({source: async (_input, options) => {
    options.onResourceSettlement((++calls === 1 ? first : second).promise); return calls;
  }});
  await assert.rejects(f.audio.consumeSource({}, {...context, onResourceSettlement() {throw failure;}}), error => error === failure);
  assert.throws(() => f.audio.consumeBlock({}, context), {code: 'AUDIO_PREVIEW_BUSY'});
  first.resolve(); await first.promise;
  assert.equal(await f.audio.consumeSource({}, context), 2);
  assert.throws(() => f.audio.consumeBlock({}, context), {code: 'AUDIO_PREVIEW_BUSY'});
  second.resolve(); await second.promise;
  assert.equal(await f.audio.consumeBlock({}, context), 'block');
});

test('continuous sessions reject V1 before its lane starts and retirement preserves the public surface', async () => {
  let sourceCalls = 0;
  const f = lanes({source: async () => {sourceCalls++; return 'source';}});
  assert.equal(f.audio.handlers['timeline.audioPreview.plan'], f.legacy.handlers['timeline.audioPreview.plan']);
  assert.equal(f.audio.handlers['timeline.audioPreview.continuousPlan'], f.continuous.handlers['timeline.audioPreview.continuousPlan']);
  assert.equal(f.audio.retireSession, f.continuous.retireSession);
  assert.equal(f.audio.retireSessionById, f.continuous.retireSessionById);
  f.setContinuousSession(true);
  await assert.rejects(f.audio.consumeSource({}, context), {code: 'AUDIO_PREVIEW_BUSY', status: 429});
  assert.equal(sourceCalls, 0);
  await (f.audio.retireSessionById as unknown as (id: string) => Promise<void>)('session');
  assert.equal(await f.audio.consumeSource({}, context), 'source'); assert.equal(sourceCalls, 1);
});

test('drain starts both lane shutdowns and waits for both to finish', async () => {
  const legacy = deferred(), continuous = deferred(), entered: string[] = [];
  const f = lanes({sourceDrain: async () => {entered.push('legacy'); await legacy.promise;},
    blockDrain: async () => {entered.push('continuous'); await continuous.promise;}});
  let drained = false;
  const pending = f.audio.drain().then(() => {drained = true;});
  assert.deepEqual(entered, ['legacy', 'continuous']);
  legacy.resolve(); await tick(); assert.equal(drained, false);
  continuous.resolve(); await pending; assert.equal(drained, true);
});

function readerFixture({outer = false, failAt, empty = false}: {outer?: boolean; failAt?: string; empty?: boolean} = {}) {
  const calls: string[] = [], failure = Error('saved snapshot failure'), timeline = {id: 'saved-timeline'}, asset = {id: 'saved-asset'};
  const db = {isTransaction: outer, exec(sql: string) {calls.push(sql); this.isTransaction = sql === 'BEGIN DEFERRED';}};
  const read = createSavedTimelineAudioReader({db,
    readTimeline(projectId) {assert.equal(projectId, 'project'); assert.equal(db.isTransaction, true); calls.push('timeline');
      if (failAt === 'timeline') throw failure; return empty ? null : timeline;},
    readAssets(projectId, saved) {assert.equal(projectId, 'project'); assert.equal(saved, timeline); assert.equal(db.isTransaction, true);
      calls.push('assets'); if (failAt === 'assets') throw failure; return new Map([[asset.id, asset]]);},
    validate(saved, assets) {assert.equal(saved, timeline); assert.equal(assets.get(asset.id), asset); assert.equal(db.isTransaction, true);
      calls.push('validate'); if (failAt === 'validate') throw failure;},
  });
  return {db, calls, read, failure, timeline, asset};
}

test('shared reader owns one deferred transaction for the full saved graph and preserves an outer transaction', () => {
  for (const outer of [false, true]) {
    const f = readerFixture({outer}), result = f.read('project');
    assert.equal(result!.timeline, f.timeline); assert.equal(result!.assets[0], f.asset);
    assert.deepEqual(f.calls, outer ? ['timeline', 'assets', 'validate'] : ['BEGIN DEFERRED', 'timeline', 'assets', 'validate', 'COMMIT']);
    assert.equal(f.db.isTransaction, outer);
  }
});

test('empty and thrown snapshot reads keep the original commit-on-error and outer transaction policy', () => {
  for (const outer of [false, true]) {
    const empty = readerFixture({outer, empty: true});
    assert.equal(empty.read('project'), null);
    assert.deepEqual(empty.calls, outer ? ['timeline'] : ['BEGIN DEFERRED', 'timeline', 'COMMIT']);
    assert.equal(empty.db.isTransaction, outer);
    for (const failAt of ['timeline', 'assets', 'validate']) {
      const f = readerFixture({outer, failAt});
      assert.throws(() => f.read('project'), error => error === f.failure);
      const work = ['timeline', 'assets', 'validate'].slice(0, ['timeline', 'assets', 'validate'].indexOf(failAt) + 1);
      assert.deepEqual(f.calls, outer ? work : ['BEGIN DEFERRED', ...work, 'COMMIT']);
      assert.equal(f.db.isTransaction, outer);
    }
  }
});

test('real V1 and V2 services share saved graph reads, reject corrupt and missing timelines without writes', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-audio-coordinator-')));
  let store: ReturnType<typeof openStore> | undefined, services: TypedServices | undefined;
  t.after(async () => {try {await services?.drain();} finally {store?.close(); await rm(root, {recursive: true, force: true});}});
  store = openStore(root); services = (createServices(store, new Map()) as TypedServices);
  const project = await services.call('project.create', {name: 'shared saved audio'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const bytes = Buffer.alloc(4096, 7), assetId = randomUUID();
  const asset = {id: assetId, projectId: project.id, name: 'saved.wav', mimeType: 'audio/wav', relativePath: `media/${assetId}.wav`,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, duration: 60, hasAudio: true, hasVideo: false,
    width: 0, height: 0, url: `/media/${assetId}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio')!.id, assetId, startFrame: 0, sourceInFrame: 0, durationFrames: 750, gain: 1});
  const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, startFrame: 0};
  const operations = ['timeline.audioPreview.plan', 'timeline.audioPreview.continuousPlan'];
  const trace: string[] = [], exec = store.db.exec.bind(store.db), prepare = store.db.prepare.bind(store.db);
  store.db.exec = sql => {trace.push(sql); return exec(sql);};
  store.db.prepare = sql => {if (store.db.isTransaction) trace.push(sql); return prepare(sql);};
  const totalChanges = () => prepare('SELECT total_changes() AS n').get()!.n;
  const inspectBoth = async (expectedCode?: string) => {
    const traces: string[][] = [], before = totalChanges();
    for (const operation of operations) {
      trace.length = 0;
      if (expectedCode) await assert.rejects(services!.call(operation, input), {code: expectedCode});
      else {
        const plan: unknown = await services!.call(operation, input);
        assert.equal((plan as {timelineId: string}).timelineId, timeline.id); assert.equal((plan as {timelineRevision: number}).timelineRevision, timeline.revision);
      }
      assert.equal(store.db.isTransaction, false); traces.push([...trace]);
    }
    assert.deepEqual(traces[0], traces[1]);
    assert.equal(traces[0][0], 'BEGIN DEFERRED'); assert.equal(traces[0]!.at(-1), 'COMMIT');
    assert.equal(totalChanges(), before);
  };
  await inspectBoth();
  prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify({...timeline,
    clips: timeline.clips.map(clip => ({...clip, speed: 2}))}), timeline.id);
  await inspectBoth('AUDIO_PREVIEW_UNAVAILABLE');
  prepare('DELETE FROM timelines WHERE id=?').run(timeline.id);
  await inspectBoth('AUDIO_PREVIEW_UNAVAILABLE');
});
