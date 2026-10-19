import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineAudioFadeFilters } from '../packages/business/src/timeline-audio.ts';

test('legacy omitted and explicit zero fades preserve the old audio graph byte for byte', () => {
  const clip = { startFrame: 30, durationFrames: 120 };
  assert.equal(timelineAudioFadeFilters(clip, 60), '');
  assert.equal(timelineAudioFadeFilters({ ...clip, fadeInFrames: 0, fadeOutFrames: 0 }, 60), '');
  assert.deepEqual(clip, { startFrame: 30, durationFrames: 120 });
});

test('fade graph anchors each render segment in whole-clip integer sample time', () => {
  const clip = { startFrame: 30, durationFrames: 120, fadeInFrames: 30, fadeOutFrames: 30 };
  assert.equal(timelineAudioFadeFilters(clip, 30), 'asettb=1/48000,asetpts=N+0,afade=t=in:ss=0:ns=48000:curve=tri,afade=t=out:ss=144000:ns=48000:curve=tri,');
  assert.equal(timelineAudioFadeFilters(clip, 45), 'asettb=1/48000,asetpts=N+24000,afade=t=in:ss=0:ns=48000:curve=tri,afade=t=out:ss=144000:ns=48000:curve=tri,');
  assert.equal(timelineAudioFadeFilters(clip, 135), 'asettb=1/48000,asetpts=N+168000,afade=t=in:ss=0:ns=48000:curve=tri,afade=t=out:ss=144000:ns=48000:curve=tri,');
});

test('one-frame and meeting fades use exact sample counts without a second envelope', () => {
  assert.equal(timelineAudioFadeFilters({ startFrame: 0, durationFrames: 1, fadeOutFrames: 1 }, 0), 'asettb=1/48000,asetpts=N+0,afade=t=out:ss=0:ns=1600:curve=tri,');
  assert.equal(timelineAudioFadeFilters({ startFrame: 0, durationFrames: 60, fadeInFrames: 30, fadeOutFrames: 30 }, 30), 'asettb=1/48000,asetpts=N+48000,afade=t=in:ss=0:ns=48000:curve=tri,afade=t=out:ss=48000:ns=48000:curve=tri,');
});
