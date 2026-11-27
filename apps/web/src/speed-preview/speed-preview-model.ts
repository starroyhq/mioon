/** Pure shared time-map, preview-media, thumbnail-sampling, and waveform-projection
 * helpers for Speed Preview (SP-V).
 *
 * Uses the shared clip time-map compiler and frame rules used by export.
 */
import {
  TIMELINE_TIME_MAP_LIMITS,
  timeMapOutputAtSourceFrame,
  timeMapPlanFrames,
  timeMapSourceAtOutputFrame,
  timeMapTailInverse,
} from '../../../../packages/contracts/src/timeline-time-map.ts';
import {compileClipTimeMap} from '../../../../packages/contracts/src/timeline-clip-timing.ts';
import type {
  CompiledTimeMap,
  ContinuousSourcePosition,
  TimeMapResult,
  TimeMapSourceBoundary,
} from '../../../../packages/contracts/src/timeline-time-map.ts';
import {speedProcessingReasonSchema} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {
  ClipTiming,
  SpeedProcessingItem,
  SpeedProcessingReason,
} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {MessageArguments, MessageKey} from '../../../../packages/i18n/src/index.ts';
import type {WaveformEntry, WaveformWindow} from '../waveform-state.ts';
import {WAVEFORM_LIMITS, waveformKey, waveformWindow} from '../waveform-state.ts';
import {
  clipTimingOf,
  isFreezeClip,
  processingItemActive,
  rateToNumber,
  selectClipProcessingItem,
  speedProcessingCanRetry,
  timelineSpeedEnabled,
} from '../speed-ui/speed-model.ts';
import type {SpeedAssetLike, SpeedClipLike, SpeedTimelineLike} from '../speed-ui/speed-model.ts';
import {
  speedProcessingActiveLabel,
  speedProcessingFailureSentence,
} from '../speed-ui/speed-presentation.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;

// ---------------------------------------------------------------------------
// `timeline.preview.media` response contract & validation.
// ---------------------------------------------------------------------------

export type PreviewMedia =
  | {readonly mode: 'native'; readonly rate: {readonly numerator: number; readonly denominator: number}}
  | {readonly mode: 'proxy'; readonly status: 'ready'; readonly url: string; readonly durationFrames: number}
  | {
      readonly mode: 'proxy';
      readonly status: 'queued' | 'running' | 'failed';
      readonly taskId: string;
      readonly progress?: number;
      readonly reason?: SpeedProcessingReason;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const MEDIA_PATH_RE = /^\/api\/projects\/([^/]+)\/assets\/([^/]+)\/media$/u;

function isRateTerm(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= TIMELINE_TIME_MAP_LIMITS.maxRateTerm;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every(key => allowed.includes(key));
}

export function parsePreviewMedia(value: unknown): PreviewMedia | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.mode === 'native') {
    if (!hasOnlyKeys(obj, ['mode', 'rate'])) return null;
    const rate = obj.rate;
    if (!rate || typeof rate !== 'object' || Array.isArray(rate)) return null;
    const r = rate as Record<string, unknown>;
    if (!hasOnlyKeys(r, ['numerator', 'denominator'])) return null;
    if (!isRateTerm(r.numerator) || !isRateTerm(r.denominator)) return null;
    if (r.numerator * 10 < r.denominator || r.numerator > r.denominator * 10) return null;
    return {mode: 'native', rate: {numerator: r.numerator, denominator: r.denominator}};
  }
  if (obj.mode !== 'proxy') return null;
  if (obj.status === 'ready') {
    if (!hasOnlyKeys(obj, ['mode', 'status', 'url', 'durationFrames'])) return null;
    if (typeof obj.url !== 'string' || obj.url.length === 0) return null;
    if (
      typeof obj.durationFrames !== 'number'
      || !Number.isSafeInteger(obj.durationFrames)
      || obj.durationFrames < 1
      || obj.durationFrames > TIMELINE_TIME_MAP_LIMITS.maxOutputFrames
    ) {
      return null;
    }
    return {mode: 'proxy', status: 'ready', url: obj.url, durationFrames: obj.durationFrames};
  }
  if (obj.status === 'queued' || obj.status === 'running' || obj.status === 'failed') {
    if (!hasOnlyKeys(obj, ['mode', 'status', 'taskId', 'progress', 'reason'])) return null;
    if (typeof obj.taskId !== 'string' || obj.taskId.length === 0) return null;
    let progress: number | undefined;
    if (obj.progress !== undefined) {
      if (typeof obj.progress !== 'number' || !Number.isFinite(obj.progress) || obj.progress < 0 || obj.progress > 100) {
        return null;
      }
      progress = obj.progress;
    }
    let reason: SpeedProcessingReason | undefined;
    if (obj.reason !== undefined) {
      const parsedReason = speedProcessingReasonSchema.safeParse(obj.reason);
      if (!parsedReason.success) return null;
      reason = parsedReason.data;
    }
    return {
      mode: 'proxy',
      status: obj.status,
      taskId: obj.taskId,
      ...(progress !== undefined ? {progress} : {}),
      ...(reason !== undefined ? {reason} : {}),
    };
  }
  return null;
}

