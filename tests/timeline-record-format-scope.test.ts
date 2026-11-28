import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMAT5_TIMELINE_FORMAT, FORMAT6_TIMELINE_FORMAT, isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse} from '../packages/contracts/src/timeline-acknowledgement.ts';

/** The format-5 clip sound flags are accepted only through the format-5
 * projection: callers state the storage format they validate. A released
 * format-3/4 timeline record that carries `muted` / `soundOnly` stays invalid,
 * exactly like before the clip sound card. */
const projectId = '93000000-0000-4000-8000-000000000001';
const timelineId = '93000000-0000-4000-8000-000000000002';
const trackId = '93000000-0000-4000-8000-000000000003';
const clipId = '93000000-0000-4000-8000-000000000004';
const assetId = '93000000-0000-4000-8000-000000000005';
const at = '2026-01-01T00:00:00.000Z';
const timeline = (track: {kind: 'video' | 'audio'}, clip: Record<string, unknown>) => ({
  id: timelineId, projectId, revision: 1, fps: 30, width: 720, height: 1280,
  tracks: [{id: trackId, name: track.kind === 'video' ? 'V1' : 'A1', kind: track.kind, orderIndex: 0,
    hidden: false, muted: false}],
  clips: [{id: clipId, trackId, assetId, name: 'Legacy clip', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, ...clip}],
  durationFrames: 30, createdAt: at, updatedAt: at,
});

test('a released format-3/4 record carrying muted is still rejected; the format-5 projection admits it', () => {
  const plain = timeline({kind: 'video'}, {});
  assert.equal(isTimelineRecord(plain, {projectId}), true, 'the plain released record is valid');
  const muted = timeline({kind: 'video'}, {muted: true});
  assert.equal(isTimelineRecord(muted, {projectId}), false, 'format 3/4 records must not carry muted');
  assert.equal(isTimelineRecord(muted, {projectId, format: 4}), false, 'naming format 4 explicitly stays closed');
  assert.equal(isTimelineRecord(muted, {projectId, format: FORMAT5_TIMELINE_FORMAT}), true,
    'the format-5 projection accepts its own optional muted flag');
  assert.equal(isTimelineRecord(muted, {projectId: '93000000-0000-4000-8000-000000000099', format: FORMAT5_TIMELINE_FORMAT}), false,
    'the format projection never weakens project binding');
});

test('a released format-3/4 record carrying soundOnly is still rejected; the format-5 projection requires its audio track', () => {
  const audioSoundOnly = timeline({kind: 'audio'}, {soundOnly: true});
  assert.equal(isTimelineRecord(audioSoundOnly, {projectId}), false, 'format 3/4 records must not carry soundOnly');
  assert.equal(isTimelineRecord(audioSoundOnly, {projectId, format: FORMAT5_TIMELINE_FORMAT}), true,
    'a format-5 audio-track clip may carry soundOnly');
  const videoSoundOnly = timeline({kind: 'video'}, {soundOnly: true});
  assert.equal(isTimelineRecord(videoSoundOnly, {projectId, format: FORMAT5_TIMELINE_FORMAT}), false,
    'soundOnly stays legal only on an audio track');
  const nonBoolean = timeline({kind: 'video'}, {muted: false});
  assert.equal(isTimelineRecord(nonBoolean, {projectId, format: FORMAT5_TIMELINE_FORMAT}), false,
    'only the true form is ever stored');
});

test('native clip receipts bind sound flags in both sequence formats and timing only in format 6', () => {
  const base = {projectId, expectedRevision: 1, requestId: 'native-format-receipt'};
  const record = {...timeline({kind: 'video'}, {muted: true}), revision: 2};
  for (const format of [FORMAT5_TIMELINE_FORMAT, FORMAT6_TIMELINE_FORMAT]) {
    assert.equal(isTimelineMutationResponse('timeline.clip.update', {...base, clipId, patch: {muted: true}}, record, {format}), true);
    assert.equal(isTimelineMutationResponse('timeline.clip.replaceSource', {...base, clipId, assetId}, record, {format}), true);
  }
  assert.equal(isTimelineMutationResponse('timeline.clip.update', {...base, clipId, patch: {muted: true}}, record, {format: 4}), false);
  const frozen = {...timeline({kind: 'video'}, {muted: true, gain: 0, sourceSpanFrames: 1, timing: {
    profile: 'timeline-freeze-v1', sourceFrame: 0, sourceVersionId: null, sourceSha256: 'ab'.repeat(32),
  }}), revision: 2};
  const gains = [{clipId, gain: 0}];
  const operation = 'timeline.clip.setGains';
  const receipt = {operation, requestId: base.requestId, timeline: frozen, gains: [{clipId, previousGain: 1, gain: 0}]};
  assert.equal(isTimelineMutationResponse(operation, {...base, gains}, receipt, {format: FORMAT6_TIMELINE_FORMAT}), true);
  assert.equal(isTimelineMutationResponse(operation, {...base, gains}, receipt, {format: FORMAT5_TIMELINE_FORMAT}), false);
});
