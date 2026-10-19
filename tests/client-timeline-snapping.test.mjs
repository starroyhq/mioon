import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SNAP_THRESHOLD_PX,
  MAX_TIMELINE_FRAME,
  assetTimelineDuration,
  snapTimelinePosition,
  timelineDropPreview,
} from '../apps/web/src/timeline-snapping.js';

const videoTrack = { id: 'video-track', kind: 'video' };
const audioTrack = { id: 'audio-track', kind: 'audio' };
const videoAsset = { id: 'video', mimeType: 'video/mp4', duration: 1 };
const audioAsset = { id: 'audio', mimeType: 'audio/wav', duration: 1 };
const imageAsset = { id: 'image', mimeType: 'image/png' };
const clip = (patch = {}) => ({ id: 'clip', assetId: 'video', trackId: videoTrack.id, startFrame: 300, durationFrames: 30, sourceInFrame: 0, ...patch });
const timeline = (clips = []) => ({ id: 'timeline', projectId: 'project', revision: 7, fps: 30, tracks: [videoTrack, audioTrack], clips });
const snap = (patch = {}) => snapTimelinePosition({ pointerFrame: 200, durationFrames: 30, pixelsPerFrame: 1, playhead: 1500, ...patch });
const preview = (patch = {}) => timelineDropPreview({ timeline: timeline(), track: videoTrack, asset: videoAsset, pointerFrame: 200, pixelsPerFrame: 1, playhead: 1500, enabled: true, ...patch });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, message || `${actual} should be near ${expected}`);

for (const movingEdge of ['start', 'end']) {
  for (const targetEdge of ['start', 'end']) {
    test(`${movingEdge} edge snaps to another clip's ${targetEdge} boundary`, () => {
      const target = clip({ durationFrames: 100 });
      const targetFrame = targetEdge === 'start' ? 300 : 400;
      const startFrame = targetFrame - (movingEdge === 'end' ? 30 : 0);
      const result = snap({ pointerFrame: startFrame + 2.25, clips: [target] });
      assert.equal(result.startFrame, startFrame);
      assert.equal(result.snap.edge, movingEdge);
      assert.equal(result.snap.kind, 'clip');
      assert.equal(result.snap.id, target.id);
      assert.equal(result.snap.frame, targetFrame);
      assert.equal(result.snap.label, targetEdge === 'start' ? '片段起点' : '片段终点');
      assert.equal(result.snap.distance, 2.25);
    });
  }
}

test('clip boundaries are available across tracks and media types', () => {
  for (const target of [
    clip({ id: 'video', trackId: 'other-video' }),
    clip({ id: 'image', assetId: 'image', trackId: 'image-lane' }),
    clip({ id: 'audio', assetId: 'audio', trackId: audioTrack.id }),
  ]) {
    const result = snap({ pointerFrame: 301, clips: [target] });
    assert.equal(result.snap.id, target.id);
    assert.equal(result.startFrame, 300);
  }
});

test('moving clip excludes both its own boundaries, but retains other coincident boundaries', () => {
  const moving = clip();
  for (const pointerFrame of [302, 332]) {
    assert.equal(snap({ pointerFrame, clips: [moving], excludeClipId: moving.id }).snap, null);
  }
  const result = snap({ pointerFrame: 302, clips: [moving, clip({ id: 'other' })], excludeClipId: moving.id });
  assert.equal(result.snap.id, 'other');
  assert.equal(result.startFrame, 300);
});

test('zero and playhead are targets for eligible moving edges', () => {
  assert.equal(SNAP_THRESHOLD_PX, 8);
  const zero = snap({ pointerFrame: 3, playhead: 0 });
  assert.equal(zero.startFrame, 0);
  assert.equal(zero.snap.kind, 'zero');
  assert.equal(zero.snap.edge, 'start');
  for (const [pointerFrame, expectedStart, edge] of [[503, 500, 'start'], [473, 470, 'end']]) {
    const result = snap({ pointerFrame, playhead: 500 });
    assert.equal(result.startFrame, expectedStart);
    assert.equal(result.snap.kind, 'playhead');
    assert.equal(result.snap.frame, 500);
    assert.equal(result.snap.edge, edge);
  }
});

