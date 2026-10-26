import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {MediaShot} from './helpers/strict-service-responses.ts';
import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import type {SQLInputValue} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore, type WorkspaceStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {parse, schemas, descriptions} from '../packages/contracts/src/index.ts';
import type { SQLOutputValue } from 'node:sqlite';

// Synthetic metadata keeps split correctness independent of FFmpeg and providers.
// Independent workers below use the same disposable SQLite file, not one JS queue.
const operation = 'timeline.clip.split';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const editable = (timeline: FixtureTimeline) => clone({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const unrelatedTables = (['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports'] as const);
const request = <P extends Record<string,unknown>=Record<never,never>>(projectId: string, timeline: FixtureTimeline, fields: P = {} as P):P & {projectId:string;expectedRevision:number;requestId:string} => ({projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...fields});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-timeline-split-'));
  let store = (openStore(root) as FixtureStore), services = (createServices(store, new Map()) as FixtureServices);
  const _strictFixtureBase = {
    root,
    get store() { return store; },
    call: <O extends string>(name: O, input?: unknown) => services.call(name, input) as Promise<FixtureServiceResult<O>>,
    restart() { store.close(); store = (openStore(root) as FixtureStore); services = (createServices(store, new Map()) as FixtureServices); },
    asset(projectId?: string, mimeType: string|undefined = 'image/png', extra: {duration?: number;} = {}) {
      const id = randomUUID();
      return store.put('assets', {
        id, projectId, name: `Synthetic ${mimeType}`, mimeType, duration: mimeType.startsWith('image/') ? 0 : 8,
        width: 720, height: 1280, sha256: 'a'.repeat(64), sizeBytes: 128,
        relativePath: `media/${id}.fixture`, url: `/media/${id}`, createdAt: '2026-10-09T00:00:00.000Z', ...extra,
      });
    },
    version(shot: MediaShot, asset: { id: unknown; projectId?: unknown; name?: string; mimeType?: string; duration?: number; width?: number; height?: number; sha256: unknown; sizeBytes?: number; relativePath?: string; url: unknown; createdAt?: string; }, number: number) {
      const jobId = randomUUID(), id = randomUUID();
      store.put('jobs', {id: jobId, projectId: shot.projectId, shotId: shot.id, status: 'succeeded', providerId: 'mock', requestId: randomUUID(), submissionCount: 1, versionId: id});
      return store.put('versions', {id, projectId: shot.projectId, shotId: shot.id, jobId, number, providerId: 'mock', assetId: asset.id, sha256: asset.sha256, url: asset.url});
    },
    outside() { return Object.fromEntries(unrelatedTables.map(table => [table, clone(store.list(table))])); },
    state() {
      return Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    },
  };
 const f = _strictFixtureBase as typeof _strictFixtureBase & {projectId: string};
  f.projectId = (await f.call('project.create', {name: t.name})).id;
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  return f;
}

async function singleClip(f: Awaited<ReturnType<typeof fixture>>, fields: {startFrame?: number; durationFrames?: number; sourceInFrame?: number;} = {}, mimeType: string|undefined = 'image/png') {
  const projectId = f.projectId, asset = f.asset(projectId, mimeType);
  const empty = await f.call('timeline.get', {projectId});
  const trackId = (empty.tracks.find((track) => track.kind === (mimeType.startsWith('audio/') ? 'audio' : 'video')))!.id;
  const timeline = await f.call('timeline.clip.add', request(projectId, empty, {trackId, assetId: asset.id, startFrame: 10, durationFrames: 40, ...fields}));
  return {timeline, clip: timeline.clips[0], asset};
}

async function rejectAtomic(f: Awaited<ReturnType<typeof fixture>>, params: { [k: string]: unknown; }|{ requestId: string|number|null; projectId: unknown; expectedRevision: unknown; }, code: string, name: string|undefined = operation) {
  const before = f.state(), outside = f.outside();
  await assert.rejects(f.call(name, params), error => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code === code, `${name} should reject with ${code}`);
  assert.deepEqual(f.state(), before, 'rejection must preserve timeline bytes, history, redo branch, cursor and saved responses');
  assert.deepEqual(f.outside(), outside, 'rejection cannot alter media, projects, shots, jobs, versions or exports');
}

function assertSplit(before: FixtureTimeline, after: FixtureTimeline, clipId: string, atFrame: number, image: boolean|undefined = false) {
  const original = before.clips.find((clip) => clip.id === clipId);
  const leftDuration = atFrame - (original)!.startFrame;
  const left = after.clips.find((clip) => clip.id === clipId);
  const added = after.clips.filter((clip) => !before.clips.some((previous) => previous.id === clip.id));
  assert.equal(after.clips.length, before.clips.length + 1);
  assert.equal(added.length, 1, 'split creates exactly one new clip identity');
  const right = added[0];
  assert.match(right.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(right.id, (original)!.id);
  assert.deepEqual(left, {...original, durationFrames: leftDuration});
  assert.deepEqual(right, {...original, id: right.id, startFrame: atFrame, durationFrames: (original)!.durationFrames - leftDuration, sourceInFrame: image ? 0 : (original)!.sourceInFrame + leftDuration});
  assert.equal(left.startFrame + left.durationFrames, right.startFrame);
  assert.equal(right.startFrame + right.durationFrames, (original)!.startFrame + (original)!.durationFrames);
  assert.deepEqual(after.clips.filter((clip) => clip.id !== left.id && clip.id !== right.id), before.clips.filter((clip) => clip.id !== (original)!.id), 'neighbors never ripple or change');
  assert.deepEqual(after.tracks, before.tracks, 'track state, including mute and visibility, is unchanged');
  assert.equal(after.durationFrames, before.durationFrames);
  assert.equal(after.revision, before.revision + 1);
  for (const field of (['id', 'projectId', 'fps', 'width', 'height', 'createdAt'] as const)) assert.equal(after[field], before[field]);
  return {left, right};
}

for (const mimeType of (['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'] as const)) {
  test(`split preserves ${mimeType} trim, properties, muted track, adjacent neighbors and timeline length`, async t => {
    const f = await fixture(t), projectId = f.projectId, asset = f.asset(projectId, mimeType);
    let timeline = await f.call('timeline.get', {projectId});
    const lane = timeline.tracks.find((track) => track.kind === (mimeType.startsWith('audio/') ? 'audio' : 'video'));
    timeline = await f.call('timeline.track.update', request(projectId, timeline, {trackId: (lane)!.id, patch: {name: 'Preserved lane', muted: true, ...((lane)!.kind === 'video' ? {hidden: true} : {})}}));
    const add = async (fields?: {}|undefined) => {
      timeline = await f.call('timeline.clip.add', request(projectId, timeline, {trackId: (lane)!.id, assetId: asset.id, startFrame: 0, durationFrames: 100, ...fields}));
      return timeline.clips.at(-1);
    };
    await add({name: 'Touching left'});
    const original = await add({name: 'Trimmed source', startFrame: 100, durationFrames: 90, sourceInFrame: mimeType.startsWith('image/') ? 0 : 17, rect: {x: 100, y: 200, width: 400, height: 600}, gain: 0.35});
    await add({name: 'Touching right', startFrame: 190, durationFrames: 30});
    const overlay = f.asset(projectId);
    const anotherLane = timeline.tracks.find((track) => track.kind === 'video' && track.id !== (lane)!.id);
    await add({trackId: (anotherLane)!.id, assetId: overlay.id, name: 'Other-track overlap and longer tail', startFrame: 80, durationFrames: 220});
    const before = clone(timeline), outside = f.outside();
    const history = await f.call('timeline.history.get', {projectId});
    timeline = await f.call(operation, request(projectId, timeline, {clipId: (original)!.id, atFrame: 131}));
    assertSplit(before, timeline, (original)!.id, 131, mimeType.startsWith('image/'));
    assert.deepEqual(f.outside(), outside, 'splitting only changes timeline edit state');
    const afterHistory = await f.call('timeline.history.get', {projectId});
    assert.equal(afterHistory.cursor, history.cursor + 1);
    assert.equal(afterHistory.length, history.length + 1);
    assert.equal((afterHistory.undoEntry)!.operation, operation);
    const entry = f.store.db.prepare('SELECT * FROM timeline_history WHERE id=?').get((afterHistory.undoEntry)!.id);
    assert.deepEqual(JSON.parse((((entry)!.beforeSnapshot) as unknown as Parameters<typeof JSON.parse>[0])), editable(before));
    assert.deepEqual(JSON.parse((((entry)!.afterSnapshot) as unknown as Parameters<typeof JSON.parse>[0])), editable(timeline));
    f.restart();
    assert.deepEqual(await f.call('timeline.get', {projectId}), timeline);
  });
}

test('split accepts one-frame halves and the final interior frame of a full-length timeline', async t => {
  for (const [startFrame, durationFrames, atFrame] of ([[0, 2, 1], [0, 18000, 1], [0, 18000, 17999], [17998, 2, 17999]] as const)) {
    await t.test(`${startFrame}+${durationFrames} at ${atFrame}`, async t => {
      const f = await fixture(t), {timeline, clip} = await singleClip(f, {startFrame, durationFrames});
      const result = await f.call(operation, request(f.projectId, timeline, {clipId: clip.id, atFrame}));
      assertSplit(timeline, result, clip.id, atFrame, true);
      assert.ok(result.clips.every((item) => item.durationFrames >= 1));
    });
  }
});

test('split uses absolute timeline frames and rejects both endpoints, outside positions and one-frame clips atomically', async t => {
  const f = await fixture(t), {timeline, clip} = await singleClip(f, {startFrame: 100, durationFrames: 40});
  for (const atFrame of ([0, 20, 99, 100, 140, 141, 18000] as const)) {
    await rejectAtomic(f, request(f.projectId, timeline, {clipId: clip.id, atFrame}), 'SPLIT_BOUNDS');
  }
  const params = request(f.projectId, timeline, {clipId: clip.id, atFrame: 100});
  await rejectAtomic(f, params, 'SPLIT_BOUNDS');
  const split = await f.call(operation, {...params, atFrame: 101});
  const {left} = assertSplit(timeline, split, clip.id, 101, true);
  for (const atFrame of ([99, 100, 101, 102] as const)) await rejectAtomic(f, request(f.projectId, split, {clipId: left.id, atFrame}), 'SPLIT_BOUNDS');
});

test('split has an exact strict schema with integer absolute-frame bounds and no caller-selected IDs or source fields', async t => {
  const f = await fixture(t), {timeline, clip} = await singleClip(f);
  const valid = request(f.projectId, timeline, {clipId: clip.id, atFrame: 20});
  assert.ok(schemas[operation], 'operation is part of the shared contract');
  assert.ok(descriptions[operation], 'operation has a discoverable description');
  assert.deepEqual(parse(operation, valid), valid);
  const invalid = [
    ...Object.keys(valid).map(key => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))),
    ...[-1, 18001, 1.5, '20', null, true, Infinity, NaN].map(atFrame => ({...valid, atFrame})),
    ...[0, -1, 1.5, '2', null].map(expectedRevision => ({...valid, expectedRevision})),
    ...['', 'short', 'x'.repeat(201), 12345678, null].map(requestId => ({...valid, requestId})),
    ...['projectId', 'clipId'].flatMap(field => ['', 'invalid-uuid', null, 1].map(value => ({...valid, [field]: value}))),
    ...[{frame: 20}, {newClipId: randomUUID()}, {rightClipId: randomUUID()}, {assetId: randomUUID()}, {sourceInFrame: 0}, {patch: {}}, {ripple: true}].map(fields => ({...valid, ...fields})),
  ];
  for (const params of invalid) await rejectAtomic(f, params, 'VALIDATION_ERROR');
  for (const atFrame of ([0, 18000] as const)) assert.equal(parse(operation, {...valid, atFrame}).atFrame, atFrame, 'schema endpoints are accepted and checked against the clip by the service');
});

