// A complete, valid scene-split acknowledgement for transport/recovery tests
// that iterate every timeline mutation. One clip of the reference video is split
// at cuts 20 and 40; another clip of it has no cut in range and is skipped.
const id = (n: number): string => `00000000-0000-4000-8000-${String(950 + n).padStart(12, '0')}`;
const at = '2026-10-24T00:00:00.000Z';
export interface SceneSplitFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function sceneSplitFixture({projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): SceneSplitFixture {
  const trackId = id(1), assetId = id(5), rect = {x: 0, y: 0, width: 720, height: 1280};
  const piece = (n: number, startFrame: number, sourceInFrame: number, durationFrames = 20) =>
    ({id: id(n), trackId, assetId, name: 'Reference', startFrame, durationFrames, sourceInFrame, rect, gain: 1});
  return {
    input: {projectId, expectedRevision, requestId, assetId, resultId: id(6)},
    response: {operation: 'timeline.clip.splitAtScenes', requestId,
      split: [{clipId: id(10), clipIds: [id(10), id(11), id(12)], cutFrames: [20, 40], fadeCutFrames: []}],
      skipped: [{clipId: id(13), reason: 'NO_CUT_IN_RANGE'}],
      timeline: {id: id(2), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
        tracks: [{id: trackId, name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
        clips: [piece(10, 0, 0), piece(11, 20, 20), piece(12, 40, 40), piece(13, 60, 100, 30)], durationFrames: 90, createdAt: at, updatedAt: at}},
  };
}
