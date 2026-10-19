import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {getTimelineFadeIssue, TIMELINE_FADE_MAX_FRAMES, parse, schemas} from '../packages/contracts/src/index.ts';
import {READ_TOOL_DEFINITIONS, parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS, parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.ts';

// Synthetic metadata only: these tests never invoke providers or media workers.
const fields = ['fadeInFrames', 'fadeOutFrames'];
const clone = value => JSON.parse(JSON.stringify(value));
const editable = timeline => clone({tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames});
const request = (f, timeline, extra = {}) => ({projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), ...extra});
const outsideTables = ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports'];
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-fades-'));
  let store = openStore(root), services = createServices(store, new Map());
  const f = {
    get store() { return store; },
    call: (operation, input) => services.call(operation, input),
    restart() { store.close(); store = openStore(root); services = createServices(store, new Map()); },
    asset(mimeType = 'audio/wav', extra = {}) {
      const id = randomUUID();
      return store.put('assets', {id, projectId: f.projectId, name: 'Synthetic source', mimeType, duration: 600,
        width: 720, height: 1280, hasAudio: !mimeType.startsWith('image/'), sha256: 'a'.repeat(64), relativePath: `media/${id}.fixture`, ...extra});
    },
    state() { return Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); },
    outside() { return Object.fromEntries(outsideTables.map(table => [table, clone(store.list(table))])); },
  };
  f.projectId = (await f.call('project.create', {name: t.name})).id;
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  return f;
}
async function add(f, extra = {}, asset = f.asset()) {
  const timeline = await f.call('timeline.get', {projectId: f.projectId});
  const trackId = timeline.tracks.find(track => track.kind === (asset.mimeType.startsWith('audio/') ? 'audio' : 'video')).id;
  const input = request(f, timeline, {assetId: asset.id, trackId, startFrame: 100, durationFrames: 60, sourceInFrame: asset.mimeType.startsWith('image/') ? 0 : 7, ...extra});
  const result = await f.call('timeline.clip.add', input);
  return {timeline: result, clip: result.clips.at(-1), input, asset};
}
async function rejectAtomic(f, operation, input, code) {
  const state = f.state(), outside = f.outside();
  await assert.rejects(f.call(operation, input), error => error.code === code && Boolean(error.message), `${operation}: ${code}`);
  assert.deepEqual(f.state(), state, 'rejection preserves exact aggregate, journal, cursor, redo branch and response bytes');
  assert.deepEqual(f.outside(), outside, 'rejection cannot change source metadata or unrelated state');
}

test('fade schema preserves absence and explicit zero, accepts only bounded integer frames, and adds no operations', () => {
  const input = {projectId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), trackId: randomUUID(), assetId: randomUUID(), startFrame: 0, durationFrames: 60};
  assert.deepEqual(parse('timeline.clip.add', input), input);
  const update = {projectId: input.projectId, expectedRevision: 1, requestId: randomUUID(), clipId: randomUUID(), patch: {gain: 1}};
  assert.deepEqual(parse('timeline.clip.update', update), update);
  for (const field of fields) {
    for (const value of [0, 1, 18000]) {
      assert.equal(parse('timeline.clip.add', {...input, [field]: value})[field], value);
      assert.deepEqual(parse('timeline.clip.update', {...update, patch: {[field]: value}}).patch, {[field]: value});
    }
    for (const value of [-1, 18001, 0.5, '1', null, true, {}, [], NaN, Infinity]) {
      assert.throws(() => parse('timeline.clip.add', {...input, [field]: value}), {code: 'VALIDATION_ERROR'});
      assert.throws(() => parse('timeline.clip.update', {...update, patch: {[field]: value}}), {code: 'VALIDATION_ERROR'});
    }
  }
  assert.throws(() => parse('timeline.clip.update', {...update, patch: {fadeInSeconds: 1}}), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(Object.keys(schemas).filter(name => name.includes('fade')), []);
  assert.equal(TIMELINE_FADE_MAX_FRAMES, 18000);
});