test('split cannot find missing or foreign clips and cannot initialize state on a failed request', async t => {
  const f = await fixture(t), {timeline, clip} = await singleClip(f);
  await rejectAtomic(f, request(f.projectId, timeline, {clipId: randomUUID(), atFrame: 20}), 'CLIP_NOT_FOUND');
  const otherProject = await f.call('project.create', {name: 'Untouched foreign project'});
  await rejectAtomic(f, {projectId: otherProject.id, expectedRevision: 1, requestId: randomUUID(), clipId: clip.id, atFrame: 20}, 'CLIP_NOT_FOUND');
  assert.equal(f.store.db.prepare('SELECT * FROM timelines WHERE projectId=?').get(otherProject.id), undefined);
  await rejectAtomic(f, {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), clipId: clip.id, atFrame: 20}, 'NOT_FOUND');
  const foreign = await f.call('timeline.get', {projectId: otherProject.id});
  const untouched = clone(f.state());
  await f.call(operation, request(f.projectId, timeline, {clipId: clip.id, atFrame: 20}));
  assert.deepEqual(await f.call('timeline.get', {projectId: otherProject.id}), foreign);
  assert.deepEqual(f.state().timeline_history.filter(row => row.projectId === otherProject.id), untouched.timeline_history.filter(((row) => row.projectId === otherProject.id)));
  assert.deepEqual(f.state().timeline_history_cursors.filter(row => row.projectId === otherProject.id), untouched.timeline_history_cursors.filter(((row) => row.projectId === otherProject.id)));
});

