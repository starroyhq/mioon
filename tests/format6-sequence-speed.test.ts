import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore, type ProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {VOLUME_ENVELOPE_PROFILE, VOLUME_ENVELOPE_LIMITS} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {compileClipTimeMap} from '../packages/contracts/src/timeline-clip-timing.ts';
import {instantiateSpeedPreset, timeMapPlanFrames, TIMELINE_SPEED_PRESETS} from '../packages/contracts/src/timeline-time-map.ts';
import type {Format5Clip} from '../packages/contracts/src/project-format5.ts';
import type {TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import type {SequenceEditSpeedIntent, SpeedSetting} from '../packages/contracts/src/timeline-speed.ts';
import type {SequenceEditClipPropertiesPatch, SequenceEditHistoryView, SequenceEditReceipt} from '../packages/contracts/src/sequence-edit.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `50000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const rootId = id(2), shotA = id(3), shotB = id(4), imageNode = id(5), freeImage = id(6), videoTrack2 = id(62);
const videoTrack = id(60), audioTrack = id(61);
const assetA = id(10), assetB = id(11), imageAsset = id(12), audioAsset = id(13), freeImageAsset = id(14);
const versionA = id(20), versionB = id(21), jobA = id(70), jobB = id(71);
const clipA = id(30), clipB = id(31), clipImage = id(32), clipAudio = id(33), clipAudio2 = id(35), cueId = id(34);
const groupA = id(40), groupB = id(41), groupImage = id(42);
const timelineId = id(50);
const sha = (letter: string): string => letter.repeat(64);

function fixture(t: test.TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-speed-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION, allowFormat6: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 150,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: videoTrack2, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false}],
    clips: [
      {id: clipA, trackId: videoTrack, name: 'Shot A', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
        sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
      {id: clipB, trackId: videoTrack, name: 'Shot B', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
      {id: clipImage, trackId: videoTrack, name: 'Image', startFrame: 90, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: imageAsset,
        sourceState: 'ready', sequenceSource: {kind: 'media', nodeId: imageNode, segmentGroupId: groupImage}},
      {id: clipAudio, trackId: audioTrack, name: 'Audio', startFrame: 65, durationFrames: 20, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: audioAsset, sourceState: 'ready',
        anchor: {clipId: clipB, offsetFrames: 5}},
      {id: clipAudio2, trackId: audioTrack, name: 'Audio 2', startFrame: 120, durationFrames: 1, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: audioAsset, sourceState: 'ready',
        anchor: {clipId: clipImage, offsetFrames: 30}},
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: [{id: cueId, text: '示例', startFrame: 66, durationFrames: 2,
      anchor: {clipId: clipB, offsetFrames: 6}}]},
  };
  const baseline = {version: 1,
    board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionA}, {nodeId: shotB, kind: 'shot', selectedVersionId: null},
      {nodeId: imageNode, kind: 'media', assetId: imageAsset}],
    track: [{nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot', versionMode: 'follow', appliedVersionId: versionA},
      {nodeId: shotB, segmentGroupId: groupB, clipId: clipB, kind: 'shot', versionMode: 'follow', appliedVersionId: null},
      {nodeId: imageNode, segmentGroupId: groupImage, clipId: clipImage, kind: 'media', assetId: imageAsset}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic speed editing', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, hasAudio: true, sha256: sha('a')});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    store.put('assets', {id: imageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('c')});
    store.put('assets', {id: audioAsset, projectId, mimeType: 'audio/wav', duration: 1, sha256: sha('d')});
    store.put('assets', {id: freeImageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('e')});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: shotB, number: 1, assetId: assetB, sha256: sha('b'), createdAt: at});
    store.put('shots', {id: shotA, projectId, orderIndex: 0, selectedVersionId: versionA, duration: 2, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotB, projectId, orderIndex: 1, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at});
    store.put('nodes', node(rootId, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(imageNode, 'image', {assetId: imageAsset}));
    store.put('nodes', node(freeImage, 'image', {assetId: freeImageAsset}));
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: rootId, target: shotA, createdAt: at});
    store.put('edges', {id: id(81), projectId, kind: 'sequence', source: shotA, target: shotB, createdAt: at});
    store.put('edges', {id: id(82), projectId, kind: 'sequence', source: shotB, target: imageNode, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  return store;
}

function editor(store: ProjectStore) {
  const service = createFormat5SequenceEditService(store);
  const projectId = store.projectId;
  function preview(operation: SequenceEditSpeedIntent['operation']) {
    return service.preview({projectId, requestId: randomUUID(), speedIntent: {side: 'timeline', operation}});
  }
  function apply(operation: SequenceEditSpeedIntent['operation']) {
    const reviewed = preview(operation);
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    const input = {projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest};
    const receipt = service.commit(input) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
    return {receipt, replay: () => service.commit(input) as SequenceEditReceipt};
  }
  function properties(clipId: string, patch: SequenceEditClipPropertiesPatch) {
    const reviewed = service.preview({projectId, requestId: randomUUID(),
      propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties', edits: [{clipId, patch}]}}});
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    const receipt = service.commit({projectId, envelope: reviewed.envelope,
      expectedPlanDigest: reviewed.planDigest}) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
    return receipt;
  }
  function history(direction: 'undo' | 'redo', actionId: string) {
    const {position, revision} = service.history({projectId}) as SequenceEditHistoryView;
    const receipt = service[direction]({projectId, actionId, requestId: randomUUID(), expected: {position, revision}}) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
  }
  return {preview, apply, properties, history, service};
}

function saved(store: ProjectStore) {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  assert.ok(timeline);
  return timeline;
}

function state(store: ProjectStore) {
  return {
    timeline: saved(store),
    stamp: readProjectContentStamp(store.db),
    sync: store.db.prepare('SELECT revision,baseline FROM project.sequence_sync_state').get(),
    history: store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state').all(),
    actions: store.db.prepare('SELECT actionId FROM main.editor_history_entries ORDER BY position').all(),
    receipts: store.db.prepare('SELECT requestId FROM main.editor_requests ORDER BY requestId').all(),
  };
}

const constant = (numerator: number, denominator = 1): TimeMapSpeed =>
  ({kind: 'constant', rate: {numerator, denominator}});
function set(speed: TimeMapSpeed, patch: Partial<SpeedSetting> = {}, clipId = clipA): SequenceEditSpeedIntent['operation'] {
  return {kind: 'clip-speed', clipId, setting: {speed, direction: 'forward', pitchShift: false, interpolation: 'off', ...patch}};
}

function sourceFrames(store: ProjectStore, clipId = clipA): Int32Array {
  const timeline = saved(store), clip = timeline.clips.find(item => item.id === clipId);
  assert.ok(clip);
  const plan = compileClipTimeMap(clip, timeline);
  assert.ok(plan.ok, JSON.stringify(plan));
  const frames = timeMapPlanFrames(plan.value);
  assert.ok(frames.ok, JSON.stringify(frames));
  return frames.value;
}

test('identity and repeated identical speed edits are zero-write operations', t => {
  const store = fixture(t), api = editor(store);
  const before = state(store);
  assert.deepEqual(api.preview(set(constant(1))), {ok: false, code: 'SEQUENCE_EDIT_NOOP', ids: [clipA]});
  assert.deepEqual(state(store), before);
  const speed = set(constant(3, 2));
  api.apply(speed);
  const committed = state(store);
  const repeated = api.preview(speed);
  assert.ok('code' in repeated);
  assert.equal(repeated.code, 'SEQUENCE_EDIT_NOOP');
  assert.deepEqual(state(store), committed);
});

test('eight constant rates preserve source range and carry suffix clips and anchors', async t => {
  const rates = [[1, 10, 600], [1, 4, 240], [1, 2, 120], [11, 10, 55], [3, 2, 40], [2, 1, 30], [4, 1, 15], [10, 1, 6]];
  for (const [numerator, denominator, frames] of rates) {
    await t.test(`${numerator}/${denominator}`, t => {
      const store = fixture(t), api = editor(store);
      const receipt = api.apply(set(constant(numerator, denominator), {interpolation: 'blend'})).receipt;
      const timeline = saved(store);
      const clip = timeline.clips.find(item => item.id === clipA)!;
      assert.equal(clip.durationFrames, frames);
      assert.equal(clip.sourceInFrame, 0);
      assert.equal(clip.sourceSpanFrames, 60);
      assert.equal(clip.timing?.profile, 'timeline-speed-v1');
      assert.equal(clip.timing.interpolation, numerator < denominator ? 'blend' : 'off');
      assert.equal(timeline.clips.find(item => item.id === clipB)!.startFrame, frames);
      assert.equal(timeline.clips.find(item => item.id === clipImage)!.startFrame, frames + 30);
      assert.equal(timeline.clips.find(item => item.id === clipAudio)!.startFrame, frames + 5);
      assert.equal(timeline.clips.find(item => item.id === clipAudio2)!.startFrame, frames + 60);
      assert.equal(timeline.subtitles?.cues[0].startFrame, frames + 6);
      assert.equal(receipt.history.position, 1);
    });
  }
});

test('all eight shared presets pass preview and retain their absolute curve points', async t => {
  assert.equal(TIMELINE_SPEED_PRESETS.length, 8);
  for (const {id: presetId} of TIMELINE_SPEED_PRESETS) {
    await t.test(presetId, t => {
      const store = fixture(t), api = editor(store);
      const speed = instantiateSpeedPreset(presetId, 0, 60);
      assert.ok(speed.ok);
      if (presetId === 'none') {
        const preview = api.preview(set(speed.value));
        assert.ok('code' in preview);
        assert.equal(preview.code, 'SEQUENCE_EDIT_NOOP');
        return;
      }
      api.apply(set(speed.value));
      const timing = saved(store).clips.find(item => item.id === clipA)?.timing;
      assert.equal(timing?.profile, 'timeline-speed-v1');
      assert.deepEqual(timing.basis.speed, speed.value);
      assert.equal(sourceFrames(store).length, timing.outputWindow.toFrame);
    });
  }
});

test('two direction flips restore exactly the original samples and sound settings leave the window alone', t => {
  const store = fixture(t), api = editor(store);
  const rate = constant(3, 2);
  api.apply(set(rate));
  const forward = sourceFrames(store);
  const timing = saved(store).clips.find(item => item.id === clipA)!.timing;
  api.apply(set(rate, {direction: 'reverse'}));
  const reverse = sourceFrames(store);
  assert.equal(reverse[0], 59);
  assert.equal(reverse.length, forward.length);
  assert.notDeepEqual(reverse, forward);
  api.apply(set(rate, {direction: 'forward', pitchShift: true}));
  assert.deepEqual(sourceFrames(store), forward);
  const current = saved(store).clips.find(item => item.id === clipA)!.timing;
  assert.equal(current?.profile, 'timeline-speed-v1');
  assert.equal(timing?.profile, 'timeline-speed-v1');
  assert.deepEqual(current.basis, timing.basis);
  const before = current;
  api.apply(set(rate, {pitchShift: false, interpolation: 'optical'}));
  const after = saved(store).clips.find(item => item.id === clipA)!.timing;
  assert.equal(after?.profile, 'timeline-speed-v1');
  assert.deepEqual(after, {...before, pitchShift: false});
});

test('freeze inserts one locked silent row at the first, middle and last playable frame', async t => {
  for (const atFrame of [0, 24, 59]) {
    await t.test(String(atFrame), t => {
      const store = fixture(t), api = editor(store);
      const before = saved(store);
      const request = api.apply({kind: 'freeze-frame', clipId: clipA, atFrame});
      const timeline = saved(store);
      const pieces = timeline.clips.filter(clip => clip.sequenceSource?.nodeId === shotA);
      assert.equal(pieces.length, atFrame === 0 ? 2 : 3);
      const frozen = pieces.find(clip => clip.timing?.profile === 'timeline-freeze-v1');
      assert.ok(frozen);
      assert.deepEqual(frozen.timing, {profile: 'timeline-freeze-v1', sourceFrame: atFrame, sourceVersionId: versionA, sourceSha256: sha('a')});
      assert.equal(frozen.startFrame, atFrame);
      assert.equal(frozen.durationFrames, 60);
      assert.equal(frozen.muted, true);
      assert.equal(frozen.sourceSpanFrames, 1);
      assert.equal(frozen.sequenceSource?.kind === 'shot' && frozen.sequenceSource.versionMode, 'locked');
      assert.equal(timeline.clips.find(clip => clip.id === clipB)?.startFrame, 120);
      assert.equal(timeline.clips.find(clip => clip.id === clipAudio)?.startFrame, 125);
      assert.equal(timeline.subtitles?.cues[0].startFrame, 126);
      const inserted = state(store);
      assert.deepEqual(request.replay(), request.receipt);
      assert.deepEqual(state(store), inserted);
      api.history('undo', request.receipt.actionId);
      assert.deepEqual(saved(store).clips, before.clips);
      api.history('redo', request.receipt.actionId);
      assert.deepEqual(saved(store).clips, timeline.clips);
    });
  }
});

test('timing of an auxiliary clip does not ripple the main track, and overlap is rejected atomically', t => {
  const store = fixture(t), api = editor(store);
  const before = state(store);
  api.apply(set(constant(2), {}, clipAudio));
  const after = state(store);
  assert.deepEqual(after.timeline.clips.filter(clip => clip.trackId === videoTrack), before.timeline.clips.filter(clip => clip.trackId === videoTrack));
  assert.equal(after.timeline.clips.find(clip => clip.id === clipAudio)?.durationFrames, 10);
  const preview = api.preview(set(constant(1, 10), {}, clipAudio));
  assert.ok('code' in preview);
  assert.equal(preview.code, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.deepEqual(new Set(preview.ids), new Set([clipAudio, clipAudio2]));
  assert.deepEqual(state(store), after);
});

test('a main-track speed change that would overlap a subtitle writes nothing', t => {
  const store = fixture(t), api = editor(store);
  const freeCue = id(89);
  const timeline = saved(store);
  store.tx(() => store.put('timelines', {...timeline, subtitles: {...timeline.subtitles!,
    cues: [...timeline.subtitles!.cues, {id: freeCue, text: 'Independent', startFrame: 36, durationFrames: 2, anchor: null}]}}));
  const before = state(store);
  const preview = api.preview(set(constant(2)));
  assert.ok('code' in preview);
  assert.equal(preview.code, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.deepEqual(new Set(preview.ids), new Set([freeCue, cueId]));
  assert.deepEqual(state(store), before);
});

test('static images and placeholders return their specific explicit failures', t => {
  const store = fixture(t), api = editor(store);
  for (const [clipId, code] of [[clipImage, 'SPEED_NOT_SUPPORTED'], [clipB, 'SPEED_SOURCE_NOT_READY']]) {
    assert.deepEqual(api.preview(set(constant(2), {}, clipId)), {ok: false, code, ids: [clipId]});
  }
});

test('separated audio inherits the mapped source window and a frozen clip cannot be unmuted', t => {
  const store = fixture(t), api = editor(store);
  api.apply(set(constant(1, 2), {direction: 'reverse'}));
  const before = saved(store).clips.find(clip => clip.id === clipA)!;
  const reviewed = api.service.preview({projectId: store.projectId, requestId: randomUUID(),
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId: clipA}}});
  assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
  api.service.commit({projectId: store.projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest});
  const timeline = saved(store);
  const separated = timeline.clips.find(clip => clip.soundOnly);
  assert.ok(separated);
  assert.deepEqual(separated.timing, before.timing);
  assert.equal(separated.sourceInFrame, before.sourceInFrame);
  assert.equal(separated.sourceSpanFrames, before.sourceSpanFrames);
  assert.equal(separated.durationFrames, before.durationFrames);
  assert.equal(timeline.clips.find(clip => clip.id === clipA)!.muted, true);

  api.history('undo', reviewed.envelope.actionId);
  const firstSourceFrame = sourceFrames(store)[0];
  api.apply({kind: 'freeze-frame', clipId: clipA, atFrame: 0});
  const frozen = saved(store).clips.find(clip => clip.timing?.profile === 'timeline-freeze-v1')!;
  assert.equal(frozen.sourceInFrame, firstSourceFrame);
  const unmute = api.service.preview({projectId: store.projectId, requestId: randomUUID(),
    propertiesIntent: {side: 'timeline', operation: {kind: 'clip-properties', edits: [{clipId: frozen.id, patch: {muted: false}}]}}});
  assert.ok('code' in unmute);
  assert.equal(unmute.code, 'SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID');
});

test('following versions are checked against the visible source window, including the last output interval', t => {
  const store = fixture(t), api = editor(store);
  const shortVersion = id(22), fittingVersion = id(23);
  store.tx(() => {
    for (const [versionId, assetId, jobId, frames] of [[shortVersion, id(15), id(72), 59], [fittingVersion, id(16), id(73), 45]] as const) {
      store.put('assets', {id: assetId, projectId: store.projectId, mimeType: 'video/mp4', duration: frames / 30, sha256: sha('f')});
      store.put('versions', {id: versionId, projectId: store.projectId, shotId: shotA, assetId, jobId,
        number: 2, sha256: sha('f'), createdAt: at});
    }
  });
  function run(operation: unknown): SequenceEditReceipt {
    const reviewed = api.service.preview({projectId: store.projectId, requestId: randomUUID(), intents: [operation]});
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    const receipt = api.service.commit({projectId: store.projectId, envelope: reviewed.envelope,
      expectedPlanDigest: reviewed.planDigest}) as SequenceEditReceipt;
    assert.equal(receipt.status, 'applied');
    return receipt;
  }
  const follow = (versionId: string, frames: number) => run({side: 'board', operation: {
    kind: 'board-version', nodeId: shotA, version: {id: versionId, sourceFrames: frames},
  }});
  api.apply(set(constant(10)));
  const first = saved(store).clips.find(clip => clip.id === clipA)!;
  assert.equal(first.durationFrames, 6);
  const rejected = follow(shortVersion, 59);
  assert.equal(rejected.warnings?.[0]?.code, 'SOURCE_TOO_SHORT');
  assert.equal(saved(store).clips.find(clip => clip.id === clipA)?.versionId, versionA);
  run({side: 'timeline', operation: {kind: 'track', edit: {kind: 'trim', clipId: clipA, durationFrames: 4}}});
  const trimmed = saved(store).clips.find(clip => clip.id === clipA)!;
  assert.equal(trimmed.sourceSpanFrames, 40);
  follow(fittingVersion, 45);
  const result = saved(store).clips.find(clip => clip.id === clipA)!;
  assert.equal(result.versionId, fittingVersion);
  assert.deepEqual(result.timing, trimmed.timing);
});

test('shortening a speed clip clips its volume envelope and interpolates the new endpoint', t => {
  const store = fixture(t), api = editor(store);
  const volumeEnvelope = {profileId: VOLUME_ENVELOPE_PROFILE,
    points: [{frame: 0, multiplier: 1}, {frame: 20, multiplier: 0.5}, {frame: 60, multiplier: 0}]};
  api.properties(clipA, {volumeEnvelope});
  const shortened = api.apply(set(constant(2)));
  const clip = saved(store).clips.find(item => item.id === clipA)!;
  assert.equal(clip.durationFrames, 30);
  assert.deepEqual(clip.volumeEnvelope, {...volumeEnvelope,
    points: [{frame: 0, multiplier: 1}, {frame: 20, multiplier: 0.5}, {frame: 30, multiplier: 0.375}]});
  api.history('undo', shortened.receipt.actionId);
  assert.deepEqual(saved(store).clips.find(item => item.id === clipA)?.volumeEnvelope, volumeEnvelope);
});

test('a long retimed clip keeps effects when edited, replaced and separated', t => {
  const store = fixture(t), api = editor(store);
  const longClip = id(91), longAsset = id(18), replacementAsset = id(19);
  const timeline = saved(store);
  const source: Format5Clip = {id: longClip, trackId: videoTrack2, name: 'Long video', assetId: longAsset,
    sourceState: 'ready', sourceInFrame: 0, startFrame: 0, durationFrames: 2_000, gain: 1, anchor: null,
    rect: {x: 0, y: 0, width: timeline.width, height: timeline.height}};
  store.tx(() => {
    for (const [assetId, letter] of [[longAsset, 'f'], [replacementAsset, '9']]) {
      store.put('assets', {id: assetId, projectId: store.projectId, mimeType: 'video/mp4', duration: 70, hasAudio: true, sha256: sha(letter)});
    }
    store.put('timelines', {...timeline, durationFrames: source.durationFrames, clips: [...timeline.clips, source]});
  });
  const transform = {profileId: CLIP_TRANSFORM_PROFILE, keyframes: [{frame: 0, x: 0, y: 0, scale: 1}],
    rotation: 0, crop: {left: 0, top: 0, right: 0, bottom: 0}};
  const volumeEnvelope = {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 1}, {frame: 2_000, multiplier: 0}]};
  api.properties(longClip, {transform, volumeEnvelope});

  api.apply(set(constant(1, 10), {}, longClip));
  const slowed = saved(store).clips.find(clip => clip.id === longClip)!;
  assert.equal(slowed.durationFrames, 20_000);
  assert.ok(slowed.durationFrames > VOLUME_ENVELOPE_LIMITS.frames);
  assert.deepEqual(slowed.volumeEnvelope, volumeEnvelope);
  assert.deepEqual(slowed.transform, transform);
  const editedTransform = {...transform, keyframes: [...transform.keyframes, {frame: 19_000, x: 10, y: 0, scale: 1}]};
  const editedEnvelope = {...volumeEnvelope, points: [...volumeEnvelope.points, {frame: 19_000, multiplier: 0.5}]};
  api.properties(longClip, {transform: editedTransform, volumeEnvelope: editedEnvelope});
  api.properties(longClip, {sourceReplacement: {assetId: replacementAsset}});

  const replaced = saved(store).clips.find(clip => clip.id === longClip)!;
  assert.equal(replaced.assetId, replacementAsset);
  assert.deepEqual(replaced.timing, slowed.timing);
  assert.deepEqual(replaced.transform, editedTransform);
  assert.deepEqual(replaced.volumeEnvelope, editedEnvelope);
  const reviewed = api.service.preview({projectId: store.projectId, requestId: randomUUID(),
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId: longClip}}});
  assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
  api.service.commit({projectId: store.projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest});
  const separated = saved(store).clips.find(clip => clip.soundOnly && clip.assetId === replacementAsset);
  assert.ok(separated);
  assert.equal(separated.durationFrames, 20_000);
  assert.deepEqual(separated.timing, replaced.timing);
  assert.deepEqual(separated.volumeEnvelope, editedEnvelope);
});
