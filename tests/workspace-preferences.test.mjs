import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore, createServices, createWorkspacePreferences} from '@mioon/business';
import {parseWorkspacePreferencesState} from '../packages/business/src/workspace-preferences.mjs';
import {schemas} from '@mioon/contracts';
import {defaultWorkspaceState, reconcileWorkspaceState} from '../apps/web/src/workspace-state.js';

const copy = value => structuredClone(value);
const state = () => {
  const value = defaultWorkspaceState();
  delete value.shared.assetSearch;
  return value;
};
const at = (value, path) => path.reduce((result, key) => result[key], value);
const set = (value, path, replacement) => { at(value, path.slice(0, -1))[path.at(-1)] = replacement; return value; };
const protectedTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines', 'timeline_requests', 'timeline_history', 'timeline_history_cursors', 'reference_requests', 'idempotency', 'job_events'];
const capture = store => Object.fromEntries(protectedTables.map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-preferences-'));
  let store = openStore(root), services = createServices(store, new Map()), preferences = createWorkspacePreferences(store);
  const project = await services.call('project.create', {name: 'Synthetic workspace preferences'});
  const f = {root, projectId: project.id, get store() { return store; }, get preferences() { return preferences; }, call: (op, input) => services.call(op, input),
    restart() { store.close(); store = openStore(root); services = createServices(store, new Map()); preferences = createWorkspacePreferences(store); }};
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  return f;
}