for (const pixelsPerSecond of [28, 76, 220]) {
  test(`the snap radius remains exactly eight screen pixels at ${pixelsPerSecond} px/sec`, () => {
    const pixelsPerFrame = pixelsPerSecond / 30;
    for (const edge of ['start', 'end']) {
      const target = clip({ startFrame: 1000, durationFrames: 300 });
      const expectedStart = edge === 'start' ? 1000 : 970;
      for (const direction of [-1, 1]) {
        for (const distancePx of [7.999, 8]) {
          const result = snap({ pointerFrame: expectedStart + direction * distancePx / pixelsPerFrame, pixelsPerFrame, clips: [target] });
          assert.equal(result.startFrame, expectedStart);
          assert.equal(result.snap.edge, edge);
          near(result.snap.distance, distancePx);
          near(Math.abs(result.startFrame - (expectedStart + direction * distancePx / pixelsPerFrame)) * pixelsPerFrame, distancePx);
        }
        const pointerFrame = expectedStart + direction * 8.001 / pixelsPerFrame;
        const outside = snap({ pointerFrame, pixelsPerFrame, clips: [target] });
        assert.equal(outside.snap, null, `${edge} ${direction}: a rounded nearby frame must not widen the radius`);
        assert.equal(outside.startFrame, Math.round(pointerFrame));
      }
    }
  });
}

test('nearest distance wins before edge preference, with deterministic equal-distance edge ties', () => {
  const nearest = snap({ pointerFrame: 100, playhead: 131, clips: [clip({ startFrame: 97, durationFrames: 200 })] });
  assert.equal(nearest.startFrame, 101);
  assert.equal(nearest.snap.edge, 'end');
  assert.equal(nearest.snap.kind, 'playhead');
  const tie = snap({ pointerFrame: 100, playhead: 132, clips: [clip({ startFrame: 98, durationFrames: 200 })] });
  assert.equal(tie.startFrame, 98);
  assert.equal(tie.snap.edge, 'start');
});

test('equal-distance candidates prefer earlier targets, then target kind, then stable clip ID', () => {
  const earlier = snap({ pointerFrame: 300, clips: [clip({ id: 'later', startFrame: 304, durationFrames: 100 }), clip({ id: 'earlier', startFrame: 296, durationFrames: 100 })] });
  assert.equal(earlier.snap.id, 'earlier');
  const playhead = snap({ pointerFrame: 302, playhead: 300, clips: [clip()] });
  assert.equal(playhead.snap.kind, 'playhead');
  const zero = snap({ pointerFrame: 2, playhead: 0, clips: [clip({ startFrame: 0 })] });
  assert.equal(zero.snap.kind, 'zero');
  const sameBoundary = [clip({ id: 'z-clip' }), clip({ id: 'a-clip' }), clip({ id: 'm-clip' })];
  for (const ordered of [sameBoundary, [...sameBoundary].reverse(), [sameBoundary[1], sameBoundary[0], sameBoundary[2]]]) {
    const result = snap({ pointerFrame: 302, clips: ordered });
    assert.equal(result.snap.id, 'a-clip');
    assert.equal(result.startFrame, 300);
  }
});

test('fractional grab offsets are preserved until final position rounding or snapping', () => {
  const freely = snap({ pointerFrame: 222.4, grabFrame: 12.75, enabled: false });
  assert.equal(freely.startFrame, 210);
  assert.equal(freely.snap, null);
  const snapped = snap({ pointerFrame: 315.125, grabFrame: 12.75, clips: [clip()] });
  assert.equal(snapped.startFrame, 300);
  assert.equal(snapped.snap.distance, 2.375);
  const atOriginalPosition = snap({ pointerFrame: 312.75, grabFrame: 12.75, enabled: false });
  assert.equal(atOriginalPosition.startFrame, 300);
});

test('lane-relative viewport coordinates preserve clip placement through horizontal scroll and zoom', () => {
  // getBoundingClientRect() already incorporates scroll. The track label is
  // outside the lane; adding scrollLeft or subtracting its width again is wrong.
  for (const pixelsPerSecond of [28, 76, 220]) {
    const pixelsPerFrame = pixelsPerSecond / 30;
    for (const scrollLeft of [0, 127.5, 960]) {
      const viewportLeft = 41, trackLabelWidth = 160;
      const laneLeft = viewportLeft + trackLabelWidth - scrollLeft;
      const grabFrame = 12.75, desiredStart = 300.25;
      const clientX = laneLeft + (desiredStart + grabFrame) * pixelsPerFrame;
      const pointerFrame = (clientX - laneLeft) / pixelsPerFrame;
      const result = snap({ pointerFrame, grabFrame, pixelsPerFrame, enabled: false });
      assert.equal(result.startFrame, 300);
      near(pointerFrame - grabFrame, desiredStart);
    }
  }
});

