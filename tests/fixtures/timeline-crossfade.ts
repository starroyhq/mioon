// A complete, valid crossfade acknowledgement for transport/recovery tests that
// iterate every timeline mutation. Two audio clips on two tracks overlap for 30
// frames from frame 60; both carry the linear curves for that overlap.
const id = (n: number): string => `00000000-0000-4000-8000-${String(970 + n).padStart(12, '0')}`;
const at = '2026-10-28T00:00:00.000Z';
export interface CrossfadeFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function crossfadeFixture({projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): CrossfadeFixture {
  const profileId = 'mioon-clip-linear-attenuation-v1', rect = {x: 0, y: 0, width: 720, height: 1280};
  const clip = (n: number, trackId: string, startFrame: number, points: {frame: number; multiplier: number}[]) =>
    ({id: id(n), trackId, assetId: id(n + 10), name: 'Sound', startFrame, durationFrames: 90, sourceInFrame: 0, rect, gain: 1, volumeEnvelope: {profileId, points}});
  return {
    input: {projectId, expectedRevision, requestId, outgoingClipId: id(1), incomingClipId: id(2)},
    response: {operation: 'timeline.clip.crossfade', requestId,
      crossfade: {outgoingClipId: id(1), incomingClipId: id(2), startFrame: 60, durationFrames: 30},
      timeline: {id: id(5), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
        tracks: [{id: id(6), name: 'Audio 1', kind: 'audio', orderIndex: 0, hidden: false, muted: false},
          {id: id(7), name: 'Audio 2', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
        clips: [clip(1, id(6), 0, [{frame: 60, multiplier: 1}, {frame: 90, multiplier: 0}]), clip(2, id(7), 60, [{frame: 0, multiplier: 0}, {frame: 30, multiplier: 1}])],
        durationFrames: 150, createdAt: at, updatedAt: at}},
  };
}