test('preference reads have no writes, require an existing project, and are absent from RPC schemas', async t => {
  const f = await fixture(t), before = capture(f.store);
  assert.deepEqual(f.preferences.get(f.projectId), {projectId: f.projectId, revision: 0, state: null});
  assert.deepEqual(capture(f.store), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM workspace_preferences').get().n, 0);
  for (const operation of ['workspace.preferences.get', 'workspace.preferences.put', 'workspace-preferences.get', 'workspace-preferences.put']) {
    assert.equal(schemas[operation], undefined);
    await assert.rejects(f.call(operation, {projectId: f.projectId}), {code: 'UNKNOWN_OPERATION'});
  }
  for (const projectId of ['', 'invalid', '../project', 'x'.repeat(200), null]) {
    assert.throws(() => f.preferences.get(projectId), {code: 'VALIDATION_ERROR'});
    assert.throws(() => f.preferences.put(projectId, {expectedRevision: 0, state: state()}), {code: 'VALIDATION_ERROR'});
  }
  const missing = randomUUID();
  assert.throws(() => f.preferences.get(missing), {code: 'NOT_FOUND'});
  assert.throws(() => f.preferences.put(missing, {expectedRevision: 0, state: state()}), {code: 'NOT_FOUND'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM workspace_preferences').get().n, 0);
});

test('the full bounded whitelist rejects missing, unknown, free-text, unsafe and malformed values atomically', async t => {
  const f = await fixture(t), projectId = f.projectId;
  const valid = state(); valid.canvas.viewport = {x: 0, y: 0, zoom: 1};
  const invalid = [null, [], 'state', {}, {...valid, version: 2}, {...valid, activeMode: 'other'}];
  for (const parent of [[], ['canvas'], ['canvas', 'viewport'], ['editing'], ['shared']]) {
    const branch = at(valid, parent);
    invalid.push(set(copy(valid), [...parent, 'unexpected'], true));
    for (const key of Object.keys(branch)) { const value = copy(valid); delete at(value, parent)[key]; invalid.push(value); }
    if (parent.length) for (const bad of [null, [], false, 1]) invalid.push(set(copy(valid), parent, bad));
  }
  // viewport alone permits null.
  const viewportNull = copy(valid); viewportNull.canvas.viewport = null;
  assert.deepEqual(parseWorkspacePreferencesState(viewportNull), viewportNull);
  const invalidWithoutNullable = invalid.filter(value => value?.canvas?.viewport !== null);
  for (const name of ['assetSearch', 'prompt', 'apiKey', 'requestId', 'token', 'draft']) invalidWithoutNullable.push(set(copy(valid), ['shared', name], 'must never be persisted'));
  for (const field of [['canvas', 'selectedId'], ['canvas', 'selectedEdgeId'], ['canvas', 'highlightedVersionId'], ['editing', 'selectedClipId'], ['editing', 'quickAssetId']]) {
    for (const bad of ['', 'not-an-id', 'x'.repeat(199), 'x'.repeat(200), 5, {}, false]) invalidWithoutNullable.push(set(copy(valid), field, bad));
  }
  const ranges = [
    [['canvas', 'viewport', 'x'], -1e6, 1e6], [['canvas', 'viewport', 'y'], -1e6, 1e6], [['canvas', 'viewport', 'zoom'], .2, 1.75],
    [['editing', 'playhead'], 0, 18000], [['editing', 'pixelsPerSecond'], 28, 220], [['editing', 'scrollLeft'], 0, 1e7], [['editing', 'scrollTop'], 0, 1e6],
  ];
  for (const [field, min, max] of ranges) {
    for (const good of [min, max]) assert.equal(at(parseWorkspacePreferencesState(set(copy(valid), field, good)), field), good);
    for (const bad of [min - 1, max + 1, NaN, Infinity, -Infinity, '1', null]) invalidWithoutNullable.push(set(copy(valid), field, bad));
  }
  invalidWithoutNullable.push(set(copy(valid), ['editing', 'playhead'], 1.5));
  for (const field of [['canvas', 'storyboardOpen'], ['canvas', 'miniMap'], ['editing', 'timelineCollapsed'], ['shared', 'assetsCollapsed'], ['shared', 'inspectorCollapsed']]) {
    for (const bad of [0, 1, 'true', null]) invalidWithoutNullable.push(set(copy(valid), field, bad));
  }
  for (const field of [['canvas', 'inspectorTab'], ['editing', 'previewKind'], ['shared', 'assetFilter']]) invalidWithoutNullable.push(set(copy(valid), field, 'unknown'));
  for (const value of invalidWithoutNullable) assert.throws(() => f.preferences.put(projectId, {expectedRevision: 0, state: value}), {code: 'VALIDATION_ERROR'});
  for (const value of [null, [], {}, {state: valid}, {expectedRevision: 0}, {expectedRevision: 0, state: valid, requestId: randomUUID()}]) assert.throws(() => f.preferences.put(projectId, value), {code: 'VALIDATION_ERROR'});
  for (const revision of [-1, .5, '0', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.preferences.put(projectId, {expectedRevision: revision, state: valid}), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(f.preferences.get(projectId), {projectId, revision: 0, state: null});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM workspace_preferences').get().n, 0);
});

test('independent CAS revisions replay only the latest exact write and never overwrite stale state', async t => {
  const f = await fixture(t), projectId = f.projectId, value = state();
  value.canvas.viewport = {zoom: 1.25, y: -50, x: -0}; value.activeMode = 'editing';
  const first = f.preferences.put(projectId, {expectedRevision: 0, state: value});
  assert.equal(first.revision, 1); assert.equal(Object.is(first.state.canvas.viewport.x, -0), false);
  const reorder = object => object && typeof object === 'object' && !Array.isArray(object) ? Object.fromEntries(Object.entries(object).reverse().map(([key, v]) => [key, reorder(v)])) : object;
  assert.deepEqual(f.preferences.put(projectId, reorder({expectedRevision: 0, state: value})), first);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM workspace_preferences').get().n, 1);
  const conflict = input => assert.throws(() => f.preferences.put(projectId, input), error => error.code === 'PREFERENCES_CONFLICT' && error.status === 409 && error.details.currentRevision === 1);
  conflict({expectedRevision: 0, state: state()});
  conflict({expectedRevision: 2, state: value});
  conflict({expectedRevision: Number.MAX_SAFE_INTEGER, state: value});
  assert.deepEqual(f.preferences.get(projectId), first);
  const next = f.preferences.put(projectId, {expectedRevision: 1, state: state()});
  assert.equal(next.revision, 2);
  assert.throws(() => f.preferences.put(projectId, {expectedRevision: 0, state: value}), {code: 'PREFERENCES_CONFLICT'});
  assert.throws(() => f.preferences.put(projectId, {expectedRevision: 0, state: state()}), {code: 'PREFERENCES_CONFLICT'});
  f.restart();
  assert.deepEqual(f.preferences.get(projectId), next);
  assert.deepEqual(f.preferences.put(projectId, {expectedRevision: 1, state: state()}), next);
  f.store.db.prepare('UPDATE workspace_preferences SET revision=? WHERE projectId=?').run(Number.MAX_SAFE_INTEGER, projectId);
  assert.throws(() => f.preferences.put(projectId, {expectedRevision: Number.MAX_SAFE_INTEGER, state: state()}), {code: 'PREFERENCES_REVISION_EXHAUSTED'});
  assert.equal(f.preferences.get(projectId).revision, Number.MAX_SAFE_INTEGER);
});

test('selection IDs can outlive entities, project preferences stay isolated, and business/history bytes are untouched', async t => {
  const f = await fixture(t), projectId = f.projectId;
  const other = await f.call('project.create', {name: 'Other synthetic project'});
  const shot = await f.call('shot.create', {projectId, title: 'Stable shot', prompt: 'Business content'});
  const node = await f.call('node.create', {projectId, type: 'text', text: 'Canvas content', position: {x: 10, y: 20}});
  await f.call('edge.create', {projectId, source: node.id, target: shot.id});
  const timeline = await f.call('timeline.get', {projectId});
  const edit = {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), kind: 'audio', name: 'History fixture'};
  await f.call('timeline.track.add', edit);
  const assetId = randomUUID(), jobId = randomUUID(), versionId = randomUUID();
  f.store.put('assets', {id: assetId, projectId, name: 'Immutable synthetic asset', mimeType: 'video/mp4', relativePath: `media/${assetId}.mp4`, sha256: 'a'.repeat(64)});
  f.store.put('jobs', {id: jobId, projectId, shotId: shot.id, status: 'succeeded', revision: 8, requestId: randomUUID(), snapshot: {prompt: 'Frozen generation prompt', referenceAssetIds: [assetId]}, versionId});
  f.store.put('versions', {id: versionId, projectId, jobId, shotId: shot.id, assetId, snapshot: {prompt: 'Frozen version prompt'}});
  f.store.put('exports', {id: randomUUID(), projectId, status: 'succeeded', mode: 'timeline', timelineRevision: timeline.revision, purpose: 'export', snapshot: {tracks: timeline.tracks, clips: []}});
  f.store.db.prepare('INSERT INTO reference_requests(requestId,requestHash,response) VALUES(?,?,?)').run(randomUUID(), 'synthetic-reference-hash', '{"immutable":"reference-response"}');
  f.store.db.prepare('INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES(?,?,?,?)').run('generation', randomUUID(), 'synthetic-generation-hash', jobId);
  f.store.db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(jobId, '{"status":"succeeded"}', '2026-10-09T00:00:00.000Z');
  const before = capture(f.store), value = state();
  value.canvas.selectedId = shot.id;
  value.canvas.selectedEdgeId = randomUUID(); value.canvas.highlightedVersionId = randomUUID();
  value.editing.selectedClipId = randomUUID(); value.editing.quickAssetId = randomUUID();
  const saved = f.preferences.put(projectId, {expectedRevision: 0, state: value});
  assert.deepEqual(f.preferences.get(other.id), {projectId: other.id, revision: 0, state: null});
  const otherState = state(); otherState.activeMode = 'editing';
  f.preferences.put(other.id, {expectedRevision: 0, state: otherState});
  assert.deepEqual(f.preferences.get(projectId), saved);
  assert.deepEqual(capture(f.store), before);
  const reconciled = reconcileWorkspaceState(saved.state, {shots: [shot]});
  assert.equal(reconciled.canvas.selectedId, shot.id);
  for (const field of [['canvas', 'selectedEdgeId'], ['canvas', 'highlightedVersionId'], ['editing', 'selectedClipId'], ['editing', 'quickAssetId']]) assert.equal(at(reconciled, field), null);
  f.restart(); assert.deepEqual(capture(f.store), before); assert.deepEqual(f.preferences.get(projectId), saved);
});

test('additive v5 migration preserves legacy records, immutable requests, history and bytes', async t => {
  const f = await fixture(t), projectId = f.projectId;
  await f.call('shot.create', {projectId, title: 'Legacy shot'});
  let timeline = await f.call('timeline.get', {projectId});
  const input = {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), kind: 'audio', name: 'Legacy edit'};
  timeline = await f.call('timeline.track.add', input);
  const before = capture(f.store);
  f.store.db.exec('DROP TABLE workspace_preferences; DELETE FROM schema_version WHERE version=5;');
  f.restart();
  assert.ok(f.store.db.prepare('SELECT version FROM schema_version WHERE version=5').get());
  assert.deepEqual(capture(f.store), before);
  assert.deepEqual(f.preferences.get(projectId), {projectId, revision: 0, state: null});
  assert.deepEqual(await f.call('timeline.track.add', input), timeline);
  f.preferences.put(projectId, {expectedRevision: 0, state: state()});
  assert.deepEqual(capture(f.store), before);
  assert.throws(() => f.store.db.prepare('UPDATE timeline_history SET operation=?').run('changed'), /immutable/);
  assert.throws(() => f.store.db.prepare('UPDATE timeline_requests SET response=?').run('{}'), /immutable/);
});

async function race(t, f, states, expectedRevision) {
  const barrier = new SharedArrayBuffer(4), flag = new Int32Array(barrier);
  const script = `const {parentPort, workerData} = require('node:worker_threads');
  (async () => {
    const {openStore, createWorkspacePreferences} = await import(workerData.module);
    const store = openStore(workerData.root, {lock:false});
    try {
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try { parentPort.postMessage({ok:true, result:createWorkspacePreferences(store).put(workerData.projectId, {expectedRevision:workerData.expectedRevision,state:workerData.state})}); }
      catch(error) { parentPort.postMessage({ok:false, code:error.code, details:error.details}); }
    } finally { store.close(); }
  })().catch(error => { throw error; });`;
  const workers = states.map(value => {
    const worker = new Worker(script, {eval: true, workerData: {module: new URL('../packages/business/src/index.mjs', import.meta.url).href, root: f.root, projectId: f.projectId, state: value, expectedRevision, barrier}});
    t.after(() => worker.terminate());
    let readyResolve, readyReject, resultResolve, resultReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    worker.on('message', message => message.ready ? readyResolve() : resultResolve(message));
    worker.on('error', error => { readyReject(error); resultReject(error); });
    return {ready, result};
  });
  try { await Promise.all(workers.map(worker => worker.ready)); }
  finally { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }
  return Promise.all(workers.map(worker => worker.result));
}

test('competing database connections commit one CAS winner and deduplicate simultaneous exact retries', {timeout: 20000}, async t => {
  const f = await fixture(t), variants = [10, 20, 30, 40].map(playhead => { const value = state(); value.editing.playhead = playhead; return value; });
  const results = await race(t, f, variants, 0), winners = results.filter(result => result.ok);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].result.revision, 1);
  for (const loser of results.filter(result => !result.ok)) { assert.equal(loser.code, 'PREFERENCES_CONFLICT'); assert.equal(loser.details.currentRevision, 1); }
  assert.deepEqual(f.preferences.get(f.projectId), winners[0].result);
  const same = state(); same.editing.playhead = 100;
  const retries = await race(t, f, Array.from({length: 4}, () => same), 1);
  for (const retry of retries) { assert.equal(retry.ok, true); assert.equal(retry.result.revision, 2); assert.deepEqual(retry.result.state, same); }
  assert.equal(f.preferences.get(f.projectId).revision, 2);
});
