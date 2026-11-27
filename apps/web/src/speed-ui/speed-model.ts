/** Pure speed-UI model: capability checks, log slider mapping, reduced rational
 * conversion, shared time-map compilation, log-PCHIP curve sampling, curve
 * edit constraints, and plain-language error/reason mapping.
 *
 * Uses `packages/contracts/src/timeline-time-map.ts` as the single source of
 * truth for rate limits, presets, duration, visible source ranges, and
 * playhead inverse mapping. Never writes project data.
 */
import {
  TIMELINE_SPEED_PRESETS,
  TIMELINE_TIME_MAP_BASIS_PROFILE,
  TIMELINE_TIME_MAP_INTERPOLATION,
  TIMELINE_TIME_MAP_LIMITS,
  compileTimeMap,
  initialTimeMap,
  instantiateSpeedPreset,
  projectSourceBoundaryToQ64,
  reverseTimeMap,
  timeMapPlanInfo,
  timeMapRootInfo,
  timeMapSourceAtOutputFrame,
  timeMapTailInverse,
  trimTimeMap,
} from '../../../../packages/contracts/src/timeline-time-map.ts';
import type {
  CompiledTimeMap,
  ContinuousSourcePosition,
  TimeMapBasis,
  TimeMapCurvePoint,
  TimeMapCurvePreset,
  TimeMapSourceBoundary,
  TimeMapSourceRange,
  TimeMapSpeed,
  TimeMapSpeedRate,
} from '../../../../packages/contracts/src/timeline-time-map.ts';
import type {
  ClipTiming,
  SequenceEditSpeedIntent,
  SpeedInterpolation,
  SpeedProcessingItem,
  SpeedProcessingReason,
  SpeedSetting,
} from '../../../../packages/contracts/src/timeline-speed.ts';
import {format5PanelErrorKey} from '../edit-ui/format5-panel-edits.ts';

export const SPEED_MIN_RATE = TIMELINE_TIME_MAP_LIMITS.minRate.numerator / TIMELINE_TIME_MAP_LIMITS.minRate.denominator;
export const SPEED_MAX_RATE = TIMELINE_TIME_MAP_LIMITS.maxRate.numerator / TIMELINE_TIME_MAP_LIMITS.maxRate.denominator;
export const SPEED_SLIDER_TICKS = Object.freeze([0.1, 0.5, 1, 2, 5, 10] as const);
export const SPEED_SLIDER_RESOLUTION = 1000;
export const DEFAULT_FREEZE_DURATION_FRAMES = 60;
export const SPEED_PRESET_LIST: readonly TimeMapCurvePreset[] = TIMELINE_SPEED_PRESETS;
export const CURVE_SVG_GEOMETRY = Object.freeze({
  width: 264,
  height: 128,
  padLeft: 34,
  padRight: 12,
  padTop: 14,
  padBottom: 14,
  plotWidth: 218,
  plotHeight: 100,
});

export interface SpeedTimelineLike {
  readonly fps?: number;
  readonly capabilities?: {readonly speed?: unknown} | null;
  readonly [key: string]: unknown;
}

export interface SpeedClipLike {
  readonly id: string;
  readonly name?: string;
  readonly trackId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame?: number;
  readonly sourceState?: string;
  readonly timing?: ClipTiming | null;
  readonly [key: string]: unknown;
}

