import {randomUUID} from 'node:crypto';
import type {TimelineRecord} from './timeline-inputs.ts';

/** Shared first timeline for store-level and application-level project create. */
export function newTimelineRecord(projectId: string, preset: {readonly fps: number; readonly width: number; readonly height: number}, now: () => string): TimelineRecord {
  const createdAt = now();
  return {
    id: randomUUID(), projectId, revision: 1, fps: preset.fps, width: preset.width, height: preset.height,
    tracks: [['video', 'Video 1'], ['video', 'Video 2'], ['audio', 'Audio 1']].map(([kind, name], orderIndex) => ({id: randomUUID(), name, kind, orderIndex, hidden: false, muted: false})),
    clips: [], durationFrames: 0, createdAt, updatedAt: createdAt,
  };
}
