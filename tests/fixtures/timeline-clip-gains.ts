// A complete, valid clip-gain acknowledgement for transport/recovery tests that
// iterate every timeline mutation. Two dialogue clips on one audio track move
// from gain 1 to 1.25 and 0.8.
const id = (n: number): string => `00000000-0000-4000-8000-${String(990 + n).padStart(12, '0')}`;
const at = '2026-10-29T00:00:00.000Z';
export interface ClipGainsFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function clipGainsFixture({projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): ClipGainsFixture {
  const rect = {x: 0, y: 0, width: 720, height: 1280};
  const clip = (n: number, startFrame: number, gain: number) =>
    ({id: id(n), trackId: id(6), assetId: id(n + 10), name: 'Line', startFrame, durationFrames: 60, sourceInFrame: 0, rect, gain, audioRole: 'human'});
  return {
    input: {projectId, expectedRevision, requestId, gains: [{clipId: id(1), gain: 1.25}, {clipId: id(2), gain: 0.8}]},
    response: {operation: 'timeline.clip.setGains', requestId,
      gains: [{clipId: id(1), previousGain: 1, gain: 1.25}, {clipId: id(2), previousGain: 1, gain: 0.8}],
      timeline: {id: id(5), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
        tracks: [{id: id(6), name: 'Audio 1', kind: 'audio', orderIndex: 0, hidden: false, muted: false}],
        clips: [clip(1, 0, 1.25), clip(2, 60, 0.8)],
        durationFrames: 120, createdAt: at, updatedAt: at}},
  };
}