export interface SpeedAssetLike {
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

/** Strict capability gate (F7): returns true ONLY when `capabilities.speed === true`. */
export function timelineSpeedEnabled(timeline: SpeedTimelineLike | null | undefined): boolean {
  return Boolean(timeline && timeline.capabilities && timeline.capabilities.speed === true);
}

export function clipTimingOf(clip: SpeedClipLike | null | undefined): ClipTiming | null {
  const timing = clip?.timing;
  if (!timing || typeof timing !== 'object') return null;
  if (timing.profile === 'timeline-freeze-v1' || timing.profile === 'timeline-speed-v1') return timing;
  return null;
}

export function isFreezeClip(clip: SpeedClipLike | null | undefined): boolean {
  return clipTimingOf(clip)?.profile === 'timeline-freeze-v1';
}

export function isStaticImageAsset(asset: SpeedAssetLike | null | undefined): boolean {
  return typeof asset?.mimeType === 'string' && asset.mimeType.startsWith('image/');
}

/** Video and audio clips support speed; freeze clips, placeholders, and static images do not. */
export function clipSupportsSpeed(
  clip: SpeedClipLike | null | undefined,
  asset: SpeedAssetLike | null | undefined,
): boolean {
  if (!clip) return false;
  if (isFreezeClip(clip)) return false;
  if (clip.sourceState === 'placeholder') return false;
  if (isStaticImageAsset(asset)) return false;
  return true;
}

/** Freeze frame requires a ready video clip (not freeze, image, audio, or placeholder)
 * AND the playhead strictly inside `[clip.startFrame, clip.startFrame + clip.durationFrames)`. */
export function canFreezeClipAtPlayhead(
  clip: SpeedClipLike | null | undefined,
  asset: SpeedAssetLike | null | undefined,
  trackKind: string | undefined,
  playhead: number,
): boolean {
  if (!clipSupportsSpeed(clip, asset)) return false;
  if (trackKind === 'audio') return false;
  if (typeof asset?.mimeType === 'string' && asset.mimeType.startsWith('audio/')) return false;
  const frame = Math.round(playhead);
  return Number.isSafeInteger(frame)
    && frame >= clip!.startFrame
    && frame < clip!.startFrame + clip!.durationFrames;
}

/** Whether a clip's saved timing may require background processing (reverse, optical flow, or curve preview proxy). */
export function clipNeedsSpeedProcessing(clip: SpeedClipLike | null | undefined): boolean {
  const timing = clipTimingOf(clip);
  if (!timing || timing.profile !== 'timeline-speed-v1') return false;
  return timing.view.direction === 'reverse'
    || timing.interpolation === 'optical'
    || timing.basis.speed.kind === 'curve';
}

export type PitchShiftLockReason = 'constant-range' | 'curve';

export interface PitchShiftControlState {
  readonly locked: boolean;
  readonly checked: boolean;
  readonly lockReason: PitchShiftLockReason | null;
  readonly tooltipKey: 'speed.pitchShift.constantOnlyHint' | 'speed.pitchShift.curveOnlyHint' | null;
}

/** Exact rational check: keep-pitch is only available for constant speed in 2×–4×. */
export function isConstantKeepPitchRate(rate: TimeMapSpeedRate): boolean {
  return rate.numerator >= rate.denominator * 2 && rate.numerator <= rate.denominator * 4;
}

/** Resolves UI state of «声音变调» while keeping the user's stored `setting.pitchShift` untouched. */
export function resolvePitchShiftControl(
  mode: 'constant' | 'curve',
  setting: SpeedSetting,
): PitchShiftControlState {
  if (mode === 'curve' || setting.speed.kind === 'curve') {
    return {
      locked: true,
      checked: true,
      lockReason: 'curve',
      tooltipKey: 'speed.pitchShift.curveOnlyHint',
    };
  }
  if (isConstantKeepPitchRate(setting.speed.rate)) {
    return {
      locked: false,
      checked: setting.pitchShift,
      lockReason: null,
      tooltipKey: null,
    };
  }
  return {
    locked: true,
    checked: true,
    lockReason: 'constant-range',
    tooltipKey: 'speed.pitchShift.constantOnlyHint',
  };
}

// ---------------------------------------------------------------------------
// Logarithmic slider mapping & reduced rational parsing.
// ---------------------------------------------------------------------------

const LOG_MIN = Math.log10(SPEED_MIN_RATE); // -1
const LOG_MAX = Math.log10(SPEED_MAX_RATE); // +1
const LOG_SPAN = LOG_MAX - LOG_MIN;         // 2

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Maps rate in [0.1, 10] to normalized logarithmic position [0, 1].
 * 0.1 -> 0, 1.0 -> 0.5, 10.0 -> 1.0. */
export function rateToLogNorm(rate: number): number {
  if (!Number.isFinite(rate) || rate <= SPEED_MIN_RATE) return 0;
  if (rate >= SPEED_MAX_RATE) return 1;
  return clamp((Math.log10(rate) - LOG_MIN) / LOG_SPAN, 0, 1);
}

/** Inverse of `rateToLogNorm`: maps normalized [0, 1] back to [0.1, 10] rounded
 * cleanly to two decimals (snapping tiny float drift on 1.0/ticks). */
export function logNormToRate(norm: number): number {
  const clamped = clamp(Number.isFinite(norm) ? norm : 0.5, 0, 1);
  const raw = 10 ** (LOG_MIN + clamped * LOG_SPAN);
  const rounded = Math.round(raw * 100) / 100;
  return clamp(rounded, SPEED_MIN_RATE, SPEED_MAX_RATE);
}

export function rateToNumber(rate: TimeMapSpeedRate): number {
  return rate.numerator / rate.denominator;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1n;
}

/** Converts a user speed input (number or decimal string, optional trailing ×/x)
 * into a reduced rational accepted by `timeline-time-map.ts`. Rejects out-of-range
 * or non-finite values locally without sending any RPC. */
export function parseRateToRational(
  input: number | string,
): {readonly ok: true; readonly rate: TimeMapSpeedRate; readonly numeric: number}
 | {readonly ok: false; readonly code: 'INVALID_RATE'} {
  const text = (typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input)
    .trim()
    .replace(/[×x]$/iu, '')
    .trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) return {ok: false, code: 'INVALID_RATE'};
  const dot = text.indexOf('.');
  const fracLen = dot < 0 ? 0 : text.length - dot - 1;
  // Cap excessive fractional digits to keep denominator within maxRateTerm (1,000,000).
  const normalizedText = fracLen > 6 ? Number(text).toFixed(6) : text;
  const normDot = normalizedText.indexOf('.');
  const digits = normDot < 0 ? normalizedText : normalizedText.slice(0, normDot) + normalizedText.slice(normDot + 1);
  const scale = normDot < 0 ? 0 : normalizedText.length - normDot - 1;
  let num = BigInt(digits || '0');
  let den = 10n ** BigInt(scale);
  if (num <= 0n || den <= 0n) return {ok: false, code: 'INVALID_RATE'};
  const g = gcdBigInt(num, den);
  num /= g;
  den /= g;
  // Range check: 1/10 <= num/den <= 10/1
  if (num * 10n < den || num > den * 10n) return {ok: false, code: 'INVALID_RATE'};
  const maxTerm = BigInt(TIMELINE_TIME_MAP_LIMITS.maxRateTerm);
  if (num > maxTerm || den > maxTerm) {
    // Fall back to 2-decimal precision within safe reduced bounds.
    const rounded = Math.round(Number(text) * 100);
    if (!Number.isSafeInteger(rounded) || rounded < 10 || rounded > 1000) return {ok: false, code: 'INVALID_RATE'};
    const g2 = gcdBigInt(BigInt(rounded), 100n);
    num = BigInt(rounded) / g2;
    den = 100n / g2;
  }
  const numerator = Number(num);
  const denominator = Number(den);
  return {ok: true, rate: {numerator, denominator}, numeric: numerator / denominator};
}