/** Validates that a ready proxy URL belongs to `(projectId, clipId)` and carries
 * the required `speedPreview`, `taskId`, and 64-hex `digest` parameters. */
export function isPreviewMediaForClip(
  media: PreviewMedia,
  projectId: string,
  clipId: string,
): boolean {
  if (media.mode !== 'proxy' || media.status !== 'ready') return true;
  if (!/^\/[-a-z0-9/]+\?[-a-zA-Z0-9=&%._~]+$/u.test(media.url)) return false;
  const qIndex = media.url.indexOf('?');
  if (qIndex < 0) return false;
  const pathPart = media.url.slice(0, qIndex);
  const queryPart = media.url.slice(qIndex + 1);
  const match = MEDIA_PATH_RE.exec(pathPart);
  if (!match || match[1] !== projectId) return false;
  const params = new URLSearchParams(queryPart);
  const qClip = params.get('speedPreview');
  const qTask = params.get('taskId');
  const qDigest = params.get('digest');
  if (qClip !== clipId || !qTask || !UUID_RE.test(qTask) || !qDigest || !DIGEST_RE.test(qDigest)) {
    return false;
  }
  return true;
}

export function parsePreviewMediaForClip(
  value: unknown,
  projectId: string,
  clipId: string,
): PreviewMedia | null {
  const parsed = parsePreviewMedia(value);
  if (!parsed) return null;
  if (!isPreviewMediaForClip(parsed, projectId, clipId)) return null;
  return parsed;
}

export function previewMediaNeedsPolling(media: PreviewMedia | null): boolean {
  return Boolean(media && media.mode === 'proxy' && (media.status === 'queued' || media.status === 'running'));
}

// ---------------------------------------------------------------------------
// Shared clip time-map compilation & frame sampling (matches backend SP-V).
// ---------------------------------------------------------------------------

const WAVEFORM_FPS = 30;
const WAVEFORM_SAMPLE_RATE = 48000;
const WAVEFORM_BINS_PER_SECOND = 100;
const SAMPLES_PER_FRAME = WAVEFORM_SAMPLE_RATE / WAVEFORM_FPS;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function boundaryToFrameNumber(position: TimeMapSourceBoundary | ContinuousSourcePosition): number {
  if (position.kind === 'numeric') return position.value;
  if (position.kind === 'q64') return Number(BigInt(position.ticks)) / Number(1n << 64n);
  return Number(BigInt(position.numerator)) / Number(BigInt(position.denominator));
}

function boundaryToSampleNumber(position: TimeMapSourceBoundary | ContinuousSourcePosition): number {
  if (position.kind === 'numeric') return position.value * SAMPLES_PER_FRAME;
  if (position.kind === 'q64') {
    return Number(BigInt(position.ticks) * BigInt(SAMPLES_PER_FRAME)) / Number(1n << 64n);
  }
  return Number(BigInt(position.numerator) * BigInt(SAMPLES_PER_FRAME)) / Number(BigInt(position.denominator));
}

const PLAN_CACHE_MAX = 64;
const compiledPlanCache = new Map<string, TimeMapResult<CompiledTimeMap>>();

function clipPlanCacheKey(clip: SpeedClipLike, fps: number): string {
  const timing = clipTimingOf(clip);
  return `${clip.id}:${clip.startFrame}:${clip.durationFrames}:${clip.sourceInFrame ?? 0}:${fps}:${timing ? JSON.stringify(timing) : 'none'}`;
}

/** Compiles a clip's `timing` (speed, freeze, or default 1×) into a `CompiledTimeMap`.
 * Cached by clip timing signature so React renders and scrubbing stay sub-millisecond. */
export function compileClipTimeMapForPreview(
  clip: SpeedClipLike,
  fps: number,
): TimeMapResult<CompiledTimeMap> {
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const key = clipPlanCacheKey(clip, safeFps);
  const cached = compiledPlanCache.get(key);
  if (cached) {
    compiledPlanCache.delete(key);
    compiledPlanCache.set(key, cached);
    return cached;
  }
  const timing = clipTimingOf(clip);
  const result = compileClipTimeMap({
    id: clip.id,
    startFrame: clip.startFrame,
    durationFrames: Math.max(1, Math.trunc(clip.durationFrames)),
    sourceInFrame: Math.max(0, Math.trunc(clip.sourceInFrame ?? 0)),
    ...(timing ? {timing} : {}),
  }, {fps: safeFps});
  compiledPlanCache.set(key, result);
  while (compiledPlanCache.size > PLAN_CACHE_MAX) {
    const oldest = compiledPlanCache.keys().next().value;
    if (oldest !== undefined) compiledPlanCache.delete(oldest);
  }
  return result;
}

export interface ClipPreviewSourceSample {
  readonly outputFrame: number;
  readonly sourceFrame: number;
  readonly continuousFrame: number;
  readonly sourceSeconds: number;
  readonly tail: boolean;
}

/** Samples the exact source frame and seconds for an absolute timeline frame
 * using the shared time-map compiler (consistent with export frame selection). */