test('split allows clip 99 to become 100, then rejects clip 101 without losing a pending redo branch', async t => {
  const f = await fixture(t), projectId = f.projectId, asset = f.asset(projectId);
  let timeline = await f.call('timeline.get', {projectId});
  for (let index = 0; index < 99; index++) timeline = await f.call('timeline.clip.add', request(projectId, timeline, {trackId: timeline.tracks[0].id, assetId: asset.id, startFrame: index * 4, durationFrames: 4}));
  const target = timeline.clips[0], before = clone(timeline);
  timeline = await f.call(operation, request(projectId, timeline, {clipId: target.id, atFrame: 2}));
  assertSplit(before, timeline, target.id, 2, true);
  assert.equal(timeline.clips.length, 100);
  timeline = await f.call('timeline.track.update', request(projectId, timeline, {trackId: timeline.tracks[0].id, patch: {name: 'Pending redo'}}));
  timeline = await f.call('timeline.undo', request(projectId, timeline));
  assert.equal((await f.call('timeline.history.get', {projectId})).canRedo, true);
  const params = request(projectId, timeline, {clipId: target.id, atFrame: 1});
  await rejectAtomic(f, params, 'TIMELINE_LIMIT');
  assert.equal((await f.call('timeline.history.get', {projectId})).canRedo, true);
  f.restart();
  await rejectAtomic(f, params, 'TIMELINE_LIMIT');
});