test('pure shared validator requires confirmed audio only for positive fades and never normalizes clips', () => {
  for (const clip of [{durationFrames: 30}, {durationFrames: 30, fadeInFrames: 0}, {durationFrames: 30, fadeOutFrames: 0}, {durationFrames: 30, fadeInFrames: 0, fadeOutFrames: 0}]) {
    const bytes = JSON.stringify(clip);
    assert.equal(getTimelineFadeIssue(Object.freeze(clip), {mimeType: 'image/png', hasAudio: true}), null);
    assert.equal(JSON.stringify(clip), bytes);
  }
  const valid = {durationFrames: 30, fadeInFrames: 10, fadeOutFrames: 20};
  for (const mimeType of ['audio/wav', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'video/webm']) {
    assert.equal(getTimelineFadeIssue(valid, {mimeType, hasAudio: true}), null);
    for (const hasAudio of [false, null, undefined, 1, 'true'])
      assert.equal(getTimelineFadeIssue(valid, {mimeType, hasAudio}).code, 'FADE_AUDIO_UNSUPPORTED');
  }
  for (const asset of [null, {}, {mimeType: 'image/png', hasAudio: true}])
    assert.equal(getTimelineFadeIssue(valid, asset).code, 'FADE_AUDIO_UNSUPPORTED');
  for (const patch of [{fadeInFrames: null}, {fadeOutFrames: 1.2}, {fadeInFrames: -1}, {fadeOutFrames: 18001}, {fadeInFrames: 31}, {fadeInFrames: 11}])
    assert.equal(getTimelineFadeIssue({...valid, ...patch}, {mimeType: 'audio/wav', hasAudio: true}).code, 'INVALID_FADE');
});

test('add stores exactly the provided fade keys, including zero on images or unknown-audio legacy assets', async t => {
  const f = await fixture(t);
  for (const [index, values] of [{}, {fadeInFrames: 0}, {fadeOutFrames: 0}, {fadeInFrames: 0, fadeOutFrames: 0}, {fadeInFrames: 1}, {fadeOutFrames: 60}, {fadeInFrames: 20, fadeOutFrames: 40}].entries()) {
    const {clip} = await add(f, {startFrame: index * 60, ...values});
    assert.deepEqual(Object.fromEntries(fields.filter(field => Object.hasOwn(clip, field)).map(field => [field, clip[field]])), values);
  }
  const image = f.asset('image/png', {hasAudio: true});
  await add(f, {startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0}, image);
  const unknown = f.asset('video/mp4', {hasAudio: undefined});
  await add(f, {startFrame: 60, fadeInFrames: 0}, unknown);
  f.restart();
  const persisted = await f.call('timeline.get', {projectId: f.projectId});
  assert.equal(Object.hasOwn(persisted.clips[0], 'fadeInFrames'), false);
  assert.equal(Object.hasOwn(persisted.clips[0], 'fadeOutFrames'), false);
});

test('positive fades require confirmed audio and rejected adds never initialize a fresh timeline', async t => {
  const f = await fixture(t);
  const empty = await f.call('timeline.get', {projectId: f.projectId});
  for (const mimeType of ['audio/wav', 'video/mp4', 'image/png']) {
    for (const hasAudio of [false, null, undefined, ...(mimeType.startsWith('image/') ? [true] : [])]) {
      const asset = f.asset(mimeType, {hasAudio}), trackId = empty.tracks.find(track => track.kind === (mimeType.startsWith('audio/') ? 'audio' : 'video')).id;
      for (const field of fields) await rejectAtomic(f, 'timeline.clip.add', request(f, empty, {assetId: asset.id, trackId, startFrame: 0, durationFrames: 30, [field]: 1}), 'FADE_AUDIO_UNSUPPORTED');
    }
  }
  const missingTimelineProject = (await f.call('project.create', {name: 'No state on rejection'})).id;
  await rejectAtomic(f, 'timeline.clip.add', {projectId: missingTimelineProject, expectedRevision: 1, requestId: randomUUID(), assetId: f.asset().id, trackId: empty.tracks[0].id, startFrame: 0, durationFrames: 30, fadeInFrames: 1}, 'CROSS_PROJECT_REFERENCE');
  assert.equal(f.store.db.prepare('SELECT * FROM timelines WHERE projectId=?').get(missingTimelineProject), undefined);
});

