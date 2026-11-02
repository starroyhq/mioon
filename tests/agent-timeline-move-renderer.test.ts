import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from '../apps/web/src/agent-timeline-context.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(4), clipId = id(5), trackId = id(6);
const at = '2026-10-12T00:00:00.000Z';
const selected = { projectId, timelineId, clipId, trackId, expectedRevision: 4, clipName: 'Saved clip <script>text</script>', trackName: 'First video track', trackKind: 'video', fps: 30, width: 720, height: 1280, startFrame: 90, endFrame: 150, durationFrames: 60, timelineDurationFrames: 150, occupiedIntervals: [{ startFrame: 0, endFrame: 30 }] };
test('saved timeline selection projects explicit safe timing, excludes sources and is detached from drafts', () => {
  const clip = { id: clipId, trackId, assetId: id(99), name: selected.clipName, startFrame: 90, durationFrames: 60, sourceInFrame: 12, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
  const timeline = { id: timelineId, projectId, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 150, createdAt: at, updatedAt: at, tracks: [{ id: trackId, name: selected.trackName, kind: 'video', orderIndex: 0, hidden: false, muted: false }], clips: [clip, { ...clip, id: id(98), name: 'Other name not transmitted', startFrame: 0, durationFrames: 30 }] };
  const result = timing.makeAgentTimelineClipSelection(timeline, clipId, projectId);
  assert.deepEqual(result, selected); assert.equal(Object.isFrozen(result.occupiedIntervals[0]), true);
  assert.doesNotMatch((JSON.stringify(result) as string), /assetId|sourceInFrame|Other name|gain|rect/);
  timeline.clips[0].startFrame = 100; assert.equal(result.startFrame, 90);
  assert.equal(timing.makeAgentTimelineClipSelection(timeline, clipId, id(77)), null);
});
