import {timelineCompositionSegments} from '@mioon/contracts/timeline-segments';
import {timelineExportOutputFrames} from '@mioon/contracts/timeline-export-range';
import type {TimelineExportRange} from '@mioon/contracts/timeline-export-range';

/** The caller validates the complete frozen timeline before planning. Original
 * segment bounds are retained so source seeking and fps/resampler initialization
 * remain identical to the corresponding full render. */
export interface TimelineExportRangePlanInput {
  readonly timeline: {
    readonly fps: number;
    readonly durationFrames: number;
    readonly clips: readonly {readonly startFrame: number; readonly durationFrames: number}[];
  };
  readonly exportRange?: TimelineExportRange;
}

export interface TimelineExportRangeSegment {
  readonly beginFrame: number;
  readonly endFrame: number;
  readonly outputFrames: number;
  /** Appended after the original segment bound, before its final PTS reset. */
  readonly videoOutputTrim: string;
  readonly audioOutputTrim: string;
}

export interface TimelineExportRangePlan {
  readonly selected: boolean;
  readonly outputFrames: number;
  readonly segments: readonly TimelineExportRangeSegment[];
}

/** No defaults are written to the snapshot. In particular, absent-range and
 * explicit full-span plans retain the original graph's exact argument strings. */
export function planTimelineExportRange(snapshot: TimelineExportRangePlanInput): TimelineExportRangePlan {
  const outputFrames = timelineExportOutputFrames(snapshot);
  const {timeline} = snapshot;
  const start = snapshot.exportRange?.startFrame ?? 0;
  const end = snapshot.exportRange?.endFrame ?? timeline.durationFrames;
  const segments: TimelineExportRangeSegment[] = [];
  for (const {beginFrame, endFrame} of timelineCompositionSegments(timeline)) {
    const from = Math.max(beginFrame, start), to = Math.min(endFrame, end);
    if (from >= to) continue;
    const first = from - beginFrame, last = to - beginFrame;
    const clipped = first !== 0 || last !== endFrame - beginFrame;
    segments.push(Object.freeze({beginFrame, endFrame, outputFrames: to - from,
      videoOutputTrim: clipped ? `trim=start_frame=${first}:end_frame=${last},` : '',
      audioOutputTrim: clipped ? `atrim=start_sample=${first * 1600}:end_sample=${last * 1600},` : '',
    }));
  }
  return Object.freeze({selected: Object.hasOwn(snapshot, 'exportRange'), outputFrames,
    segments: Object.freeze(segments)});
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const zero = (value: unknown): boolean =>
  (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number(value) === 0;

/** AAC priming packets may have negative DTS. Stream/format presentation starts
 * describe the MP4 edit-list-adjusted output, which must start at zero. Historical
 * absent-range outputs keep their previous verification path unchanged. */
export function validateTimelineExportRangeOutputStart(plan: TimelineExportRangePlan, probe: unknown): void {
  if (!plan.selected) return;
  const streams: readonly unknown[] = object(probe) && Array.isArray(probe.streams) ? probe.streams : [];
  const video: unknown = streams.find(stream => object(stream) && stream.codec_type === 'video');
  const audio: unknown = streams.find(stream => object(stream) && stream.codec_type === 'audio');
  if (!object(video) || !object(audio) || !zero(video.start_pts) || !zero(video.start_time) ||
      !zero(audio.start_pts) || !zero(audio.start_time) || !object(probe) ||
      !object(probe.format) || !zero(probe.format.start_time)) {
    throw Object.assign(new Error('Rendered selected timeline range must start at presentation time zero'),
      {code: 'INVALID_TIMELINE_OUTPUT'});
  }
}