test('fade duration bounds and trims are atomic, never clamp, and may be fixed in the same patch', async t => {
  const f = await fixture(t), {timeline: initial, clip} = await add(f, {fadeInFrames: 20, fadeOutFrames: 30});
  let timeline = initial;
  for (const patch of [{durationFrames: 49}, {durationFrames: 19}, {fadeInFrames: 31}, {fadeOutFrames: 41}, {fadeInFrames: 61}, {fadeInFrames: null}])
    await rejectAtomic(f, 'timeline.clip.update', request(f, timeline, {clipId: clip.id, patch}), patch.fadeInFrames === null ? 'VALIDATION_ERROR' : 'INVALID_FADE');
  timeline = await f.call('timeline.clip.update', request(f, timeline, {clipId: clip.id, patch: {durationFrames: 30, sourceInFrame: 15, fadeInFrames: 10, fadeOutFrames: 20}}));
  assert.equal(timeline.clips[0].durationFrames, 30); assert.equal(timeline.clips[0].sourceInFrame, 15);
  assert.equal(timeline.clips[0].fadeInFrames, 10); assert.equal(timeline.clips[0].fadeOutFrames, 20);
  timeline = await f.call('timeline.clip.update', request(f, timeline, {clipId: clip.id, patch: {durationFrames: 50}}));
  assert.equal(timeline.clips[0].fadeInFrames, 10); assert.equal(timeline.clips[0].fadeOutFrames, 20);
  const source = f.asset(), emptyTrack = timeline.tracks.find(track => track.kind === 'audio').id;
  await rejectAtomic(f, 'timeline.clip.add', request(f, timeline, {assetId: source.id, trackId: emptyTrack, startFrame: 1000, durationFrames: 30, fadeInFrames: 20, fadeOutFrames: 11}), 'INVALID_FADE');
  const long = await add(f, {trackId: timeline.tracks[0].id, startFrame: 0, durationFrames: 18000, sourceInFrame: 0, fadeInFrames: 18000}, f.asset('video/mp4'));
  assert.equal(long.clip.fadeInFrames, 18000);
  await rejectAtomic(f, 'timeline.clip.update', request(f, long.timeline, {clipId: long.clip.id, patch: {fadeOutFrames: 1}}), 'INVALID_FADE');
});

test('gain, mute and hidden controls preserve fades and all source metadata', async t => {
  const f = await fixture(t), {timeline: initial, clip} = await add(f, {gain: 0, fadeInFrames: 12, fadeOutFrames: 18}, f.asset('video/mp4'));
  let timeline = initial; const outside = f.outside();
  for (const muted of [true, false]) {
    timeline = await f.call('timeline.track.update', request(f, timeline, {trackId: clip.trackId, patch: {muted, hidden: muted}}));
    assert.equal(timeline.clips[0].fadeInFrames, 12); assert.equal(timeline.clips[0].fadeOutFrames, 18);
  }
  for (const gain of [2, 0.5, 0]) {
    timeline = await f.call('timeline.clip.update', request(f, timeline, {clipId: clip.id, patch: {gain}}));
    assert.deepEqual(timeline.clips[0], {...clip, gain});
  }
  assert.deepEqual(f.outside(), outside);
});

