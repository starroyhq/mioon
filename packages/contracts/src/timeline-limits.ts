/** Bounds for the shared timeline processing and delivery paths. Native
 * project storage has its own format-specific capacity. */
const framesPerSecond = 30;
const maxMinutes = 30;
const maxClips = 300;

export const TIMELINE_LIMITS = Object.freeze({
  framesPerSecond,
  maxMinutes,
  maxFrames: framesPerSecond * 60 * maxMinutes,
  maxClips,
  maxSegments: 2 * maxClips,
  maxTracks: 12,
  maxSubtitleCues: 100,
  maxRenderedSubtitleCues: 1000,
});

/** Persisted format-3/4 edit and replay bounds, and the historical export
 * envelope for byte-compatible concat of already-supported projects. */
export const LEGACY_TIMELINE_LIMITS = Object.freeze({
  maxFrames: 18_000,
  maxClips: 100,
  maxSegments: 200,
});

export const TIMELINE_SEGMENT_LIMIT_MESSAGE = `导出最多支持 ${TIMELINE_LIMITS.maxSegments} 个分段。请减少片段中的空隙或转场再试。`;

export function isTimelineExportLimitCode(code: unknown): code is 'TIMELINE_LIMIT' | 'TIMELINE_SEGMENT_LIMIT' {
  return code === 'TIMELINE_LIMIT' || code === 'TIMELINE_SEGMENT_LIMIT';
}