/** Formats a rate badge per F4: 1 decimal when exact at 1 decimal place
 * (`2.0×`, `0.5×`, `1.0×`), otherwise 2 decimals (`1.25×`, `0.33×`). */
export function formatSpeedRateLabel(rate: TimeMapSpeedRate | number): string {
  const value = typeof rate === 'number' ? rate : rateToNumber(rate);
  const rounded2 = Math.round(value * 100) / 100;
  const oneDecimal = Math.abs(rounded2 * 10 - Math.round(rounded2 * 10)) < 1e-9;
  return `${oneDecimal ? rounded2.toFixed(1) : rounded2.toFixed(2)}×`;
}

/** Formats a numeric input display without the trailing `×`. */
export function formatSpeedRateInput(rate: TimeMapSpeedRate | number): string {
  return formatSpeedRateLabel(rate).slice(0, -1);
}

/** Formats original duration seconds like `7.0` / `2.5` (matches 22-01 / 22-02 `原 7.0 s`). */
export function formatOriginalSeconds(frames: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const seconds = Math.max(0, frames) / safeFps;
  return seconds.toFixed(1);
}

// ---------------------------------------------------------------------------
// Speed settings helpers & interpolation visibility.
// ---------------------------------------------------------------------------

export function defaultSpeedSetting(): SpeedSetting {
  return {
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
    direction: 'forward',
    pitchShift: false,
    interpolation: 'off',
  };
}

export function isDefaultSpeedSetting(setting: SpeedSetting): boolean {
  return setting.speed.kind === 'constant'
    && setting.speed.rate.numerator === 1
    && setting.speed.rate.denominator === 1
    && setting.direction === 'forward'
    && !setting.pitchShift
    && setting.interpolation === 'off';
}

export function speedRateIsSlow(rate: TimeMapSpeedRate): boolean {
  return rate.numerator < rate.denominator;
}

/** True when constant rate < 1× OR any curve control point < 1× (log-PCHIP is
 * shape-preserving, so a curve dips below 1× iff at least one control point < 1×). */
export function speedNeedsInterpolation(speed: TimeMapSpeed): boolean {
  if (speed.kind === 'constant') return speedRateIsSlow(speed.rate);
  return speed.points.some(point => speedRateIsSlow(point.rate));
}

export function settingFromClip(clip: SpeedClipLike | null | undefined): SpeedSetting {
  const timing = clipTimingOf(clip);
  if (!timing || timing.profile !== 'timeline-speed-v1') return defaultSpeedSetting();
  const speed: TimeMapSpeed = timing.basis.speed.kind === 'constant'
    ? {kind: 'constant', rate: {...timing.basis.speed.rate}}
    : {
        kind: 'curve',
        interpolation: TIMELINE_TIME_MAP_INTERPOLATION,
        presetId: timing.basis.speed.presetId,
        points: timing.basis.speed.points.map(point => ({sourceFrame: point.sourceFrame, rate: {...point.rate}})),
      };
  return {
    speed,
    direction: timing.view.direction,
    pitchShift: timing.pitchShift,
    interpolation: timing.interpolation,
  };
}

/** Normalizes a setting before sending to `sequence.preview`: when effective
 * rate is never < 1×, submits `interpolation: 'off'` per contract. */
export function normalizeSpeedSettingForSubmit(setting: SpeedSetting): SpeedSetting {
  return {
    speed: setting.speed.kind === 'constant'
      ? {kind: 'constant', rate: {...setting.speed.rate}}
      : {
          kind: 'curve',
          interpolation: TIMELINE_TIME_MAP_INTERPOLATION,
          presetId: setting.speed.presetId,
          points: setting.speed.points.map(point => ({sourceFrame: point.sourceFrame, rate: {...point.rate}})),
        },
    direction: setting.direction,
    pitchShift: setting.pitchShift,
    interpolation: speedNeedsInterpolation(setting.speed) ? setting.interpolation : 'off',
  };
}

export function buildClipSpeedIntent(clipId: string, setting: SpeedSetting): SequenceEditSpeedIntent {
  return {
    side: 'timeline',
    operation: {
      kind: 'clip-speed',
      clipId,
      setting: normalizeSpeedSettingForSubmit(setting),
    },
  };
}

