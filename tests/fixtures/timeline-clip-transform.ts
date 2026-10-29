// A complete, valid clip-transform acknowledgement for transport/recovery tests
// that iterate every timeline mutation. One clip on a video track gains a
// two-keyframe zoom with a small rotation and crop.
const id = (n: number): string => `00000000-0000-4000-8000-${String(970 + n).padStart(12, '0')}`;
const at = '2026-10-29T00:00:00.000Z';
export interface ClipTransformFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function clipTransformFixture({projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): ClipTransformFixture {
  // Separate copies, as on the wire: corrupting one never edits the others.
  const transform = () => ({profileId: 'mioon-clip-transform-v1', keyframes: [{frame: 0, x: 0, y: 0, scale: 1}, {frame: 59, x: -120, y: 40, scale: 1.5}],
    rotation: 5, crop: {left: 0.1, top: 0, right: 0.1, bottom: 0}});
  const clip = {id: id(1), trackId: id(6), assetId: id(11), name: 'Shot', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, transform: transform()};
  return {
    input: {projectId, expectedRevision, requestId, clipId: id(1), transform: transform()},
    response: {operation: 'timeline.clip.setTransform', requestId, timeline: {id: id(5), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
      tracks: [{id: id(6), name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [clip], durationFrames: 60, createdAt: at, updatedAt: at},
      clipId: id(1), previousTransform: null, transform: transform()},
  };
}
