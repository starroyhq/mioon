import test from 'node:test';
import assert from 'node:assert/strict';
import {projectEditUi} from '../apps/web/src/edit-ui/projection.ts';
import type {EditUiClip, EditUiShotSource, EditUiTimeline} from '../apps/web/src/edit-ui/projection.ts';

const appliedVersion = {id: 'version-1', number: 1};
const boardVersion = {id: 'version-2', number: 2};
const shot: EditUiShotSource = {kind: 'shot', nodeId: 'shot-2', segmentGroupId: 'group-2',
  number: '02', name: 'Window silhouette', versionMode: 'follow', appliedVersion, boardVersion};
const mainClip: EditUiClip = {id: 'clip-2', trackId: 'track-main', startFrame: 0, durationFrames: 96,
  sourceInFrame: 0, sourceState: 'ready', sequenceSource: shot};
const scene: EditUiTimeline = {fps: 24, timelineRevision: 21, syncRevision: 8,
  mainTrack: {trackId: 'track-main', sequenceNodeId: 'film-1'},
  tracks: [{id: 'track-overlay', kind: 'video'}, {id: 'track-main', kind: 'video'}, {id: 'track-voice', kind: 'audio'}],
  clips: [mainClip], cues: []};

test('the explicit video binding and both revisions survive projection', () => {
  const result = projectEditUi(scene);
  assert.equal(result.mainTrackId, 'track-main');
  assert.equal(result.sequenceNodeId, 'film-1');
  assert.equal(result.timelineRevision, 21);
  assert.equal(result.syncRevision, 8);
  for (const mainTrack of [null, {trackId: 'track-voice', sequenceNodeId: 'film-1'},
    {trackId: 'missing', sequenceNodeId: 'film-1'}]) {
    const result = projectEditUi({...scene, mainTrack, cues: [{id: 'cue', startFrame: 12, anchor: null}]});
    assert.equal(result.mainTrackId, null);
    assert.equal(result.sequenceNodeId, null);
    assert.equal(result.clips.size, 0);
    assert.equal(result.cueAnchors.size, 0);
  }
});

test('shot title versions reflect applied media, with a distinct board version and ungenerated state', () => {
  const locked: EditUiClip = {...mainClip, id: 'locked', startFrame: 96, sequenceSource: {...shot, versionMode: 'locked'}};
  const placeholder: EditUiClip = {...mainClip, id: 'placeholder', startFrame: 192, sourceState: 'placeholder',
    sequenceSource: {...shot, nodeId: 'shot-3', segmentGroupId: 'group-3', appliedVersion: null, boardVersion: null}};
  const media: EditUiClip = {...mainClip, id: 'material', startFrame: 288,
    sequenceSource: {kind: 'media', nodeId: 'asset-node', segmentGroupId: 'group-material'}};
  const overlay: EditUiClip = {...mainClip, id: 'overlay', trackId: 'track-overlay'};
  const result = projectEditUi({...scene, clips: [mainClip, locked, placeholder, media, overlay]});
  assert.deepEqual(result.clips.get(mainClip.id), {shot, status: {kind: 'follow', version: boardVersion}});
  assert.deepEqual(result.clips.get(locked.id)?.status, {kind: 'locked', version: appliedVersion});
  assert.deepEqual(result.clips.get(locked.id)?.shot?.boardVersion, boardVersion);
  assert.deepEqual(result.clips.get(placeholder.id)?.status, {kind: 'placeholder', durationSeconds: 4});
  assert.equal(result.clips.get(placeholder.id)?.shot?.appliedVersion, null);
  assert.equal(result.clips.has(media.id), false);
  assert.equal(result.clips.has(overlay.id), false);
});

test('overlays and cues retain only explicit anchors that match the current half-open segment', () => {
  const right: EditUiClip = {...mainClip, id: 'right', startFrame: 96, sourceInFrame: 96};
  const invalid: EditUiClip = {...mainClip, id: 'invalid', startFrame: 192, sourceInFrame: -1};
  const overlay: EditUiClip = {id: 'overlay', trackId: 'track-overlay', startFrame: 105, durationFrames: 12,
    sourceInFrame: 0, anchor: {clipId: 'right', offsetFrames: 9}};
  const clips = [overlay, right, invalid, mainClip];
  const result = projectEditUi({...scene, clips, cues: [
    {id: 'attached-left', startFrame: 95, anchor: {clipId: mainClip.id, offsetFrames: 95}},
    {id: 'first-right', startFrame: 96, anchor: {clipId: 'right', offsetFrames: 0}},
    {id: 'past-left', startFrame: 96, anchor: {clipId: mainClip.id, offsetFrames: 96}},
    {id: 'no-match', startFrame: 96, anchor: {clipId: 'right', offsetFrames: 1}},
    {id: 'negative', startFrame: 95, anchor: {clipId: 'right', offsetFrames: -1}},
    {id: 'fractional', startFrame: 96.5, anchor: {clipId: 'right', offsetFrames: 0.5}},
    {id: 'off-track', startFrame: 105, anchor: {clipId: 'overlay', offsetFrames: 0}},
    {id: 'missing', startFrame: 24, anchor: {clipId: 'missing', offsetFrames: 24}},
    {id: 'invalid', startFrame: 192, anchor: {clipId: 'invalid', offsetFrames: 0}},
    {id: 'unspecified', startFrame: 24},
    {id: 'detached', startFrame: 24, anchor: null},
  ]});
  assert.deepEqual(result.clips.get(overlay.id)?.anchor, {kind: 'attached', clipId: 'right', startFrame: 105});
  assert.deepEqual([...result.cueAnchors], [
    ['attached-left', {kind: 'attached', clipId: mainClip.id, startFrame: 95}],
    ['first-right', {kind: 'attached', clipId: 'right', startFrame: 96}],
    ['detached', {kind: 'detached'}],
  ]);
  assert.deepEqual(clips.map(clip => clip.id), ['overlay', 'right', 'invalid', mainClip.id]);
});

test('explicit detachment stays visible after removal without adopting a new segment beneath it', () => {
  const overlay: EditUiClip = {id: 'overlay', trackId: 'track-overlay', startFrame: 12, durationFrames: 12,
    sourceInFrame: 0, anchor: null};
  const cue = {id: 'cue', startFrame: 12, anchor: null};
  for (const clips of [[overlay], [mainClip, overlay]]) {
    const result = projectEditUi({...scene, clips, cues: [cue]});
    assert.deepEqual(result.clips.get(overlay.id)?.anchor, {kind: 'detached'});
    assert.deepEqual(result.cueAnchors.get(cue.id), {kind: 'detached'});
    assert.equal(overlay.startFrame, 12);
    assert.equal(cue.startFrame, 12);
  }
});
