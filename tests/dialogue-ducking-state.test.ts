import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVolumeEnvelope, createVolumeEnvelopeEvaluator, VOLUME_ENVELOPE_PROFILE } from '../packages/contracts/src/timeline-volume-envelope.ts';
import { DEFAULT_DIALOGUE_DUCKING, DIALOGUE_DUCKING_REGION_LIMIT, dialogueActivity, dialogueDuckingCandidate, dialogueDuckingEnvelope, dialogueDuckingRegions,
  dialogueTrackChoices, dialogueWaveformRequests } from '../apps/web/src/dialogue-ducking-state.ts';
import type { DuckingClip } from '../apps/web/src/dialogue-ducking-state.ts';

const music: DuckingClip = { id: 'music', trackId: 'bed', assetId: 'song', startFrame: 30, durationFrames: 300 };
const loud = 10 ** (-12 / 20), quiet = 10 ** (-50 / 20);
const numeric = (envelope: ReturnType<typeof dialogueDuckingEnvelope>) => envelope && { profileId: envelope.profileId, points: envelope.points.map(point => ({ frame: Number(point.frame), multiplier: Number(point.multiplier) })) };

test('dialogue tracks are the other tracks under the background clip, preferring human voice', () => {
  const clips: DuckingClip[] = [music, { id: 'fx', trackId: 'sfx', assetId: 'a', startFrame: 40, durationFrames: 10 },
    { id: 'line', trackId: 'voice', assetId: 'b', startFrame: 50, durationFrames: 60, audioRole: 'human' }, { id: 'later', trackId: 'late', assetId: 'c', startFrame: 400, durationFrames: 30 }];
  const tracks = [{ id: 'bed' }, { id: 'sfx' }, { id: 'voice' }, { id: 'late' }];
  assert.deepEqual(dialogueTrackChoices(music, clips, tracks), { tracks: [{ id: 'sfx' }, { id: 'voice' }], preferred: 'voice' });
  assert.deepEqual(dialogueTrackChoices(music, [music], tracks), { tracks: [], preferred: null });
});

test('each dialogue clip is read only where it lies under the background clip, at up to one peak per frame', () => {
  const clips: DuckingClip[] = [{ id: 'a', trackId: 'voice', assetId: 'x', startFrame: 0, durationFrames: 60, sourceInFrame: 100 },
    { id: 'b', trackId: 'voice', assetId: 'y', startFrame: 300, durationFrames: 90 }, { id: 'c', trackId: 'other', assetId: 'z', startFrame: 40, durationFrames: 20 }];
  assert.deepEqual(dialogueWaveformRequests(music, clips, 'voice'), [
    { clipId: 'a', assetId: 'x', sourceStartFrame: 130, sourceEndFrame: 160, points: 30 },
    { clipId: 'b', assetId: 'y', sourceStartFrame: 0, sourceEndFrame: 30, points: 30 },
  ]);
});

test('activity maps peaks through the source offset and treats missing coverage as silence', () => {
  const clip: DuckingClip = { id: 'a', trackId: 'voice', assetId: 'x', startFrame: 100, durationFrames: 10, sourceInFrame: 50 };
  const peaks = [quiet, loud, loud, quiet, null, null, loud, quiet, quiet, quiet];
  assert.deepEqual(dialogueActivity(clip, { clipId: 'a', sourceStartFrame: 50, sourceEndFrame: 60, peaks }, -35), { intervals: [[101, 103], [106, 107]], missingFrames: 2 });
  assert.deepEqual(dialogueActivity(clip, { clipId: 'a', sourceStartFrame: 50, sourceEndFrame: 60, peaks }, -10).intervals, [], 'a higher threshold hears nothing');
  // Two frames per peak, so a peak's span rounds outwards to whole frames.
  assert.deepEqual(dialogueActivity(clip, { clipId: 'a', sourceStartFrame: 50, sourceEndFrame: 60, peaks: [quiet, loud, quiet, quiet, quiet] }, -35).intervals, [[102, 104]]);
});