test('split retains seeded frozen assets after selection changes and leaves prior render snapshots untouched', async t => {
  const f = await fixture(t), projectId = f.projectId;
  const original = f.asset(projectId, 'video/mp4', {duration: 4}), replacement = f.asset(projectId, 'video/mp4', {duration: 1});
  const shot = await f.call('shot.create', {projectId, title: 'Frozen selected source'});
  const first = f.version(shot, original, 1), second = f.version(shot, replacement, 2);
  const selected = await f.call('version.select', {shotId: shot.id, versionId: first.id, expectedRevision: shot.revision});
  let timeline = await f.call('timeline.get', {projectId});
  timeline = await f.call('timeline.seed', request(projectId, timeline));
  const clipId = timeline.clips[0].id;
  timeline = await f.call('timeline.clip.update', request(projectId, timeline, {clipId, patch: {startFrame: 70, sourceInFrame: 11, durationFrames: 100, gain: 0, name: 'Frozen trim', rect: {x: 2, y: 4, width: 500, height: 1000}}}));
  const previewInput = request(projectId, timeline, {purpose: 'preview'});
  const preview = await f.call('timeline.render', previewInput);
  await f.call('version.select', {shotId: shot.id, versionId: second.id, expectedRevision: selected.revision});
  const outside = f.outside(), before = clone(timeline);
  timeline = await f.call(operation, request(projectId, timeline, {clipId, atFrame: 120}));
  const {left, right} = assertSplit(before, timeline, clipId, 120);
  assert.equal(left.assetId, original.id); assert.equal(right.assetId, original.id);
  assert.equal(right.sourceInFrame, 61);
  assert.deepEqual(f.outside(), outside);
  assert.deepEqual(await f.call('timeline.render', previewInput), preview);
  assert.deepEqual((f.store.get('exports', preview.id)! as FixtureExport).snapshot.timeline, before);
  f.restart();
  timeline = await f.call('timeline.undo', request(projectId, timeline));
  assert.deepEqual(editable(timeline), editable(before));
  timeline = await f.call('timeline.redo', request(projectId, timeline));
  assert.equal((timeline.clips.find((item) => item.id === right.id))!.assetId, original.id);
  assert.deepEqual(f.outside(), outside);
});