export function sampleClipSourceAtTimelineFrame(
  clip: SpeedClipLike,
  fps: number,
  timelineFrame: number,
  precompiledPlan?: CompiledTimeMap | null,
): ClipPreviewSourceSample {
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const timing = clipTimingOf(clip);
  const clampedTimeline = clamp(Math.round(timelineFrame), clip.startFrame, clip.startFrame + Math.max(0, clip.durationFrames));
  const local = clampedTimeline - clip.startFrame;

  if (timing?.profile === 'timeline-freeze-v1') {
    const sf = Math.max(0, Math.trunc(timing.sourceFrame));
    return {
      outputFrame: clampedTimeline,
      sourceFrame: sf,
      continuousFrame: sf,
      sourceSeconds: sf / safeFps,
      tail: false,
    };
  }

  if (!timing) {
    const sf = Math.max(0, Math.trunc(clip.sourceInFrame ?? 0) + local);
    return {
      outputFrame: clampedTimeline,
      sourceFrame: sf,
      continuousFrame: sf,
      sourceSeconds: sf / safeFps,
      tail: false,
    };
  }

  const plan = precompiledPlan ?? (() => {
    const compiled = compileClipTimeMapForPreview(clip, safeFps);
    return compiled.ok ? compiled.value : null;
  })();

  if (!plan) {
    const sf = Math.max(0, Math.trunc(clip.sourceInFrame ?? 0) + local);
    return {
      outputFrame: clampedTimeline,
      sourceFrame: sf,
      continuousFrame: sf,
      sourceSeconds: sf / safeFps,
      tail: false,
    };
  }

  if (local >= plan.durationFrames) {
    const endPos = timeMapTailInverse(
      plan,
      {numerator: String(plan.outputWindow.toFrame), denominator: '1'},
      {tailInverse: plan.direction === 'reverse' ? 'earliest' : 'latest'},
    );
    if (endPos.ok) {
      const continuous = Math.max(0, boundaryToFrameNumber(endPos.value.position));
      return {
        outputFrame: clampedTimeline,
        sourceFrame: Math.max(0, endPos.value.frame),
        continuousFrame: continuous,
        sourceSeconds: continuous / safeFps,
        tail: endPos.value.tail,
      };
    }
  }

  const boundedLocal = clamp(local, 0, Math.max(0, plan.durationFrames - 1));
  const sample = timeMapSourceAtOutputFrame(plan, boundedLocal);
  if (sample.ok) {
    const continuous = Math.max(0, boundaryToFrameNumber(sample.value.source));
    return {
      outputFrame: clampedTimeline,
      sourceFrame: Math.max(0, sample.value.sourceFrame),
      continuousFrame: continuous,
      // Use the discrete selected source frame so paused/scrubbed video frames match export.
      sourceSeconds: Math.max(0, sample.value.sourceFrame) / safeFps,
      tail: sample.value.tail,
    };
  }

  const fallback = Math.max(0, Math.trunc(clip.sourceInFrame ?? 0) + boundedLocal);
  return {
    outputFrame: clampedTimeline,
    sourceFrame: fallback,
    continuousFrame: fallback,
    sourceSeconds: fallback / safeFps,
    tail: false,
  };
}

/** Inverse mapping: converts a source `<video>` element's `currentTime` back to
 * the output timeline frame for playback clock alignment. */
export function outputFrameFromSourceSeconds(
  clip: SpeedClipLike,
  fps: number,
  sourceSeconds: number,
  precompiledPlan?: CompiledTimeMap | null,
): number {
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const safeSeconds = Number.isFinite(sourceSeconds) && sourceSeconds >= 0 ? sourceSeconds : 0;
  const timing = clipTimingOf(clip);
  const duration = Math.max(0, Math.trunc(clip.durationFrames));

  if (timing?.profile === 'timeline-freeze-v1') {
    return clip.startFrame;
  }

  if (!timing) {
    const local = Math.round(safeSeconds * safeFps) - Math.trunc(clip.sourceInFrame ?? 0);
    return clip.startFrame + clamp(local, 0, duration);
  }

  const plan = precompiledPlan ?? (() => {
    const compiled = compileClipTimeMapForPreview(clip, safeFps);
    return compiled.ok ? compiled.value : null;
  })();

  if (timing.basis.speed.kind === 'constant' && timing.view.direction === 'forward') {
    const rate = rateToNumber(timing.basis.speed.rate);
    const startSample = sampleClipSourceAtTimelineFrame(clip, safeFps, clip.startFrame, plan);
    const deltaSourceFrames = safeSeconds * safeFps - startSample.continuousFrame;
    const local = Math.round(deltaSourceFrames / rate);
    return clip.startFrame + clamp(local, 0, duration);
  }

  if (plan) {
    const out = timeMapOutputAtSourceFrame(plan, Math.max(0, Math.round(safeSeconds * safeFps)));
    if (out.ok) {
      if (out.value.status === 'before') return clip.startFrame;
      if (out.value.status === 'after') return clip.startFrame + duration;
      const target = out.value.firstOutputFrame ?? out.value.lastOutputFrame ?? 0;
      return clip.startFrame + clamp(target, 0, duration);
    }
  }

  const local = Math.round(safeSeconds * safeFps) - Math.trunc(clip.sourceInFrame ?? 0);
  return clip.startFrame + clamp(local, 0, duration);
}