test('free placement clamps the whole duration within zero and 18000 frames', () => {
  assert.equal(MAX_TIMELINE_FRAME, 18000);
  for (const durationFrames of [1, 30, 90, 17999, 18000]) {
    const maxStart = 18000 - durationFrames;
    for (const pointerFrame of [-100.5, 18099.25]) {
      const result = snap({ pointerFrame, durationFrames, enabled: false });
      assert.equal(result.startFrame, pointerFrame < 0 ? 0 : maxStart);
      assert.equal(result.bounded, true);
      assert.ok(result.startFrame + durationFrames <= 18000);
    }
    for (const pointerFrame of [0, maxStart]) {
      const result = snap({ pointerFrame, durationFrames, enabled: false });
      assert.equal(result.startFrame, pointerFrame);
      assert.equal(result.bounded, false);
    }
  }
  const fractional = snap({ pointerFrame: 17970.49, durationFrames: 30, enabled: false });
  assert.equal(fractional.startFrame, 17970);
  assert.equal(fractional.bounded, true);
});

test('snap candidates cannot pull the clip before zero or past its duration-aware upper limit', () => {
  const beforeZero = snap({ pointerFrame: 2, playhead: 29, durationFrames: 30 });
  assert.equal(beforeZero.startFrame, 0);
  assert.equal(beforeZero.snap.kind, 'zero');
  const upper = snap({ pointerFrame: 17969, playhead: 18000, durationFrames: 30 });
  assert.equal(upper.startFrame, 17970);
  assert.equal(upper.snap.edge, 'end');
  assert.equal(upper.snap.frame, 18000);
  const beyond = snap({ pointerFrame: 17980, playhead: 18001, durationFrames: 30 });
  assert.equal(beyond.startFrame, 17970);
  assert.equal(beyond.snap, null);
  assert.equal(beyond.bounded, true);
});

test('Alt and the persisted toggle independently bypass snapping without bypassing frame clamps', () => {
  for (const patch of [{ enabled: false }, { altKey: true }, { enabled: false, altKey: true }]) {
    const result = snap({ pointerFrame: 302.25, clips: [clip()], ...patch });
    assert.equal(result.startFrame, 302);
    assert.equal(result.snap, null);
    assert.equal(snap({ pointerFrame: -3, ...patch }).startFrame, 0);
    assert.equal(snap({ pointerFrame: 18010, ...patch }).startFrame, 17970);
  }
  const restored = snap({ pointerFrame: 302.25, clips: [clip()], enabled: true, altKey: false });
  assert.equal(restored.startFrame, 300);
});

test('invalid pixel scales and malformed target frames cannot create snap candidates', () => {
  for (const pixelsPerFrame of [0, -1, NaN, Infinity]) {
    const result = snap({ pointerFrame: 302.25, clips: [clip()], pixelsPerFrame });
    assert.equal(result.startFrame, 302);
    assert.equal(result.snap, null);
  }
  for (const frame of [-1, 300.5, NaN, Infinity, '300', 18001]) {
    const result = snap({ pointerFrame: 302.25, playhead: frame, clips: [clip({ startFrame: frame, durationFrames: 30 })] });
    assert.equal(result.startFrame, 302);
    assert.equal(result.snap, null);
  }
});

test('a colliding nearest snap stays invalid instead of silently choosing a nearby free candidate', () => {
  const blocker = clip({ id: 'blocker', startFrame: 300, durationFrames: 6 });
  const result = preview({ timeline: timeline([blocker]), pointerFrame: 301 });
  assert.equal(result.startFrame, 300);
  assert.equal(result.snap.frame, 300);
  assert.equal(result.snap.edge, 'start');
  assert.equal(result.valid, false);
  assert.match(result.reason, /重叠/);
  // A legal snap at the blocker's end is only five pixels away, but is not
  // substituted for the selected one-pixel-away, invalid position.
  assert.equal(preview({ timeline: timeline([blocker]), pointerFrame: 306 }).valid, true);
});

test('type-incompatible drop retains its exact selected position and reports why it is invalid', () => {
  for (const [asset, track] of [[videoAsset, audioTrack], [imageAsset, audioTrack], [audioAsset, videoTrack]]) {
    const result = preview({ asset, track, timeline: timeline([clip({ trackId: 'somewhere-else' })]), pointerFrame: 302 });
    assert.equal(result.startFrame, 300);
    assert.equal(result.snap.frame, 300);
    assert.equal(result.valid, false);
    assert.match(result.reason, /类型.*不兼容/);
  }
});

