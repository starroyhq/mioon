import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createCoEditingCurrentValueReader} from '../packages/business/src/agent/co-editing-current-values.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';

const transform = {
  profileId: 'mioon-clip-transform-v1', rotation: 5, crop: {left: 0.1, right: 0.1, top: 0, bottom: 0},
  keyframes: [{frame: 0, x: 20, y: -10, scale: 1.5}],
};
const gainEnvelope = {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 1}, {frame: 30, multiplier: 0.5}]};

function fixture(t: test.TestContext) {
  const rootId = randomUUID(), shotId = randomUUID(), versionId = randomUUID();
  const clipId = randomUUID(), assetId = randomUUID(), archivedNodeId = randomUUID();
  const world = createChainWorld(t, {
    rootId,
    shots: [{id: shotId, title: 'Saved shot', versionId}],
    nodes: [{id: archivedNodeId, type: 'text', name: 'Archived draft'}],
    archived: [{table: 'nodes', id: archivedNodeId}],
    versions: [{versionId, assetId, sha256: 'a'.repeat(64), durationSeconds: 4, hasAudio: true}],
    clips: [{clipId, nodeId: shotId, startFrame: 0, durationFrames: 60, versionId}],
    edges: [{id: randomUUID(), fromId: rootId, toId: shotId}],
  });
  return {...world, shotId, clipId, assetId, archivedNodeId};
}

test('co-editing current values read only the fields of the saved clip group and subtitle', t => {
  const {store, timeline, mainTrackId, clipId} = fixture(t);
  const cueId = randomUUID(), anchor = {clipId, offsetFrames: 3};
  store.tx(() => {
    const clip = {...timeline.clips[0]!, gain: 0.25, transform, volumeEnvelope: gainEnvelope};
    store.put('timelines', {...timeline, clips: [clip], subtitles: {profileId: 'bottom_cjk_v1', cues: [
      {id: cueId, text: '已保存的字幕', startFrame: 3, durationFrames: 8, anchor},
    ]}});
    const current = createCoEditingCurrentValueReader(store);
    assert.deepEqual(current({kind: 'timeline_clip_audio', id: clipId}), {gain: 0.25, volumeEnvelope: gainEnvelope});
    assert.deepEqual(current({kind: 'timeline_clip_visual', id: clipId}), {rect: clip.rect, transform});
    assert.deepEqual(current({kind: 'timeline_clip_timing', id: clipId}),
      {trackId: mainTrackId, startFrame: 0, durationFrames: 60, sourceInFrame: 0});
    assert.deepEqual(current({kind: 'timeline_subtitle', id: cueId}),
      {text: '已保存的字幕', startFrame: 3, durationFrames: 8, anchor});
    assert.equal(current({kind: 'timeline_clip_audio', id: randomUUID()}), null);
  });
});

test('co-editing current values expose saved asset edits and hide other project data', t => {
  const {store, assetId, projectId, shotId, archivedNodeId} = fixture(t);
  const note = '片段来自主镜头\n保留这个备注';
  store.tx(() => {
    store.db.prepare('INSERT INTO project.asset_ranges(assetId,projectId,revision,inFrame,outFrame) VALUES(?,?,1,?,?)')
      .run(assetId, projectId, 12, 50);
    store.db.prepare('INSERT INTO project.asset_annotations(assetId,projectId,revision,tags,note) VALUES(?,?,1,?,?)')
      .run(assetId, projectId, JSON.stringify(['主镜头', '备选']), note);
    store.db.prepare('INSERT INTO project.asset_dispositions(assetId,projectId,revision,disposition) VALUES(?,?,1,?)')
      .run(assetId, projectId, 'favorite');
    const current = createCoEditingCurrentValueReader(store);
    assert.deepEqual(current({kind: 'asset_range', id: assetId}), {inFrame: 12, outFrame: 50});
    assert.deepEqual(current({kind: 'asset_annotation', id: assetId}), {tags: ['主镜头', '备选'], note});
    assert.deepEqual(current({kind: 'asset_disposition', id: assetId}), {disposition: 'favorite'});
    assert.deepEqual(current({kind: 'asset', id: assetId}), {name: 'source.mp4'});
    assert.equal(current({kind: 'shot', id: shotId})?.title, 'Saved shot');
    assert.equal(current({kind: 'node', id: archivedNodeId}), null);
    assert.equal(current({kind: 'job', id: assetId}), null);
    assert.equal(current({kind: 'constructor', id: assetId}), null);
    assert.equal(current({kind: 'asset_annotation', id: randomUUID()}), null);
  });
});
