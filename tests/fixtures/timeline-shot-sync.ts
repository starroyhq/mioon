// Complete, valid shot-sync acknowledgements for transport/recovery tests that
// iterate every timeline mutation. One clip is refreshed and one skipped; one
// shot is appended after an existing clip and one skipped.
const id = (n: number): string => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`;
const at = '2026-10-23T00:00:00.000Z';
export type ShotSyncOperation = 'timeline.clip.refreshSources' | 'timeline.shots.append';
export interface ShotSyncFixture {input: Record<string, unknown>; response: Record<string, unknown> & {timeline: Record<string, unknown>}}

export function shotSyncFixture(operation: ShotSyncOperation, {projectId, expectedRevision = 7, requestId}: {projectId: string; expectedRevision?: number; requestId: string}): ShotSyncFixture {
  const trackId = id(1), rect = {x: 0, y: 0, width: 720, height: 1280};
  const timeline = (clips: Record<string, unknown>[], durationFrames: number) => ({id: id(2), projectId, revision: expectedRevision + 1, fps: 30, width: 720, height: 1280,
    tracks: [{id: trackId, name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips, durationFrames, createdAt: at, updatedAt: at});
  if (operation === 'timeline.clip.refreshSources') {
    const refreshed = {clipId: id(10), shotId: id(11), fromVersionId: id(12), toVersionId: id(13), assetId: id(14)};
    return {
      input: {projectId, expectedRevision, requestId, clipIds: [id(10), id(20)]},
      response: {operation, requestId, refreshed: [refreshed], skipped: [{clipId: id(20), reason: 'NOT_GENERATED'}],
        timeline: timeline([
          {id: id(10), trackId, assetId: id(14), name: 'Refreshed', startFrame: 0, durationFrames: 90, sourceInFrame: 7, rect, gain: 0.5, versionId: id(13), shotId: id(11)},
          {id: id(20), trackId, assetId: id(21), name: 'Imported', startFrame: 90, durationFrames: 30, sourceInFrame: 0, rect, gain: 1},
        ], 120)},
    };
  }
  return {
    input: {projectId, expectedRevision, requestId},
    response: {operation, requestId, appended: [{clipId: id(31), shotId: id(32), versionId: id(33), startFrame: 90, durationFrames: 60}],
      skipped: [{shotId: id(34), reason: 'NO_SELECTION'}],
      timeline: timeline([
        {id: id(30), trackId, assetId: id(35), name: 'Existing', startFrame: 0, durationFrames: 90, sourceInFrame: 0, rect, gain: 1},
        {id: id(31), trackId, assetId: id(36), name: 'Appended', startFrame: 90, durationFrames: 60, sourceInFrame: 0, rect, gain: 1, versionId: id(33), shotId: id(32)},
      ], 150)},
  };
}