test('same-track overlap is strict: touching boundaries and overlap on another track remain legal', () => {
  const blocker = clip();
  const state = timeline([blocker]);
  for (const pointerFrame of [270, 330]) assert.equal(preview({ timeline: state, pointerFrame, enabled: false }).valid, true);
  for (const pointerFrame of [271, 299, 300, 329]) {
    const result = preview({ timeline: state, pointerFrame, enabled: false });
    assert.equal(result.valid, false);
    assert.equal(result.startFrame, pointerFrame);
    assert.match(result.reason, /重叠/);
  }
  const anotherTrack = { id: 'other-video', kind: 'video' };
  assert.equal(preview({ timeline: state, track: anotherTrack, pointerFrame: 300 }).valid, true);
});

test('unchanged means the same clip start and track; self-overlap is excluded', () => {
  const moving = clip();
  const state = timeline([moving]);
  const same = preview({ timeline: state, clip: moving, pointerFrame: 312.75, grabFrame: 12.75 });
  assert.equal(same.startFrame, 300);
  assert.equal(same.valid, true);
  assert.equal(same.unchanged, true);
  assert.equal(same.snap, null);
  assert.equal(preview({ timeline: state, clip: moving, pointerFrame: 301, enabled: false }).unchanged, false);
  assert.equal(preview({ timeline: state, clip: moving, track: { id: 'other-video', kind: 'video' }, pointerFrame: 300 }).unchanged, false);
  assert.equal(preview({ pointerFrame: 300 }).unchanged, false);
});

test('images use a known 90-frame default even when duration metadata is absent or misleading', () => {
  for (const duration of [undefined, 0, 1.25, Infinity]) {
    const asset = { ...imageAsset, duration };
    const length = assetTimelineDuration(asset);
    assert.equal(length.durationFrames, 90);
    assert.equal(length.known, true);
    assert.match(length.note, /90/);
    const result = preview({ asset, pointerFrame: 17999, enabled: false });
    assert.equal(result.durationFrames, 90);
    assert.equal(result.startFrame, 17910);
    assert.equal(result.valid, true);
  }
});

test('known audio and video durations use source-safe 30-fps flooring, not rounding up', () => {
  for (const mimeType of ['audio/wav', 'video/mp4']) {
    for (const [duration, expectedFrames] of [[1 / 30, 1], [0.1 + 0.2, 9], [1.999, 59], [2.016, 60], [4.125, 123], [600, 18000]]) {
      const asset = { id: 'source', mimeType, duration };
      const length = assetTimelineDuration(asset);
      assert.equal(length.durationFrames, expectedFrames);
      assert.equal(length.known, true);
      const result = preview({ asset, track: mimeType.startsWith('audio/') ? audioTrack : videoTrack, pointerFrame: 18000, enabled: false });
      assert.equal(result.durationFrames, expectedFrames);
      assert.equal(result.startFrame, 18000 - expectedFrames);
      assert.equal(result.valid, true);
    }
  }
});

test('unknown or unusable source durations show a 60-frame illustration and honestly forbid placement', () => {
  for (const mimeType of ['audio/wav', 'video/mp4']) {
    for (const duration of [undefined, null, '2', 0, -1, NaN, Infinity, 0.01, Number.MAX_VALUE]) {
      const asset = { id: 'unknown', mimeType, duration };
      const length = assetTimelineDuration(asset);
      assert.equal(length.known, false, `${mimeType}, ${duration}`);
      assert.equal(length.durationFrames, 60);
      assert.match(length.note, /未知.*示意.*不能放置/);
      const result = preview({ asset, track: mimeType.startsWith('audio/') ? audioTrack : videoTrack, timeline: timeline([clip({ trackId: 'other' })]), pointerFrame: 302 });
      assert.equal(result.valid, false);
      assert.equal(result.known, false);
      assert.equal(result.startFrame, 302);
      assert.equal(result.snap, null);
      assert.match(result.reason, /未知.*不能放置/);
    }
  }
  assert.equal(assetTimelineDuration(null).known, false);
});

test('moving an existing trimmed clip retains its duration and source metadata rather than resetting defaults', () => {
  const moving = clip({ assetId: 'image', startFrame: 100, durationFrames: 45, sourceInFrame: 0 });
  const result = preview({ timeline: timeline([moving]), clip: moving, asset: imageAsset, pointerFrame: 200, enabled: false });
  assert.equal(result.durationFrames, 45);
  assert.equal(result.valid, true);
  const trimmed = clip({ durationFrames: 12, sourceInFrame: 18 });
  const before = structuredClone(trimmed);
  assert.equal(preview({ timeline: timeline([trimmed]), clip: trimmed, pointerFrame: 400 }).durationFrames, 12);
  assert.deepEqual(trimmed, before);
});