test('split replays its exact durable response after later edits, clip removal and restart; changed request contents conflict', async t => {
  const f = await fixture(t), projectId = f.projectId, {timeline: initial, clip} = await singleClip(f);
  const params = request(projectId, initial, {clipId: clip.id, atFrame: 25});
  const response = await f.call(operation, params);
  const {right} = assertSplit(initial, response, clip.id, 25, true);
  for (let index = 0; index < 20; index++) assert.deepEqual(await f.call(operation, params), response);
  let latest = await f.call('timeline.clip.update', request(projectId, response, {clipId: right.id, patch: {gain: 2, name: 'Changed right'}}));
  latest = await f.call('timeline.clip.remove', request(projectId, latest, {clipId: clip.id}));
  const before = f.state();
  for (const fields of ([{atFrame: 26}, {clipId: right.id}, {expectedRevision: latest.revision}] as const)) await rejectAtomic(f, {...params, ...fields}, 'IDEMPOTENCY_CONFLICT');
  await rejectAtomic(f, {projectId, expectedRevision: params.expectedRevision, requestId: params.requestId, clipId: right.id}, 'IDEMPOTENCY_CONFLICT', 'timeline.clip.remove');
  await rejectAtomic(f, {...params, requestId: randomUUID()}, 'REVISION_CONFLICT');
  assert.deepEqual(await f.call(operation, params), response, 'replay comes before stale revision, clip existence and new bounds');
  assert.deepEqual(f.state(), before);
  const foreign = await f.call('project.create', {name: 'Request IDs are global'});
  await rejectAtomic(f, {...params, projectId: foreign.id, expectedRevision: 1}, 'IDEMPOTENCY_CONFLICT');
  f.restart();
  assert.deepEqual(await f.call(operation, params), response);
  assert.deepEqual(await f.call('timeline.get', {projectId}), latest);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests WHERE requestId=?').get(((((params.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n, 1);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_history WHERE operation=?').get(operation))!.n, 1);
});