export function buildFreezeFrameIntent(
  clipId: string,
  atFrame: number,
  durationFrames = DEFAULT_FREEZE_DURATION_FRAMES,
): SequenceEditSpeedIntent {
  return {
    side: 'timeline',
    operation: {
      kind: 'freeze-frame',
      clipId,
      atFrame: Math.max(0, Math.round(atFrame)),
      durationFrames,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared time-map compilation for visible source range, original 1× length,
// live duration preview, and playhead source mapping.
// ---------------------------------------------------------------------------

function intBoundary(frame: number): TimeMapSourceBoundary {
  return {kind: 'rational', numerator: String(Math.max(0, Math.trunc(frame))), denominator: '1'};
}

function boundaryFromContinuous(position: ContinuousSourcePosition, fallbackFrame: number): TimeMapSourceBoundary {
  if (position.kind === 'exact') {
    return {kind: 'rational', numerator: position.numerator, denominator: position.denominator};
  }
  const projected = projectSourceBoundaryToQ64(position);
  if (projected.ok) return projected.value.boundary;
  return intBoundary(fallbackFrame);
}

function reconstructSavedPlan(timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>): CompiledTimeMap | null {
  const compiled = compileTimeMap(timing.basis);
  if (!compiled.ok) return null;
  const root = compiled.value;
  const fullView = timing.view.loTime.anchor === 'start'
    && timing.view.loTime.offsetOutputFrames === 0
    && timing.view.hiTime.anchor === 'end'
    && timing.view.hiTime.offsetOutputFrames === 0;
  let plan = initialTimeMap(root, fullView ? timing.view.direction : 'forward');
  if (!fullView) {
    const lo = timing.view.loTime.anchor === 'start'
      ? timing.view.loTime.offsetOutputFrames
      : root.durationFrames + timing.view.loTime.offsetOutputFrames;
    const hi = timing.view.hiTime.anchor === 'start'
      ? timing.view.hiTime.offsetOutputFrames
      : root.durationFrames + timing.view.hiTime.offsetOutputFrames;
    const from = clamp(Math.trunc(lo), 0, Math.max(0, root.durationFrames - 1));
    const to = clamp(Math.trunc(hi), from + 1, root.durationFrames);
    const trimmed = trimTimeMap(plan, from, to);
    if (!trimmed.ok) return null;
    plan = timing.view.direction === 'reverse' ? reverseTimeMap(trimmed.value) : trimmed.value;
  }
  const winFrom = clamp(timing.outputWindow.fromFrame, 0, Math.max(0, plan.durationFrames - 1));
  const winTo = clamp(timing.outputWindow.toFrame, winFrom + 1, plan.durationFrames);
  if (winFrom > 0 || winTo < plan.durationFrames) {
    const windowed = trimTimeMap(plan, winFrom, winTo);
    if (windowed.ok) plan = windowed.value;
  }
  return plan;
}

export interface ClipSpeedGeometry {
  readonly sourceRange: TimeMapSourceRange;
  readonly sourceStartFrame: number;
  readonly sourceEndFrame: number;
  readonly originalFrames: number;
  readonly fps: number;
  readonly savedPlan: CompiledTimeMap | null;
}

/** Computes the clip's visible source range and 1× original duration using the
 * shared `timeline-time-map.ts` compiler. */
export function resolveClipSpeedGeometry(clip: SpeedClipLike, fps: number): ClipSpeedGeometry {
  const safeFps = Number.isSafeInteger(fps) && fps > 0 ? fps : 30;
  const fallbackStart = Math.max(0, Math.trunc(clip.sourceInFrame ?? 0));
  const fallbackSpan = Math.max(1, Math.trunc(clip.durationFrames));
  const fallbackEnd = fallbackStart + fallbackSpan;
  const fallbackRange: TimeMapSourceRange = {start: intBoundary(fallbackStart), end: intBoundary(fallbackEnd)};
  const timing = clipTimingOf(clip);
  if (!timing || timing.profile !== 'timeline-speed-v1') {
    return {
      sourceRange: fallbackRange,
      sourceStartFrame: fallbackStart,
      sourceEndFrame: fallbackEnd,
      originalFrames: fallbackSpan,
      fps: safeFps,
      savedPlan: null,
    };
  }
  const plan = reconstructSavedPlan(timing);
  if (!plan) {
    return {
      sourceRange: timing.basis.sourceRange,
      sourceStartFrame: fallbackStart,
      sourceEndFrame: fallbackEnd,
      originalFrames: fallbackSpan,
      fps: safeFps,
      savedPlan: null,
    };
  }
  const info = timeMapPlanInfo(plan);
  if (!info.ok) {
    return {
      sourceRange: timing.basis.sourceRange,
      sourceStartFrame: fallbackStart,
      sourceEndFrame: fallbackEnd,
      originalFrames: fallbackSpan,
      fps: safeFps,
      savedPlan: plan,
    };
  }
  const rootInfo = timeMapRootInfo(plan.root);
  const fullBasisView = timing.view.loTime.anchor === 'start'
    && timing.view.loTime.offsetOutputFrames === 0
    && timing.view.hiTime.anchor === 'end'
    && timing.view.hiTime.offsetOutputFrames === 0
    && timing.outputWindow.fromFrame === 0
    && timing.outputWindow.toFrame === rootInfo.durationFrames;

  let startFrame = rootInfo.frameRange.start;
  let endFrame = Math.max(startFrame + 1, rootInfo.frameRange.end + 1);
  let visibleRange: TimeMapSourceRange = timing.basis.sourceRange;

  if (!fullBasisView) {
    const startInv = timeMapTailInverse(plan, {numerator: String(plan.outputWindow.fromFrame), denominator: '1'}, {tailInverse: 'earliest'});
    const endInv = timeMapTailInverse(plan, {numerator: String(plan.outputWindow.toFrame), denominator: '1'}, {tailInverse: 'latest'});
    const visible = info.value.visibleSourceRange;
    startFrame = visible.sourceWindow.startFrame;
    endFrame = Math.max(startFrame + 1, visible.sourceWindow.endFrame);
    if (startInv.ok && endInv.ok) {
      const earlier = plan.direction === 'forward' ? startInv.value.position : endInv.value.position;
      const later = plan.direction === 'forward' ? endInv.value.position : startInv.value.position;
      visibleRange = {
        start: boundaryFromContinuous(earlier, startFrame),
        end: boundaryFromContinuous(later, endFrame),
      };
      const earlierNum = earlier.kind === 'exact' ? Number(earlier.numerator) / Number(earlier.denominator) : earlier.value;
      const laterNum = later.kind === 'exact' ? Number(later.numerator) / Number(later.denominator) : later.value;
      startFrame = Math.max(0, Math.floor(earlierNum));
      endFrame = Math.max(startFrame + 1, Math.ceil(laterNum));
    } else {
      visibleRange = {
        start: boundaryFromContinuous(visible.lo, startFrame),
        end: boundaryFromContinuous(visible.hi, endFrame),
      };
    }
  }

  const identityBasis: TimeMapBasis = {
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: timing.basis.sourceFps,
    outputFps: timing.basis.outputFps,
    sourceRange: visibleRange,
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
  };
  const compiled1x = compileTimeMap(identityBasis);
  const originalFrames = compiled1x.ok ? compiled1x.value.durationFrames : Math.max(1, endFrame - startFrame);
  return {
    sourceRange: visibleRange,
    sourceStartFrame: startFrame,
    sourceEndFrame: endFrame,
    originalFrames,
    fps: safeFps,
    savedPlan: plan,
  };
}

export interface LocalSpeedPreview {
  readonly ok: true;
  readonly durationFrames: number;
  readonly plan: CompiledTimeMap;
}

/** Locally compiles a candidate `SpeedSetting` through `compileTimeMap` so the
 * inspector can show exact live duration while dragging slider/curve points. */
export function previewLocalSpeedSetting(
  geometry: ClipSpeedGeometry,
  setting: SpeedSetting,
): LocalSpeedPreview | {readonly ok: false; readonly code: string} {
  const timebase = {fpsNumerator: geometry.fps, fpsDenominator: 1};
  // For curve settings, ensure curve domain spans the basis sourceRange.
  const sourceRange: TimeMapSourceRange = setting.speed.kind === 'curve' && setting.speed.points.length >= 2
    ? {
        start: intBoundary(setting.speed.points[0]!.sourceFrame),
        end: intBoundary(setting.speed.points[setting.speed.points.length - 1]!.sourceFrame),
      }
    : geometry.sourceRange;
  const basis: TimeMapBasis = {
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: timebase,
    outputFps: timebase,
    sourceRange,
    speed: setting.speed,
  };
  const compiled = compileTimeMap(basis);
  if (!compiled.ok) return {ok: false, code: compiled.code};
  const plan = initialTimeMap(compiled.value, setting.direction);
  return {ok: true, durationFrames: plan.durationFrames, plan};
}

/** Maps the timeline playhead frame to normalized [0, 1] on the clip's source
 * axis (for the vertical playhead line inside the curve editor). Returns null
 * when the playhead is outside the clip. */
export function playheadSourceNormOnClip(
  clip: SpeedClipLike,
  geometry: ClipSpeedGeometry,
  plan: CompiledTimeMap | null,
  playhead: number,
): number | null {
  const localOutput = Math.round(playhead) - clip.startFrame;
  const duration = plan?.durationFrames ?? clip.durationFrames;
  if (localOutput < 0 || localOutput >= duration) return null;
  const span = Math.max(1, geometry.sourceEndFrame - geometry.sourceStartFrame);
  if (!plan) return clamp((localOutput + 0.5) / Math.max(1, duration), 0, 1);
  const sample = timeMapSourceAtOutputFrame(plan, localOutput);
  if (!sample.ok) return null;
  const continuous = sample.value.source.kind === 'exact'
    ? Number(sample.value.source.numerator) / Number(sample.value.source.denominator)
    : sample.value.source.value;
  return clamp((continuous - geometry.sourceStartFrame) / span, 0, 1);
}

// ---------------------------------------------------------------------------
// Curve preset instantiation, log-PCHIP SVG sampling, and point constraints.
// ---------------------------------------------------------------------------

export function instantiatePresetForClip(
  presetId: string,
  sourceStartFrame: number,
  sourceEndFrame: number,
): {readonly ok: true; readonly speed: TimeMapSpeed} | {readonly ok: false; readonly code: string} {
  const span = sourceEndFrame - sourceStartFrame;
  const end = span < 2 ? sourceStartFrame + 2 : sourceEndFrame;
  const result = instantiateSpeedPreset(presetId, sourceStartFrame, end);
  if (!result.ok) return {ok: false, code: result.code};
  return {ok: true, speed: result.value};
}

/** Evaluates log-speed PCHIP across control points (same Fritsch-Carlson slope
 * rules as `timeline-time-map.ts`) to produce smooth SVG preview coordinates. */
export function sampleLogPchipCurve(
  points: readonly {readonly x: number; readonly rate: number}[],
  samples = 48,
): readonly {readonly x: number; readonly yNorm: number; readonly rate: number}[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const rate = clamp(points[0]!.rate, SPEED_MIN_RATE, SPEED_MAX_RATE);
    return [{x: points[0]!.x, yNorm: rateToLogNorm(rate), rate}];
  }
  const n = points.length;
  const xs = points.map(p => p.x);
  const ys = points.map(p => Math.log(clamp(p.rate, SPEED_MIN_RATE, SPEED_MAX_RATE)));
  const hs = new Array<number>(n - 1);
  const slopes = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    hs[i] = Math.max(1e-9, xs[i + 1]! - xs[i]!);
    slopes[i] = (ys[i + 1]! - ys[i]!) / hs[i]!;
  }
  const ms = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const left = slopes[i - 1]!, right = slopes[i]!;
    if (left * right > 0) {
      const a = 2 * hs[i]! + hs[i - 1]!;
      const b = hs[i]! + 2 * hs[i - 1]!;
      ms[i] = (a + b) / (a / left + b / right);
    }
  }
  const endpointSlope = (left: number, right: number, first: number, second: number): number => {
    let value = ((2 * left + right) * first - left * second) / (left + right);
    if (value * first <= 0) value = 0;
    else if (first * second < 0 && Math.abs(value) > 3 * Math.abs(first)) value = 3 * first;
    return value;
  };
  if (slopes.length === 1) {
    ms[0] = slopes[0]!;
    ms[1] = slopes[0]!;
  } else {
    ms[0] = endpointSlope(hs[0]!, hs[1]!, slopes[0]!, slopes[1]!);
    ms[n - 1] = endpointSlope(hs[n - 2]!, hs[n - 3]!, slopes[n - 2]!, slopes[n - 3]!);
  }

  const startX = xs[0]!, endX = xs[n - 1]!;
  const span = Math.max(1e-9, endX - startX);
  const count = Math.max(2, samples);
  const out: {x: number; yNorm: number; rate: number}[] = [];
  for (let s = 0; s <= count; s++) {
    const u = startX + (span * s) / count;
    let seg = 0;
    while (seg < n - 2 && xs[seg + 1]! < u) seg++;
    const h = hs[seg]!;
    const t = clamp((u - xs[seg]!) / h, 0, 1);
    const t2 = t * t, t3 = t2 * t;
    const logVal = (2 * t3 - 3 * t2 + 1) * ys[seg]!
      + (t3 - 2 * t2 + t) * h * ms[seg]!
      + (-2 * t3 + 3 * t2) * ys[seg + 1]!
      + (t3 - t2) * h * ms[seg + 1]!;
    const rate = clamp(Math.exp(logVal), SPEED_MIN_RATE, SPEED_MAX_RATE);
    out.push({x: (u - startX) / span, yNorm: rateToLogNorm(rate), rate});
  }
  return out;
}