test('split preserves the original outer fades and only zeros previously present inner fields at both boundaries', async t => {
  for (const values of [{}, {fadeInFrames: 0}, {fadeOutFrames: 0}, {fadeInFrames: 0, fadeOutFrames: 0}, {fadeInFrames: 10}, {fadeOutFrames: 20}, {fadeInFrames: 10, fadeOutFrames: 20}, {fadeInFrames: 10, fadeOutFrames: 50}]) {
    for (const offset of [...new Set([Math.max(1, values.fadeInFrames || 0), Math.min(59, 60 - (values.fadeOutFrames || 0))])]) {
      await t.test(`${JSON.stringify(values)} at ${offset}`, async t => {
        const f = await fixture(t), {timeline: before, clip} = await add(f, values);
        const history = await f.call('timeline.history.get', {projectId: f.projectId});
        const outside = f.outside();
        const params = request(f, before, {clipId: clip.id, atFrame: clip.startFrame + offset});
        const split = await f.call('timeline.clip.split', params), [left, right] = split.clips;
        assert.deepEqual(left, {...clip, durationFrames: offset, ...(Object.hasOwn(values, 'fadeOutFrames') ? {fadeOutFrames: 0} : {})});
        assert.deepEqual(right, {...clip, id: right.id, startFrame: clip.startFrame + offset, durationFrames: 60 - offset, sourceInFrame: clip.sourceInFrame + offset, ...(Object.hasOwn(values, 'fadeInFrames') ? {fadeInFrames: 0} : {})});
        assert.notEqual(left.id, right.id);
        assert.equal(split.durationFrames, before.durationFrames);
        assert.equal((await f.call('timeline.history.get', {projectId: f.projectId})).length, history.length + 1);
        let timeline = await f.call('timeline.undo', request(f, split));
        assert.deepEqual(editable(timeline), editable(before));
        f.restart();
        timeline = await f.call('timeline.redo', request(f, timeline));
        assert.deepEqual(editable(timeline), editable(split));
        assert.deepEqual(await f.call('timeline.clip.split', params), split);
        assert.deepEqual(f.outside(), outside);
      });
    }
  }
});

test('split inside either fade preserves exact state and a pending redo branch', async t => {
  const f = await fixture(t), {timeline: initial, clip} = await add(f, {fadeInFrames: 10, fadeOutFrames: 20});
  let timeline = await f.call('timeline.clip.update', request(f, initial, {clipId: clip.id, patch: {name: 'Pending redo'}}));
  timeline = await f.call('timeline.undo', request(f, timeline));
  for (const offset of [1, 9, 41, 59]) {
    const params = request(f, timeline, {clipId: clip.id, atFrame: clip.startFrame + offset});
    await rejectAtomic(f, 'timeline.clip.split', params, 'SPLIT_FADE_BOUNDS');
    await assert.rejects(f.call('timeline.clip.split', params), error => error.details.minFrame === 110 && error.details.maxFrame === 140);
  }
  assert.equal((await f.call('timeline.history.get', {projectId: f.projectId})).canRedo, true);
  timeline = await f.call('timeline.redo', request(f, timeline));
  assert.equal(timeline.clips[0].name, 'Pending redo');
  timeline = await f.call('timeline.clip.update', request(f, timeline, {clipId: clip.id, patch: {fadeInFrames: 60, fadeOutFrames: 0}}));
  await rejectAtomic(f, 'timeline.clip.split', request(f, timeline, {clipId: clip.id, atFrame: 159}), 'SPLIT_FADE_BOUNDS');
});

