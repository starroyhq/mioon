// A complete, valid clip-transition acknowledgement for transport/recovery tests
// that iterate every timeline mutation. Two adjacent clips on a video track meet
// at frame 60, and the second one gains a dissolve.
const id = (n: number): string => `00000000-0000-4000-8000-${String(980 + n).padStart(12, '0')}`;
const at = '2026-10-29T00:00:00.000Z';
export interface ClipTransitionFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function clipTransitionFixture({projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): ClipTransitionFixture {
  // Separate copies, as on the wire: corrupting one never edits the others.
  const transition = () => ({profileId: 'mioon-clip-transition-v1', kind: 'dissolve', durationFrames: 20});
  const clip = (n: number, startFrame: number, extra: Record<string, unknown> = {}) => ({id: id(n), trackId: id(6), assetId: id(11), name: `Shot ${n}`, startFrame, durationFrames: 60,
    sourceInFrame: 30, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, ...extra});
  return {
    input: {projectId, expectedRevision, requestId, clipId: id(2), transition: transition()},
    response: {operation: 'timeline.clip.setTransition', requestId, timeline: {id: id(5), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
      tracks: [{id: id(6), name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [clip(1, 0), clip(2, 60, {transitionIn: transition()})], durationFrames: 120, createdAt: at, updatedAt: at},
      clipId: id(2), previousTransition: null, transition: transition()},
  };
}