export type CurveEditError = 'POINT_LIMIT' | 'ENDPOINT_FIXED' | 'INVALID_RATE' | 'POINT_ORDER';
export type CurveEditResult =
  | {readonly ok: true; readonly points: readonly TimeMapCurvePoint[]; readonly selectedIndex: number}
  | {readonly ok: false; readonly error: CurveEditError};

/** Validates a curve point array against shared limits (2..32 points, strictly
 * increasing frames, endpoints fixed to `[start, end]`, rates in [0.1, 10]). */
export function validateCurvePointsLocal(
  points: readonly TimeMapCurvePoint[],
  sourceStartFrame: number,
  sourceEndFrame: number,
): CurveEditError | null {
  if (points.length < 2 || points.length > TIMELINE_TIME_MAP_LIMITS.maxCurvePoints) return 'POINT_LIMIT';
  if (points[0]!.sourceFrame !== sourceStartFrame || points[points.length - 1]!.sourceFrame !== sourceEndFrame) {
    return 'POINT_ORDER';
  }
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!;
    if (!Number.isSafeInteger(pt.sourceFrame) || pt.sourceFrame < sourceStartFrame || pt.sourceFrame > sourceEndFrame) {
      return 'POINT_ORDER';
    }
    if (i > 0 && pt.sourceFrame <= points[i - 1]!.sourceFrame) return 'POINT_ORDER';
    const r = pt.rate;
    if (r.numerator * 10 < r.denominator || r.numerator > r.denominator * 10 || r.numerator <= 0 || r.denominator <= 0) {
      return 'INVALID_RATE';
    }
  }
  return null;
}