test('one undo removes both halves atomically; redo restores IDs; new split branches retain old responses after restart', async t => {
  const f = await fixture(t), projectId = f.projectId, {timeline: initial, clip} = await singleClip(f, {sourceInFrame: 5}, 'video/mp4');
  const splitInput = request(projectId, initial, {clipId: clip.id, atFrame: 25});
  const split = await f.call(operation, splitInput), firstRight = assertSplit(initial, split, clip.id, 25).right;
  const undoInput = request(projectId, split), undo = await f.call('timeline.undo', undoInput);
  assert.deepEqual(editable(undo), editable(initial));
  assert.equal(undo.revision, split.revision + 1);
  const history = await f.call('timeline.history.get', {projectId});
  assert.equal(history.canRedo, true); assert.equal((history.redoEntry)!.operation, operation);
  const redoInput = request(projectId, undo), redo = await f.call('timeline.redo', redoInput);
  assert.deepEqual(editable(redo), editable(split));
  assert.ok(redo.clips.some((item) => item.id === firstRight.id));
  let latest = await f.call('timeline.undo', request(projectId, redo));
  await rejectAtomic(f, request(projectId, latest, {clipId: clip.id, atFrame: clip.startFrame}), 'SPLIT_BOUNDS');
  await rejectAtomic(f, request(projectId, (({revision: latest.revision - 1}) as unknown as Parameters<NonNullable<typeof request>>[1]), {clipId: clip.id, atFrame: 30}), 'REVISION_CONFLICT');
  const branchInput = request(projectId, latest, {clipId: clip.id, atFrame: 30}), branch = await f.call(operation, branchInput);
  const secondRight = assertSplit(latest, branch, clip.id, 30).right;
  assert.notEqual(secondRight.id, firstRight.id);
  latest = branch;
  const latestHistory = await f.call('timeline.history.get', {projectId});
  assert.equal(latestHistory.canRedo, false); assert.equal(latestHistory.length, history.length);
  assert.notEqual((latestHistory.undoEntry)!.id, (history.redoEntry)!.id);
  const durableState = f.state();
  f.restart();
  for (const [name, input, result] of ([[operation, splitInput, split], ['timeline.undo', undoInput, undo], ['timeline.redo', redoInput, redo], [operation, branchInput, branch]] as const)) assert.deepEqual(await f.call(name, input), result);
  assert.deepEqual(f.state(), durableState);
  assert.deepEqual(await f.call('timeline.get', {projectId}), latest);
  assert.deepEqual(await f.call('timeline.history.get', {projectId}), latestHistory);
  await rejectAtomic(f, request(projectId, latest), 'NOTHING_TO_REDO', 'timeline.redo');
});

async function independentRequests(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, inputs: unknown[]) {
  const source = `
    const {parentPort, workerData} = require('node:worker_threads');
    (async () => {
      const {openStore} = await import(workerData.db);
      const {createServices} = await import(workerData.services);
      const store = openStore(workerData.root, {lock: false});
      parentPort.once('message', async () => {
        try { parentPort.postMessage({result: await createServices(store, new Map()).call('timeline.clip.split', workerData.input)}); }
        catch (error) { parentPort.postMessage({error: {code: error.code, message: error.message}}); }
        finally { store.close(); }
      });
      parentPort.postMessage({ready: true});
    })().catch(error => { throw error; });`;
  const workers = inputs.map((input?) => new Worker(source, {eval: true, workerData: {root: f.root, input, db: new URL('../packages/business/src/db.ts', import.meta.url).href, services: new URL('../packages/business/src/services.ts', import.meta.url).href}}));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => { worker.once('message', (((message: { ready: unknown; }) => { assert.equal(message.ready, true); resolve(); }) as unknown as Parameters<typeof worker.once>[1])); worker.once('error', reject); })));
  const results = workers.map((worker) => new Promise<{result:FixtureTimeline;error:{code:string};response:FixtureTimeline}>((resolve, reject)=>{worker.once('message',resolve); worker.once('error', reject); }));
  workers.forEach((worker) => worker.postMessage('go'));
  return Promise.all(results);
}

test('independent connections split identical concurrent requests exactly once with one persisted right ID', {timeout: 30000}, async t => {
  const f = await fixture(t), projectId = f.projectId, {timeline, clip} = await singleClip(f);
  const params = request(projectId, timeline, {clipId: clip.id, atFrame: 25});
  const history = await f.call('timeline.history.get', {projectId});
  const responses = await independentRequests(t, f, Array.from({length: 4}, () => params));
  for (const response of responses) { assert.ok(!response.error, JSON.stringify(response.error)); assert.deepEqual(response.result, responses[0].result); }
  const result = responses[0].result;
  assertSplit(timeline, result, clip.id, 25, true);
  assert.equal((await f.call('timeline.history.get', {projectId})).length, history.length + 1);
  assert.deepEqual(await f.call('timeline.get', {projectId}), result);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests WHERE requestId=?').get(((((params.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n, 1);
  f.restart(); assert.deepEqual(await f.call(operation, params), result);
});