test('legacy snapshots, history and original request bytes remain exact across fades, travel and restart', async t => {
  const f = await fixture(t), {timeline: legacy, clip, input} = await add(f);
  const renderInput = request(f, legacy, {purpose: 'preview'}), frozen = await f.call('timeline.render', renderInput);
  const legacyRequest = f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);
  const legacyHistory = f.store.db.prepare('SELECT * FROM timeline_history ORDER BY position').all();
  const exportBytes = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(frozen.id).data;
  const legacyState = f.state();
  f.restart();
  assert.deepEqual(await f.call('timeline.get', {projectId: f.projectId}), legacy);
  assert.deepEqual(f.state(), legacyState, 'restart and reads do not normalize legacy aggregate, history or response bytes');
  const updateInput = request(f, legacy, {clipId: clip.id, patch: {fadeInFrames: 0, fadeOutFrames: 15}});
  const faded = await f.call('timeline.clip.update', updateInput);
  let timeline = await f.call('timeline.undo', request(f, faded));
  assert.deepEqual(editable(timeline), editable(legacy));
  assert.ok(fields.every(field => !Object.hasOwn(timeline.clips[0], field)));
  f.restart();
  const state = f.state();
  assert.deepEqual(await f.call('timeline.clip.add', input), legacy);
  assert.deepEqual(await f.call('timeline.clip.update', updateInput), faded);
  assert.deepEqual(await f.call('timeline.render', renderInput), frozen);
  assert.deepEqual(f.state(), state, 'historical replay does not rewrite current state');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId), legacyRequest);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_history ORDER BY position LIMIT 1').all(), legacyHistory);
  assert.equal(f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(frozen.id).data, exportBytes);
  timeline = await f.call('timeline.redo', request(f, timeline));
  assert.deepEqual(editable(timeline), editable(faded));
  const nextRender = await f.call('timeline.render', request(f, timeline, {purpose: 'export'}));
  assert.equal(nextRender.snapshot.timeline.clips[0].fadeInFrames, 0);
  assert.equal(nextRender.snapshot.timeline.clips[0].fadeOutFrames, 15);
  assert.ok(fields.every(field => !Object.hasOwn(frozen.snapshot.timeline.clips[0], field)));
});

test('fade requests distinguish omitted and explicit zero and retain revision and cross-project boundaries', async t => {
  const f = await fixture(t), {timeline: original, clip, input, asset} = await add(f);
  await rejectAtomic(f, 'timeline.clip.add', {...input, fadeInFrames: 0}, 'IDEMPOTENCY_CONFLICT');
  const update = request(f, original, {clipId: clip.id, patch: {fadeInFrames: 0}});
  const timeline = await f.call('timeline.clip.update', update);
  await rejectAtomic(f, 'timeline.clip.update', {...update, patch: {fadeOutFrames: 0}}, 'IDEMPOTENCY_CONFLICT');
  await rejectAtomic(f, 'timeline.clip.update', {...update, patch: {fadeInFrames: 1}}, 'IDEMPOTENCY_CONFLICT');
  await rejectAtomic(f, 'timeline.clip.update', {...update, requestId: randomUUID()}, 'REVISION_CONFLICT');
  const otherProject = (await f.call('project.create', {name: 'Other project'})).id;
  await rejectAtomic(f, 'timeline.clip.update', {...update, projectId: otherProject, expectedRevision: 1}, 'IDEMPOTENCY_CONFLICT');
  await rejectAtomic(f, 'timeline.clip.update', {...update, projectId: otherProject, expectedRevision: 1, requestId: randomUUID()}, 'CLIP_NOT_FOUND');
  const foreign = await f.call('timeline.get', {projectId: otherProject});
  await rejectAtomic(f, 'timeline.clip.add', {...input, projectId: otherProject, expectedRevision: foreign.revision, requestId: randomUUID(), trackId: foreign.tracks.find(track => track.kind === 'audio').id, fadeInFrames: 1, assetId: asset.id}, 'CROSS_PROJECT_REFERENCE');
  f.restart();
  assert.deepEqual(await f.call('timeline.clip.update', update), timeline);
  assert.deepEqual(await f.call('timeline.clip.add', input), original);
});

test('audio fades do not expand either model-facing Agent catalog or authority', () => {
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
  assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_propose_shot_update']);
  assert.deepEqual(Object.keys(EDIT_TOOL_DEFINITIONS[0].parameters.properties), ['title', 'prompt']);
  for (const operation of ['timeline_clip_add', 'timeline_clip_update', 'timeline_clip_split', 'timeline_fade']) {
    assert.throws(() => parseReadToolArguments(operation, '{}'), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
    assert.throws(() => parseEditToolArguments(operation, '{}'), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  }
});