/** Adds an interior point; rejects when already at 32 points or no valid integer
 * frame slot exists strictly between neighbors. */
export function addCurveControlPoint(
  points: readonly TimeMapCurvePoint[],
  targetFrame: number,
  targetRate: number,
): CurveEditResult {
  if (points.length >= TIMELINE_TIME_MAP_LIMITS.maxCurvePoints) return {ok: false, error: 'POINT_LIMIT'};
  const parsed = parseRateToRational(targetRate);
  if (!parsed.ok) return {ok: false, error: 'INVALID_RATE'};
  const start = points[0]!.sourceFrame;
  const end = points[points.length - 1]!.sourceFrame;
  const rounded = Math.round(targetFrame);
  if (rounded <= start || rounded >= end) return {ok: false, error: 'POINT_ORDER'};
  const occupied = new Set(points.map(p => p.sourceFrame));
  let frame = rounded;
  if (occupied.has(frame)) {
    // Search nearby integer slot strictly inside (start, end) without collapsing order.
    let found: number | null = null;
    for (let delta = 1; delta <= 4; delta++) {
      if (frame + delta < end && !occupied.has(frame + delta)) { found = frame + delta; break; }
      if (frame - delta > start && !occupied.has(frame - delta)) { found = frame - delta; break; }
    }
    if (found === null) return {ok: false, error: 'POINT_ORDER'};
    frame = found;
  }
  const next = [...points, {sourceFrame: frame, rate: parsed.rate}].sort((a, b) => a.sourceFrame - b.sourceFrame);
  const selectedIndex = next.findIndex(p => p.sourceFrame === frame);
  return {ok: true, points: next, selectedIndex};
}

/** Moves a control point. Endpoints keep their exact `sourceFrame` and only
 * change rate; interior points stay strictly between their left/right neighbors. */
export function moveCurveControlPoint(
  points: readonly TimeMapCurvePoint[],
  index: number,
  nextFrame: number,
  nextRate: number,
): CurveEditResult {
  if (index < 0 || index >= points.length) return {ok: false, error: 'POINT_ORDER'};
  const parsed = parseRateToRational(nextRate);
  if (!parsed.ok) return {ok: false, error: 'INVALID_RATE'};
  const isEndpoint = index === 0 || index === points.length - 1;
  let frame = points[index]!.sourceFrame;
  if (!isEndpoint) {
    const minFrame = points[index - 1]!.sourceFrame + 1;
    const maxFrame = points[index + 1]!.sourceFrame - 1;
    if (minFrame > maxFrame) return {ok: false, error: 'POINT_ORDER'};
    frame = clamp(Math.round(nextFrame), minFrame, maxFrame);
  }
  const next = points.map((pt, i) => (i === index ? {sourceFrame: frame, rate: parsed.rate} : pt));
  return {ok: true, points: next, selectedIndex: index};
}