for (const sharedRequestId of ([false, true] as const)) {
  test(`independent connections reject competing split frames with ${sharedRequestId ? 'IDEMPOTENCY_CONFLICT for one request identity' : 'REVISION_CONFLICT for distinct request identities'}`, {timeout: 30000}, async t => {
    const f = await fixture(t), projectId = f.projectId, {timeline, clip} = await singleClip(f);
    const requestId = randomUUID(), frames = [20, 25, 30, 35];
    const inputs = frames.map(atFrame => request(projectId, timeline, {clipId: clip.id, atFrame, ...(sharedRequestId ? {requestId} : {})}));
    const beforeHistory = await f.call('timeline.history.get', {projectId});
    const results = await independentRequests(t, f, inputs);
    const winners = results.filter(result => result.result), errors = results.filter(result => result.error);
    assert.equal(winners.length, 1); assert.equal(errors.length, inputs.length - 1);
    errors.forEach(result => assert.equal(result.error.code, sharedRequestId ? 'IDEMPOTENCY_CONFLICT' : 'REVISION_CONFLICT'));
    const winnerIndex = results.findIndex(result => result.result), winner = winners[0].result;
    assertSplit(timeline, winner, clip.id, ((inputs[winnerIndex].atFrame) as unknown as Parameters<typeof assertSplit>[3]), true);
    assert.equal((await f.call('timeline.history.get', {projectId})).length, beforeHistory.length + 1);
    assert.deepEqual(await f.call('timeline.get', {projectId}), winner);
    f.restart();
    assert.deepEqual(await f.call(operation, inputs[winnerIndex]), winner);
    for (const [index, params] of inputs.entries()) if (index !== winnerIndex) await rejectAtomic(f, params, sharedRequestId ? 'IDEMPOTENCY_CONFLICT' : 'REVISION_CONFLICT');
  });
}

test('split rolls back timeline, history insertion, redo deletion, cursor and response failures as one transaction', async t => {
  const f = await fixture(t), projectId = f.projectId, {timeline: initial, clip} = await singleClip(f);
  let timeline = await f.call('timeline.track.update', request(projectId, initial, {trackId: initial.tracks[0].id, patch: {name: 'Preserve redo'}}));
  timeline = await f.call('timeline.undo', request(projectId, timeline));
  const params = request(projectId, timeline, {clipId: clip.id, atFrame: 25});
  const failures = ([
    ['BEFORE UPDATE ON timelines', 'timeline'],
    ['BEFORE INSERT ON timeline_history', 'history'],
    ['BEFORE UPDATE ON timeline_history_cursors', 'cursor'],
    ['BEFORE INSERT ON timeline_requests', 'response'],
  ] as const);
  for (const [target, name] of failures) {
    const before = f.state(), outside = f.outside();
    f.store.db.exec(`CREATE TRIGGER inject_split_failure ${target} BEGIN SELECT RAISE(ABORT,'injected split ${name} failure'); END;`);
    try {
      await assert.rejects(f.call(operation, params), new RegExp(`injected split ${name} failure`));
      assert.deepEqual(f.state(), before, `${name} failure restores all persisted edit state`);
      assert.deepEqual(f.outside(), outside);
      assert.equal((await f.call('timeline.history.get', {projectId})).canRedo, true);
    } finally { f.store.db.exec('DROP TRIGGER inject_split_failure'); }
    f.restart(); assert.deepEqual(f.state(), before, 'rollback survives a store restart');
  }
  const response = await f.call(operation, params);
  assertSplit(timeline, response, clip.id, 25, true);
  assert.equal((await f.call('timeline.history.get', {projectId})).canRedo, false);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM timeline_requests WHERE requestId=?').get(((((params.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n, 1);
});