test('overlong sources and the 100-clip add limit are invalid, while moving existing clips stays allowed', () => {
  const long = preview({ asset: { ...videoAsset, duration: 18001 / 30 }, pointerFrame: 10 });
  assert.equal(long.durationFrames, 18001);
  assert.equal(long.valid, false);
  assert.equal(long.snap, null);
  assert.match(long.reason, /18000/);
  const clips = Array.from({ length: 100 }, (_, index) => clip({ id: `clip-${index}`, startFrame: index * 30 }));
  const full = timeline(clips);
  const add = preview({ timeline: full, pointerFrame: 4000 });
  assert.equal(add.valid, false);
  assert.match(add.reason, /100/);
  assert.equal(preview({ timeline: timeline(clips.slice(0, 99)), pointerFrame: 4000 }).valid, true);
  assert.equal(preview({ timeline: full, clip: clips[0], pointerFrame: 4000 }).valid, true);
});

test('missing drop dependencies are invalid, and previewing never mutates supplied state', () => {
  for (const patch of [{ asset: null }, { track: null }, { timeline: null }]) {
    const result = preview(patch);
    assert.equal(result.valid, false);
    assert.match(result.reason, /不可用/);
  }
  const state = timeline([clip()]);
  const before = structuredClone(state);
  preview({ timeline: state, pointerFrame: 302 });
  assert.deepEqual(state, before);
});

const timelineSource = readFileSync(new URL('../apps/web/src/Timeline.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');

test('Timeline integration uses lane-relative fractional coordinates, live Alt state and an accessible toggle', () => {
  assert.match(timelineSource, /const pointerFrame=timelinePointerFrameAtElement\(event.clientX,event.currentTarget,pxFrame\)/);
  assert.match(timelineSource, /timelinePointerFrameAtElement\(e.clientX,e.currentTarget,pxFrame\)/);
  assert.match(timelineSource, /const grabFrame = Math.max\(0,pointerFrame\)/);
  assert.match(timelineSource, /grabFrame: drag\.grabFrame \|\| 0/);
  assert.match(timelineSource, /enabled: snappingEnabled, altKey: event\.altKey/);
  const toolbar = readFileSync(new URL('../apps/web/src/TimelineToolbar.tsx', import.meta.url), 'utf8');
  assert.match(toolbar, /data-testid="timeline-snapping"/);
  assert.match(toolbar, /aria-pressed=\{props.snapping\}/);
  assert.match(timelineSource, /updateViewState\(\{snappingEnabled: !snappingEnabled\}\)/);
  assert.match(timelineSource, /window\.addEventListener\('keydown', modifier\); window\.addEventListener\('keyup', modifier\)/);
});

test('Timeline commits the displayed frame once, with unchanged, invalid, payload and stale-gesture gates', () => {
  const drop = timelineSource.slice(timelineSource.indexOf('async function drop('), timelineSource.indexOf('const stepSeconds'));
  assert.match(drop, /const value = previewRef\.current, session = gesture\.current, drag = activeDrag/);
  assert.match(drop, /value\?\.valid && value\.trackId === track\.id/);
  assert.match(drop, /session\?\.drag === drag && session\.projectId === timeline\.projectId && session\.revision === timeline\.revision/);
  assert.match(drop, /if \(!allowed \|\| !payloadMatches \|\| value\.unchanged\) return/);
  assert.match(drop, /expectedRevision: session\.revision, durationFrames: value\.durationFrames/);
  assert.match(drop, /onMoveClip\(drag\.id, track\.id, value\.startFrame, snapshot\)/);
  assert.match(drop, /onAddAsset\(drag\.id, track\.id, value\.startFrame, snapshot\)/);
  assert.doesNotMatch(drop, /timelineDropPreview\(|snapTimelinePosition\(|frameAt\(/);
  assert.match(timelineSource, /data-start-frame=\{preview\.startFrame\}/);
  assert.match(timelineSource, /data-snap-frame=\{preview\.snap\.frame\}/);
});

test('App forwards exact displayed position, duration and revision through existing durable timeline mutations', () => {
  assert.match(appSource, /const length = assetTimelineDuration\(asset\)/);
  assert.match(appSource, /if \(!length\.known\)/);
  assert.match(appSource, /const durationFrames = dropSnapshot\?\.durationFrames \?\? length\.durationFrames/);
  assert.match(appSource, /mutateTimeline\('timeline\.clip\.add', \{ trackId: track\.id, assetId, name: asset\.name, startFrame: start, durationFrames, sourceInFrame: 0 \}, dropSnapshot\?\.expectedRevision\)/);
  assert.match(appSource, /mutateTimeline\('timeline\.clip\.update', \{ clipId, patch: \{ trackId, startFrame \} \}, dropSnapshot\?\.expectedRevision\)/);
  assert.doesNotMatch(appSource, /snapTimelinePosition\(/);
});