/** Deletes a control point; endpoints (first & last) cannot be deleted. */
export function deleteCurveControlPoint(
  points: readonly TimeMapCurvePoint[],
  index: number,
): CurveEditResult {
  if (index <= 0 || index >= points.length - 1) return {ok: false, error: 'ENDPOINT_FIXED'};
  const next = points.filter((_, i) => i !== index);
  return {ok: true, points: next, selectedIndex: Math.min(index, next.length - 1)};
}

export interface CurveSvgRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CurveSvgCtm {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Exact comparison between two curve point arrays (frame & rational rate). */
export function curvePointsEqual(
  a: readonly TimeMapCurvePoint[],
  b: readonly TimeMapCurvePoint[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.sourceFrame !== right.sourceFrame) return false;
    if (left.rate.numerator * right.rate.denominator !== right.rate.numerator * left.rate.denominator) return false;
  }
  return true;
}

/** Converts CSS client coordinates to SVG viewBox coordinates, honoring `getScreenCTM()`
 * when present and falling back to SVG's default `preserveAspectRatio="xMidYMid meet"`
 * letterbox mapping so horizontal padding never shifts source frames. */
export function clientPointToCurveSvg(
  clientX: number,
  clientY: number,
  rect: CurveSvgRect,
  ctm?: CurveSvgCtm | null,
): {readonly x: number; readonly y: number} | null {
  if (ctm) {
    const det = ctm.a * ctm.d - ctm.b * ctm.c;
    if (Number.isFinite(det) && Math.abs(det) > 1e-9) {
      const dx = clientX - ctm.e;
      const dy = clientY - ctm.f;
      return {
        x: (ctm.d * dx - ctm.c * dy) / det,
        y: (-ctm.b * dx + ctm.a * dy) / det,
      };
    }
  }
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / CURVE_SVG_GEOMETRY.width, rect.height / CURVE_SVG_GEOMETRY.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = (rect.width - CURVE_SVG_GEOMETRY.width * scale) / 2;
  const offsetY = (rect.height - CURVE_SVG_GEOMETRY.height * scale) / 2;
  return {
    x: (clientX - rect.left - offsetX) / scale,
    y: (clientY - rect.top - offsetY) / scale,
  };
}

/** Maps an SVG viewBox point inside the plot area to `(frame, rate)` for point insertion. */
export function curveSvgPointToCoords(
  svgPoint: {readonly x: number; readonly y: number},
  curveStartFrame: number,
  curveEndFrame: number,
): {readonly frame: number; readonly rate: number} {
  const curveSpan = Math.max(1, curveEndFrame - curveStartFrame);
  const normX = clamp((svgPoint.x - CURVE_SVG_GEOMETRY.padLeft) / CURVE_SVG_GEOMETRY.plotWidth, 0, 1);
  const normY = clamp(1 - (svgPoint.y - CURVE_SVG_GEOMETRY.padTop) / CURVE_SVG_GEOMETRY.plotHeight, 0, 1);
  return {
    frame: Math.round(curveStartFrame + normX * curveSpan),
    rate: logNormToRate(normY),
  };
}

/** Computes dragged control-point coordinates relative to the pointer-down anchor
 * so a purely vertical drag preserves `startPoint.sourceFrame` without rounding drift
 * and a purely horizontal drag preserves rate. */
export function curveDragTargetCoords(
  startPoint: TimeMapCurvePoint,
  startSvg: {readonly x: number; readonly y: number},
  currentSvg: {readonly x: number; readonly y: number},
  curveStartFrame: number,
  curveEndFrame: number,
): {readonly frame: number; readonly rate: number} {
  const curveSpan = Math.max(1, curveEndFrame - curveStartFrame);
  const deltaSvgX = currentSvg.x - startSvg.x;
  const deltaSvgY = currentSvg.y - startSvg.y;
  const frame = Math.abs(deltaSvgX) < 1e-6
    ? startPoint.sourceFrame
    : clamp(
        Math.round(startPoint.sourceFrame + (deltaSvgX / CURVE_SVG_GEOMETRY.plotWidth) * curveSpan),
        curveStartFrame,
        curveEndFrame,
      );
  const startRate = rateToNumber(startPoint.rate);
  if (Math.abs(deltaSvgY) < 1e-6) {
    return {frame, rate: startRate};
  }
  const startNormY = rateToLogNorm(startRate);
  const nextNormY = clamp(startNormY - deltaSvgY / CURVE_SVG_GEOMETRY.plotHeight, 0, 1);
  return {frame, rate: logNormToRate(nextNormY)};
}

/** Exact comparison between two speed settings (rate/curve points, direction,
 * pitchShift, and interpolation) so unchanged slider/key actions skip commits. */
export function speedSettingsEqual(a: SpeedSetting, b: SpeedSetting): boolean {
  if (a.direction !== b.direction || a.pitchShift !== b.pitchShift || a.interpolation !== b.interpolation) {
    return false;
  }
  if (a.speed.kind !== b.speed.kind) return false;
  if (a.speed.kind === 'constant' && b.speed.kind === 'constant') {
    return a.speed.rate.numerator * b.speed.rate.denominator === b.speed.rate.numerator * a.speed.rate.denominator;
  }
  if (a.speed.kind === 'curve' && b.speed.kind === 'curve') {
    return a.speed.presetId === b.speed.presetId && curvePointsEqual(a.speed.points, b.speed.points);
  }
  return false;
}

/** Nudges a curve control point's rate by one keyboard step. Reports
 * `changed: false` when already at the 0.1× floor (down) or 10× ceiling (up)
 * so keyboard nudging clamps silently with zero preview/commit requests. */