test('regions pad speech, put ramps outside it, merge touching ramps and clamp to the clip', () => {
  const parameters = { ...DEFAULT_DIALOGUE_DUCKING, paddingFrames: 5, attackFrames: 10, releaseFrames: 20 };
  assert.deepEqual(dialogueDuckingRegions([[100, 130]], music, parameters).regions, [{ attackStart: 55, lowStart: 65, lowEnd: 105, releaseEnd: 125 }]);
  assert.deepEqual(dialogueDuckingRegions([[100, 130], [150, 160]], music, parameters).regions, [{ attackStart: 55, lowStart: 65, lowEnd: 135, releaseEnd: 155 }], 'touching ramps merge');
  assert.deepEqual(dialogueDuckingRegions([[0, 40], [320, 400]], music, parameters).regions,
    [{ attackStart: 0, lowStart: 0, lowEnd: 15, releaseEnd: 35 }, { attackStart: 275, lowStart: 285, lowEnd: 300, releaseEnd: 300 }], 'edges stay ducked');
  assert.deepEqual(dialogueDuckingRegions([[500, 600]], music, parameters).regions, [], 'speech outside the clip is ignored');
});

test('beyond four regions the shortest gaps are bridged', () => {
  const parameters = { ...DEFAULT_DIALOGUE_DUCKING, paddingFrames: 0, attackFrames: 2, releaseFrames: 2 };
  const speech: [number, number][] = [[40, 45], [60, 65], [70, 75], [120, 125], [200, 205], [280, 285]];
  const { regions, bridged } = dialogueDuckingRegions(speech, music, parameters);
  assert.equal(regions.length, DIALOGUE_DUCKING_REGION_LIMIT);
  assert.equal(bridged, 2);
  assert.deepEqual(regions.map(region => [region.lowStart, region.lowEnd]), [[10, 45], [90, 95], [170, 175], [250, 255]]);
});

test('the envelope is a valid replacement within the 16-point profile and ducks exactly the regions', () => {
  const parameters = { ...DEFAULT_DIALOGUE_DUCKING, multiplier: 0.2, paddingFrames: 0, attackFrames: 4, releaseFrames: 6 };
  const speech: [number, number][] = [[40, 50], [100, 110], [160, 170], [220, 230], [280, 290]];
  const { regions } = dialogueDuckingRegions(speech, music, parameters);
  const envelope = numeric(dialogueDuckingEnvelope(regions, music.durationFrames, parameters.multiplier))!;
  assert.ok(envelope.points.length <= 16);
  assert.equal(validateVolumeEnvelope(envelope, music.durationFrames), envelope);
  const curve = createVolumeEnvelopeEvaluator({ durationFrames: music.durationFrames, volumeEnvelope: envelope });
  for (const region of regions) {
    assert.equal(curve.limitAtSample(region.lowStart * 1600), 0.2);
    assert.equal(curve.limitAtSample(region.lowEnd * 1600), 0.2);
    if (region.attackStart > 0) assert.equal(curve.limitAtSample((region.attackStart - 1) * 1600), 1);
  }
  assert.equal(dialogueDuckingEnvelope([], 300, 0.2), null);
  assert.deepEqual(numeric(dialogueDuckingEnvelope([{ attackStart: 0, lowStart: 0, lowEnd: 300, releaseEnd: 300 }], 300, 0.3)),
    { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: 0, multiplier: 0.3 }, { frame: 300, multiplier: 0.3 }] }, 'speech over the whole clip ducks it all');
});

test('the candidate combines every read and reports bridges and missing coverage', () => {
  const dialogue: DuckingClip[] = [{ id: 'a', trackId: 'voice', assetId: 'x', startFrame: 60, durationFrames: 10 }, { id: 'b', trackId: 'voice', assetId: 'y', startFrame: 200, durationFrames: 10 }];
  const reads = [{ clipId: 'a', sourceStartFrame: 0, sourceEndFrame: 10, peaks: Array(10).fill(loud) }, { clipId: 'b', sourceStartFrame: 0, sourceEndFrame: 10, peaks: [null, ...Array(9).fill(quiet)] }];
  const candidate = dialogueDuckingCandidate(music, dialogue, reads, DEFAULT_DIALOGUE_DUCKING);
  assert.equal(candidate.speechCount, 1);
  assert.equal(candidate.missingFrames, 1);
  assert.equal(candidate.bridged, 0);
  assert.deepEqual(candidate.regions, [{ attackStart: 18, lowStart: 24, lowEnd: 46, releaseEnd: 61 }]);
  assert.ok(candidate.envelope);
  assert.equal(dialogueDuckingCandidate(music, dialogue, [reads[1]], DEFAULT_DIALOGUE_DUCKING).envelope, null, 'no speech, nothing to apply');
});