// ---------------------------------------------------------------------------
// Timeline thumbnail sample positions (shared time-map -> source frames).
// ---------------------------------------------------------------------------

export interface ClipThumbnailSample {
  readonly slotIndex: number;
  readonly outputOffsetFrames: number;
  readonly sourceFrame: number;
  readonly seekSeconds: number;
}

/** Computes evenly spaced output thumbnail slots across a timeline clip and maps
 * each slot to its exact source frame via the shared time map. The browser seeks
 * inside that frame so timestamp truncation cannot select the previous frame. */
export function computeClipThumbnailSamples(
  clip: SpeedClipLike,
  fps: number,
  clipWidthPx: number,
): readonly ClipThumbnailSample[] {
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const timing = clipTimingOf(clip);
  if (timing?.profile === 'timeline-freeze-v1') {
    const sf = Math.max(0, Math.trunc(timing.sourceFrame));
    return [{
      slotIndex: 0,
      outputOffsetFrames: 0,
      sourceFrame: sf,
      seekSeconds: (sf + 0.5) / safeFps,
    }];
  }
  const duration = Math.max(1, Math.trunc(clip.durationFrames));
  const tileWidth = 96;
  const count = clamp(Math.round(Math.max(1, clipWidthPx) / tileWidth), 1, 6);
  const compiled = compileClipTimeMapForPreview(clip, safeFps);
  if (!compiled.ok) return [];
  const frames = timeMapPlanFrames(compiled.value);
  if (!frames.ok || frames.value.length !== duration) return [];
  const samples: ClipThumbnailSample[] = [];
  for (let i = 0; i < count; i++) {
    const outputOffsetFrames = count === 1
      ? 0
      : clamp(Math.floor(((i + 0.5) * duration) / count), 0, duration - 1);
    const sourceFrame = frames.value[outputOffsetFrames]!;
    samples.push({
      slotIndex: i,
      outputOffsetFrames,
      sourceFrame,
      seekSeconds: (sourceFrame + 0.5) / safeFps,
    });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Timeline waveform source-window calculation & output-domain peak remapping
// (matches backend `projectTimelineWaveformPeaks` bit-for-bit).
// ---------------------------------------------------------------------------

function planVisibleSourceBoundsSamples(plan: CompiledTimeMap): {readonly low: number; readonly high: number} | null {
  const startInv = timeMapTailInverse(
    plan,
    {numerator: String(plan.outputWindow.fromFrame), denominator: '1'},
    {tailInverse: plan.direction === 'reverse' ? 'latest' : 'earliest'},
  );
  const endInv = timeMapTailInverse(
    plan,
    {numerator: String(plan.outputWindow.toFrame), denominator: '1'},
    {tailInverse: plan.direction === 'reverse' ? 'earliest' : 'latest'},
  );
  if (!startInv.ok || !endInv.ok) return null;
  const a = boundaryToSampleNumber(startInv.value.position);
  const b = boundaryToSampleNumber(endInv.value.position);
  return {low: Math.min(a, b), high: Math.max(a, b)};
}

/** Builds a `WaveformWindow` for a timeline clip. When `clip.timing` is present,
 * computes the exact covering source frame window for `asset.waveform.get` and
 * stores output-domain bounds so peaks can be projected per output pixel column. */
export function buildSpeedWaveformWindow(
  clip: SpeedClipLike & {readonly assetId: string},
  fps: number,
  pixelsPerFrame: number,
  leftFrame: number,
  rightFrame: number,
): WaveformWindow | null {
  const timing = clipTimingOf(clip);
  if (!timing) {
    return waveformWindow(
      {
        id: clip.id,
        assetId: clip.assetId,
        trackId: clip.trackId,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        sourceInFrame: clip.sourceInFrame,
      },
      pixelsPerFrame,
      leftFrame,
      rightFrame,
    );
  }
  if (!(pixelsPerFrame > 0) || !(rightFrame > leftFrame) || !(clip.durationFrames > 0)) return null;
  const begin = Math.max(clip.startFrame, leftFrame);
  const end = Math.min(clip.startFrame + clip.durationFrames, rightFrame);
  if (!(end > begin)) return null;
  const offset = Math.max(0, Math.floor(begin - clip.startFrame + 1e-7));
  const endOffset = Math.min(clip.durationFrames, Math.ceil(end - clip.startFrame - 1e-7));
  if (!(endOffset > offset)) return null;

  const outputStartFrame = clip.startFrame + offset;
  const outputEndFrame = clip.startFrame + endOffset;
  const width = (endOffset - offset) * pixelsPerFrame;
  const outputPoints = Math.max(1, Math.min(WAVEFORM_LIMITS.points, Math.ceil(width)));
  const left = offset * pixelsPerFrame;

  if (timing.profile === 'timeline-freeze-v1') {
    const sf = Math.max(0, Math.trunc(timing.sourceFrame));
    const item: WaveformWindow = {
      clipId: clip.id,
      assetId: clip.assetId,
      sourceStartFrame: sf,
      sourceEndFrame: sf + 1,
      points: outputPoints,
      left,
      width,
      key: `freeze:${clip.id}:${outputStartFrame}:${outputEndFrame}:${outputPoints}`,
      outputStartFrame,
      outputEndFrame,
      outputPoints,
      speedFreeze: true,
    };
    return item;
  }

  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : WAVEFORM_FPS;
  const compiled = compileClipTimeMapForPreview(clip, safeFps);
  if (!compiled.ok) {
    return waveformWindow(
      {
        id: clip.id,
        assetId: clip.assetId,
        trackId: clip.trackId,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        sourceInFrame: clip.sourceInFrame,
      },
      pixelsPerFrame,
      leftFrame,
      rightFrame,
    );
  }

  const plan = compiled.value;
  const reverse = plan.direction === 'reverse';
  const loInv = timeMapTailInverse(
    plan,
    {numerator: String(plan.outputWindow.fromFrame + offset), denominator: '1'},
    {tailInverse: reverse ? 'latest' : 'earliest'},
  );
  const hiInv = timeMapTailInverse(
    plan,
    {numerator: String(plan.outputWindow.fromFrame + endOffset), denominator: '1'},
    {tailInverse: reverse ? 'earliest' : 'latest'},
  );
  if (!loInv.ok || !hiInv.ok) return null;

  const fA = boundaryToFrameNumber(loInv.value.position);
  const fB = boundaryToFrameNumber(hiInv.value.position);
  const sourceStartFrame = Math.max(0, Math.floor(Math.min(fA, fB)));
  const sourceEndFrame = Math.max(sourceStartFrame + 1, Math.ceil(Math.max(fA, fB)));
  // Request enough source bins to retain full peak resolution even under 2×–10× fast-forward.
  const sourceResolutionPoints = Math.ceil((sourceEndFrame - sourceStartFrame) * WAVEFORM_BINS_PER_SECOND / WAVEFORM_FPS);
  const points = Math.max(1, Math.min(WAVEFORM_LIMITS.points, Math.max(outputPoints, sourceResolutionPoints)));

  const base = {
    clipId: clip.id,
    assetId: clip.assetId,
    sourceStartFrame,
    sourceEndFrame,
    points,
    left,
    width,
    outputStartFrame,
    outputEndFrame,
    outputPoints,
  };
  return {...base, key: waveformKey(base)};
}

/** Projects normalized `asset.waveform.get` source peaks onto equal-width columns
 * in the clip's output time domain. Matches backend `projectTimelineWaveformPeaks`:
 * missing source coverage stays `null`, freeze clips and tail holds are `0`. */
export function projectSpeedClipWaveformPeaks(
  clip: SpeedClipLike,
  fps: number,
  window: {readonly outputStartFrame: number; readonly outputEndFrame: number; readonly points: number},
  source: {
    readonly peaks: readonly (number | null)[];
    readonly sourceStartFrame: number;
    readonly sourceEndFrame: number;
    readonly decodedSampleFrames: number;
  } | null,
): (number | null)[] | null {
  const count = Math.min(
    Math.max(1, Math.min(WAVEFORM_LIMITS.points, Math.trunc(window.points))),
    Math.max(1, Math.ceil((window.outputEndFrame - window.outputStartFrame) * WAVEFORM_BINS_PER_SECOND / WAVEFORM_FPS)),
  );
  const timing = clipTimingOf(clip);
  if (timing?.profile === 'timeline-freeze-v1') {
    return Array<number>(count).fill(0);
  }
  if (!source || !source.peaks.length || source.sourceEndFrame <= source.sourceStartFrame) {
    return null;
  }
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : WAVEFORM_FPS;
  const compiled = compileClipTimeMapForPreview(clip, safeFps);
  if (!compiled.ok) return null;
  const plan = compiled.value;
  if (plan.durationFrames !== clip.durationFrames) return null;

  const bounds = planVisibleSourceBoundsSamples(plan);
  if (!bounds) return null;
  const {low, high} = bounds;
  const reverse = plan.direction === 'reverse';
  const entry = reverse ? high : low;
  const exit = reverse ? low : high;

  const sourceBegin = source.sourceStartFrame * SAMPLES_PER_FRAME;
  const sourceEnd = source.sourceEndFrame * SAMPLES_PER_FRAME;
  const coverageEnd = Math.min(sourceEnd, source.decodedSampleFrames);
  const groupsPerSample = source.peaks.length / (sourceEnd - sourceBegin);

  const from = clamp(window.outputStartFrame - clip.startFrame, 0, clip.durationFrames);
  const span = clamp(window.outputEndFrame - window.outputStartFrame, 1, clip.durationFrames - from);

  function sampleAt(index: number): number {
    const local = from * count + index * span;
    if (local === 0) return entry;
    if (local === clip.durationFrames * count) return exit;
    const inv = timeMapTailInverse(
      plan,
      {numerator: String(plan.outputWindow.fromFrame * count + local), denominator: String(count)},
      {tailInverse: reverse ? 'earliest' : 'latest'},
    );
    if (!inv.ok) return exit;
    return inv.value.tail ? exit : clamp(boundaryToSampleNumber(inv.value.position), low, high);
  }

  const peaks: (number | null)[] = [];
  let previous = sampleAt(0);
  for (let i = 1; i <= count; i++) {
    const current = sampleAt(i);
    const begin = Math.min(previous, current);
    const end = Math.max(previous, current);
    previous = current;
    if (end <= begin) {
      peaks.push(0);
      continue;
    }
    const coveredBegin = Math.max(begin, sourceBegin);
    const coveredEnd = Math.min(end, coverageEnd);
    if (coveredEnd <= coveredBegin) {
      peaks.push(null);
      continue;
    }
    const first = Math.max(0, Math.floor((coveredBegin - sourceBegin) * groupsPerSample));
    const last = Math.min(source.peaks.length, Math.ceil((coveredEnd - sourceBegin) * groupsPerSample));
    let peak: number | null = null;
    for (let bin = first; bin < last; bin++) {
      const value = source.peaks[bin];
      if (value !== null && value !== undefined) {
        peak = Math.max(peak ?? 0, value);
      }
    }
    peaks.push(peak);
  }
  return peaks;
}

const projectedWaveformCache = new WeakMap<WaveformEntry, Map<string, WaveformEntry>>();

/** Projects a `WaveformEntry` for `TimelineWaveform` when `clip.timing` is set.
 * Returns the original entry untouched for non-speed clips. Cached per source
 * `WaveformEntry` reference so timeline re-renders stay O(1). */
export function projectSpeedClipWaveformEntry(
  clip: SpeedClipLike,
  fps: number,
  window: WaveformWindow,
  entry: WaveformEntry | undefined,
): WaveformEntry | undefined {
  const timing = clipTimingOf(clip);
  if (!timing) return entry;
  const outputStartFrame = window.outputStartFrame ?? clip.startFrame;
  const outputEndFrame = window.outputEndFrame ?? (clip.startFrame + clip.durationFrames);
  const outputPoints = window.outputPoints ?? window.points;

  if (timing.profile === 'timeline-freeze-v1') {
    if (entry && entry.status === 'ready' && entry.outputDomain === true && entry.peaks) {
      return entry;
    }
    const zeroPeaks = projectSpeedClipWaveformPeaks(
      clip,
      fps,
      {outputStartFrame, outputEndFrame, points: outputPoints},
      null,
    ) ?? [];
    return {
      ...(entry ?? {
        ...window,
        phase: 'idle' as const,
        nextAt: 0,
        retry: false,
      }),
      status: 'ready',
      peaks: zeroPeaks,
      clipped: false,
      outputDomain: true,
    };
  }

  if (
    !entry
    || entry.status !== 'ready'
    || !entry.peaks
    || typeof entry.decodedSampleFrames !== 'number'
  ) {
    return entry;
  }

  const cacheKey = `${clipPlanCacheKey(clip, fps)}:${outputStartFrame}:${outputEndFrame}:${outputPoints}:${entry.peaks.length}:${entry.decodedSampleFrames}`;
  let perEntry = projectedWaveformCache.get(entry);
  const hit = perEntry?.get(cacheKey);
  if (hit) return hit;

  const projected = projectSpeedClipWaveformPeaks(
    clip,
    fps,
    {outputStartFrame, outputEndFrame, points: outputPoints},
    {
      peaks: entry.peaks,
      sourceStartFrame: entry.sourceStartFrame,
      sourceEndFrame: entry.sourceEndFrame,
      decodedSampleFrames: entry.decodedSampleFrames,
    },
  );
  if (!projected) return entry;
  const result: WaveformEntry = {
    ...entry,
    peaks: projected,
    outputDomain: true,
  };
  if (!perEntry) {
    perEntry = new Map<string, WaveformEntry>();
    projectedWaveformCache.set(entry, perEntry);
  }
  if (perEntry.size >= 8) perEntry.clear();
  perEntry.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// `ClipSpeedPreviewBinding` for `Preview.tsx` (zero new runtime imports in Preview.tsx).
// ---------------------------------------------------------------------------

export type ClipSpeedPreviewOverlay =
  | {readonly kind: 'processing'; readonly label: string; readonly percent: number | null; readonly taskKind: SpeedProcessingItem['kind']}
  | {readonly kind: 'failed'; readonly message: string; readonly canRetry: boolean; readonly taskId: string};

export interface ClipSpeedPreviewBinding {
  readonly mode: 'freeze' | 'native' | 'proxy-ready' | 'proxy-pending' | 'proxy-failed';
  readonly mediaUrl: string;
  readonly mediaKey: string;
  readonly playbackRate: number;
  readonly muteVideo: boolean;
  /** Freeze, slow native clips and unready/failed proxies show output frames while holding video paused. */
  readonly frameDrivenPlayback: boolean;
  /** True for freeze clips (audio stays strictly silent). */
  readonly silent: boolean;
  readonly clipStartFrame: number;
  readonly clipDurationFrames: number;
  readonly fps: number;
  readonly overlay: ClipSpeedPreviewOverlay | null;
  readonly outputFrameToMediaSeconds: (frame: number, forPlayback?: boolean) => number;
  readonly mediaSecondsToOutputFrame: (seconds: number) => number;
  readonly onRetryTask?: (taskId: string) => void;
  readonly onPlaybackStateChange?: (state: {readonly playing: boolean; readonly frame: number; readonly silent: boolean}) =>
    void | Promise<(() => number | null) | void>;
}

export function clipNeedsPreviewMediaRpc(
  timeline: SpeedTimelineLike | null | undefined,
  clip: SpeedClipLike | null | undefined,
  asset: SpeedAssetLike | null | undefined,
): boolean {
  if (!timelineSpeedEnabled(timeline) || !clip || !asset) return false;
  if (isFreezeClip(clip)) return false;
  if (clip.sourceState === 'placeholder') return false;
  return typeof asset.mimeType === 'string' && asset.mimeType.startsWith('video/');
}

function buildOverlayFromProcessingItem(
  item: SpeedProcessingItem | null,
  t: Translator,
): ClipSpeedPreviewOverlay | null {
  if (!item || item.status === 'ready') return null;
  if (processingItemActive(item)) {
    const percent = item.status === 'running' && typeof item.progress === 'number'
      ? clamp(Math.round(item.progress), 0, 100)
      : null;
    const label = percent !== null
      ? t('speed.processing.clipProgress', {percent})
      : t('speed.processing.clipQueued');
    return {
      kind: 'processing',
      label: item.kind === 'optical' ? `${speedProcessingActiveLabel(item, t)} · ${label}` : label,
      percent,
      taskKind: item.kind,
    };
  }
  return {
    kind: 'failed',
    message: speedProcessingFailureSentence(item, t),
    canRetry: speedProcessingCanRetry(item),
    taskId: item.taskId,
  };
}

/** Builds the `ClipSpeedPreviewBinding` passed to `Preview.tsx` when
 * `capabilities.speed === true` and a video clip is active in the `source` tab.
 * Returns `null` whenever speed capability is off or the preview is not a speed clip. */
export function buildClipSpeedPreviewBinding(options: {
  readonly timeline: SpeedTimelineLike | null | undefined;
  readonly clip: SpeedClipLike | null | undefined;
  readonly asset: SpeedAssetLike | null | undefined;
  readonly sourceUrl: string;
  readonly fps: number;
  readonly media: PreviewMedia | null;
  readonly processingItems: readonly SpeedProcessingItem[];
  readonly t: Translator;
  readonly onRetryTask?: (taskId: string) => void;
  readonly onPlaybackStateChange?: ClipSpeedPreviewBinding['onPlaybackStateChange'];
}): ClipSpeedPreviewBinding | null {
  const {timeline, clip, asset, sourceUrl, fps, media, processingItems, t, onRetryTask, onPlaybackStateChange} = options;
  if (!timelineSpeedEnabled(timeline) || !clip || !asset || !sourceUrl) return null;
  if (clip.sourceState === 'placeholder') return null;
  if (typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith('video/')) return null;

  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const timing = clipTimingOf(clip);
  const compiled = compileClipTimeMapForPreview(clip, safeFps);
  const plan = compiled.ok ? compiled.value : null;

  // 1) Freeze clip: hold exact `clip.timing.sourceFrame`, silent audio, rAF clock on Play.
  if (timing?.profile === 'timeline-freeze-v1') {
    const holdSeconds = Math.max(0, Math.trunc(timing.sourceFrame)) / safeFps;
    return {
      mode: 'freeze',
      mediaUrl: sourceUrl,
      mediaKey: `freeze:${clip.id}:${timing.sourceFrame}:${clip.durationFrames}`,
      playbackRate: 1,
      muteVideo: true,
      frameDrivenPlayback: true,
      silent: true,
      clipStartFrame: clip.startFrame,
      clipDurationFrames: clip.durationFrames,
      fps: safeFps,
      overlay: null,
      outputFrameToMediaSeconds: () => holdSeconds,
      mediaSecondsToOutputFrame: () => clip.startFrame,
      onPlaybackStateChange,
    };
  }

  // 2) Proxy ready (curve / reverse): play proxy verbatim at 1× in output time domain.
  if (media?.mode === 'proxy' && media.status === 'ready') {
    const proxyDuration = media.durationFrames || clip.durationFrames;
    // If optical interpolation is still cooking (or failed) while un-interpolated preview plays, show status.
    const opticalItem = processingItems.find(item => item.clipId === clip.id && item.kind === 'optical' && item.status !== 'ready') ?? null;
    return {
      mode: 'proxy-ready',
      mediaUrl: media.url,
      mediaKey: `proxy:${clip.id}:${media.url}`,
      playbackRate: 1,
      muteVideo: true,
      frameDrivenPlayback: false,
      silent: false,
      clipStartFrame: clip.startFrame,
      clipDurationFrames: clip.durationFrames,
      fps: safeFps,
      overlay: buildOverlayFromProcessingItem(opticalItem, t),
      outputFrameToMediaSeconds: frame => clamp(frame - clip.startFrame, 0, proxyDuration) / safeFps,
      mediaSecondsToOutputFrame: seconds => clip.startFrame + clamp(Math.round(Math.max(0, seconds) * safeFps), 0, clip.durationFrames),
      onRetryTask,
      onPlaybackStateChange,
    };
  }

  // 3) Proxy pending or failed (curve / reverse before proxy is ready):
  //    Show 22-05 status overlay + seek original source frame-by-frame via shared time-map!
  const needsProxyByTiming = Boolean(
    timing?.profile === 'timeline-speed-v1'
    && (timing.basis.speed.kind === 'curve' || timing.view.direction === 'reverse'),
  );
  if (media?.mode === 'proxy') {
    const proxyProcessingItem: SpeedProcessingItem = {
      taskId: media.taskId,
      clipId: clip.id,
      kind: 'preview',
      status: media.status,
      ...(media.progress !== undefined ? {progress: media.progress} : {}),
      ...(media.reason !== undefined ? {reason: media.reason} : {}),
    };
    const fallbackItem = selectClipProcessingItem(processingItems, clip.id);
    const activeItem = media.status === 'failed' ? proxyProcessingItem : (proxyProcessingItem.progress !== undefined ? proxyProcessingItem : fallbackItem ?? proxyProcessingItem);
    const isFailed = media.status === 'failed';
    return {
      mode: isFailed ? 'proxy-failed' : 'proxy-pending',
      mediaUrl: sourceUrl,
      mediaKey: `proxy-wait:${clip.id}:${sourceUrl}:${timing ? timing.outputWindow.fromFrame : 0}`,
      playbackRate: 1,
      muteVideo: true,
      frameDrivenPlayback: true,
      silent: false,
      clipStartFrame: clip.startFrame,
      clipDurationFrames: clip.durationFrames,
      fps: safeFps,
      overlay: buildOverlayFromProcessingItem(activeItem, t),
      outputFrameToMediaSeconds: frame => sampleClipSourceAtTimelineFrame(clip, safeFps, frame, plan).sourceSeconds,
      mediaSecondsToOutputFrame: seconds => outputFrameFromSourceSeconds(clip, safeFps, seconds, plan),
      onRetryTask,
      onPlaybackStateChange,
    };
  }

  if (needsProxyByTiming) {
    const existingItem = selectClipProcessingItem(processingItems, clip.id);
    const overlay = buildOverlayFromProcessingItem(existingItem, t) ?? {
      kind: 'processing' as const,
      label: t('speed.processing.clipQueued'),
      percent: null,
      taskKind: 'preview' as const,
    };
    return {
      mode: existingItem?.status === 'failed' ? 'proxy-failed' : 'proxy-pending',
      mediaUrl: sourceUrl,
      mediaKey: `proxy-wait:${clip.id}:${sourceUrl}:${timing ? timing.outputWindow.fromFrame : 0}`,
      playbackRate: 1,
      muteVideo: true,
      frameDrivenPlayback: true,
      silent: false,
      clipStartFrame: clip.startFrame,
      clipDurationFrames: clip.durationFrames,
      fps: safeFps,
      overlay,
      outputFrameToMediaSeconds: frame => sampleClipSourceAtTimelineFrame(clip, safeFps, frame, plan).sourceSeconds,
      mediaSecondsToOutputFrame: seconds => outputFrameFromSourceSeconds(clip, safeFps, seconds, plan),
      onRetryTask,
      onPlaybackStateChange,
    };
  }

  // 4) Constant forward speed (native playbackRate + muted video + backend PCM sound).
  const rateObj = media?.mode === 'native'
    ? media.rate
    : timing?.profile === 'timeline-speed-v1' && timing.basis.speed.kind === 'constant'
      ? timing.basis.speed.rate
      : {numerator: 1, denominator: 1};
  const rateNum = clamp(rateToNumber(rateObj), 0.1, 10);
  const opticalItem = processingItems.find(item => item.clipId === clip.id && item.kind === 'optical' && item.status !== 'ready') ?? null;

  return {
    mode: 'native',
    mediaUrl: sourceUrl,
    mediaKey: `native:${clip.id}:${rateObj.numerator}/${rateObj.denominator}:${sourceUrl}`,
    playbackRate: rateNum,
    muteVideo: true,
    // Chrome can keep the initial native frame fixed for a substantial
    // portion of its slow presentation interval after play() succeeds.
    frameDrivenPlayback: rateNum <= 0.5,
    silent: false,
    clipStartFrame: clip.startFrame,
    clipDurationFrames: clip.durationFrames,
    fps: safeFps,
    overlay: buildOverlayFromProcessingItem(opticalItem, t),
    outputFrameToMediaSeconds: (frame, forPlayback) => {
      const sample = sampleClipSourceAtTimelineFrame(clip, safeFps, frame, plan);
      return forPlayback ? sample.continuousFrame / safeFps : sample.sourceSeconds;
    },
    mediaSecondsToOutputFrame: seconds => outputFrameFromSourceSeconds(clip, safeFps, seconds, plan),
    onRetryTask,
    onPlaybackStateChange,
  };
}