export function nudgeCurveControlPointRate(
  points: readonly TimeMapCurvePoint[],
  index: number,
  direction: 'up' | 'down',
  coarse = false,
): {readonly ok: true; readonly changed: boolean; readonly points: readonly TimeMapCurvePoint[]; readonly selectedIndex: number}
 | {readonly ok: false; readonly error: CurveEditError} {
  if (index < 0 || index >= points.length) return {ok: false, error: 'POINT_ORDER'};
  const current = points[index]!;
  if (direction === 'up' && current.rate.numerator >= current.rate.denominator * 10) {
    return {ok: true, changed: false, points, selectedIndex: index};
  }
  if (direction === 'down' && current.rate.numerator * 10 <= current.rate.denominator) {
    return {ok: true, changed: false, points, selectedIndex: index};
  }
  const norm = rateToLogNorm(rateToNumber(current.rate));
  const step = coarse ? 0.1 : 0.03;
  const nextRate = logNormToRate(norm + (direction === 'up' ? step : -step));
  const moved = moveCurveControlPoint(points, index, current.sourceFrame, nextRate);
  if (!moved.ok) return moved;
  return {
    ok: true,
    changed: !curvePointsEqual(points, moved.points),
    points: moved.points,
    selectedIndex: moved.selectedIndex,
  };
}

/** Nudges a curve control point's source frame by one keyboard step. Reports
 * `changed: false` when fixed (endpoint) or already clamped against a neighbor. */
export function nudgeCurveControlPointFrame(
  points: readonly TimeMapCurvePoint[],
  index: number,
  direction: 'left' | 'right',
  coarse = false,
): {readonly ok: true; readonly changed: boolean; readonly points: readonly TimeMapCurvePoint[]; readonly selectedIndex: number}
 | {readonly ok: false; readonly error: CurveEditError} {
  if (index < 0 || index >= points.length) return {ok: false, error: 'POINT_ORDER'};
  if (index === 0 || index === points.length - 1) {
    return {ok: true, changed: false, points, selectedIndex: index};
  }
  const current = points[index]!;
  const span = Math.max(1, points[points.length - 1]!.sourceFrame - points[0]!.sourceFrame);
  const step = Math.max(1, Math.round(span * (coarse ? 0.08 : 0.02)));
  const moved = moveCurveControlPoint(
    points,
    index,
    current.sourceFrame + (direction === 'right' ? step : -step),
    rateToNumber(current.rate),
  );
  if (!moved.ok) return moved;
  return {
    ok: true,
    changed: !curvePointsEqual(points, moved.points),
    points: moved.points,
    selectedIndex: moved.selectedIndex,
  };
}

// ---------------------------------------------------------------------------
// Error & processing reason message key mapping.
// ---------------------------------------------------------------------------

export function speedPreviewErrorKey(code: string | undefined): string {
  switch (code) {
    case 'SPEED_SOURCE_NOT_READY': return 'speed.error.SPEED_SOURCE_NOT_READY';
    case 'SPEED_NOT_SUPPORTED': return 'speed.error.SPEED_NOT_SUPPORTED';
    case 'INVALID_RATE': return 'speed.error.INVALID_RATE';
    case 'POINT_LIMIT': return 'speed.error.POINT_LIMIT';
    case 'OUTPUT_FRAME_LIMIT': return 'speed.error.OUTPUT_FRAME_LIMIT';
    case 'SOURCE_FRAME_LIMIT': return 'speed.error.SOURCE_FRAME_LIMIT';
    case 'INVALID_CURVE_POINTS': return 'speed.error.INVALID_CURVE_POINTS';
    case 'FREEZE_PLAYHEAD_OUTSIDE': return 'speed.error.FREEZE_PLAYHEAD_OUTSIDE';
    default: return format5PanelErrorKey(code);
  }
}

export function speedProcessingReasonKey(reason: SpeedProcessingReason | undefined): string {
  switch (reason) {
    case 'SOURCE_UNAVAILABLE': return 'speed.processing.reason.SOURCE_UNAVAILABLE';
    case 'DISK_FULL': return 'speed.processing.reason.DISK_FULL';
    case 'CACHE_LIMIT': return 'speed.processing.reason.CACHE_LIMIT';
    case 'UNSUPPORTED_FORMAT': return 'speed.processing.reason.UNSUPPORTED_FORMAT';
    case 'INTERPOLATION_UNAVAILABLE': return 'speed.processing.reason.INTERPOLATION_UNAVAILABLE';
    case 'PROCESSING_FAILED':
    default: return 'speed.processing.reason.PROCESSING_FAILED';
  }
}

/** `INTERPOLATION_UNAVAILABLE` is a deterministic compile-time bound failure and offers no Retry. */
export function speedProcessingCanRetry(item: SpeedProcessingItem): boolean {
  return item.status === 'failed' && item.reason !== 'INTERPOLATION_UNAVAILABLE';
}

/** Picks the highest-priority processing item for a clip: running > queued > failed > ready. */
export function selectClipProcessingItem(
  items: readonly SpeedProcessingItem[],
  clipId: string,
): SpeedProcessingItem | null {
  const matching = items.filter(item => item.clipId === clipId);
  if (!matching.length) return null;
  const rank = (status: SpeedProcessingItem['status']): number =>
    status === 'running' ? 0 : status === 'queued' ? 1 : status === 'failed' ? 2 : 3;
  return [...matching].sort((a, b) => rank(a.status) - rank(b.status))[0] ?? null;
}

export function processingItemActive(item: SpeedProcessingItem): boolean {
  return item.status === 'queued' || item.status === 'running';
}
