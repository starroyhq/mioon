import {FRAME_LIMITS, SOURCE_RANGE_FPS, SCENE_DETECTION_PROFILE_ID, SCENE_DETECTION_MODES, SCENE_DETECTION_DEFAULTS as DEFAULTS, SCENE_MIN_SHOT_SECONDS} from '@mioon/contracts';

// The profile ID names the scoring and selection rules below; change it in the
// contracts whenever they change, so stored results can be told apart. The
// modes, defaults and shot bounds are the stored task's option contract.
export {SCENE_DETECTION_PROFILE_ID, SCENE_DETECTION_MODES};
export type SceneDetectionMode = typeof SCENE_DETECTION_MODES[number];
export interface SceneDetectionOptions {
  readonly mode: SceneDetectionMode;
  /** 0-100. Higher values lower the threshold and find more cuts. */
  readonly sensitivity: number;
  readonly minShotSeconds: number;
}
export const SCENE_DETECTION_DEFAULTS: SceneDetectionOptions = DEFAULTS;
export const SCENE_DETECTION_LIMITS = Object.freeze({
  // Frames are analysed on the editing grid, so a cut frame is directly a
  // source-range frame: the first frame at or after N/30 starts the new shot.
  fps: SOURCE_RANGE_FPS,
  maxEdge: 256,
  // Frame capture's limit, so every segment's keyframe can be captured.
  maxDurationSeconds: FRAME_LIMITS.sourceDuration,
  minShotSeconds: SCENE_MIN_SHOT_SECONDS,
  adaptiveWindowFrames: Math.round(1.2 * SOURCE_RANGE_FPS),
  flashFrames: Math.round(0.2 * SOURCE_RANGE_FPS),
});

export interface SceneCut {
  /** First frame of the new shot on the 30 fps grid. */
  readonly frame: number;
  /** Combined difference at the cut, 0-1. */
  readonly score: number;
}
export interface SceneSegment {
  readonly startFrame: number;
  readonly endFrame: number;
}
export interface SceneDetectionResult {
  readonly profileId: typeof SCENE_DETECTION_PROFILE_ID;
  readonly fps: typeof SOURCE_RANGE_FPS;
  readonly frameCount: number;
  readonly options: SceneDetectionOptions;
  readonly cuts: readonly SceneCut[];
  readonly segments: readonly SceneSegment[];
}
export interface SceneDetectionProgress {
  readonly frames: number;
  /** Provisional cut frames; a cut is reported once a minimum shot follows it. */
  readonly cuts: readonly number[];
}
export interface SceneDetector {
  readonly frameBytes: number;
  /** Complete frames received so far. */
  readonly frames: number;
  write(chunk: Uint8Array): void;
  progress(): SceneDetectionProgress;
  finish(frameCount?: number): SceneDetectionResult;
}

type SceneErrorCode = 'SCENE_DETECTION_INVALID' | 'SCENE_FRAMES_INVALID' | 'SCENE_FRAME_LIMIT';
export type SceneDetectionError = Error & {readonly code: SceneErrorCode};
const messages: Readonly<Record<SceneErrorCode, string>> = Object.freeze({
  SCENE_DETECTION_INVALID: 'Scene detection options are invalid.',
  SCENE_FRAMES_INVALID: 'Decoded frames are incomplete or invalid for scene detection.',
  SCENE_FRAME_LIMIT: 'Decoded frames exceed the scene detection limit.',
});
function failure(code: SceneErrorCode): SceneDetectionError {
  return Object.assign(new Error(messages[code]), {code});
}

const PIXEL_WEIGHT = 0.75, HISTOGRAM_WEIGHT = 0.25;
// A change that reverts within the flash window to below this share of the
// cut's own difference is a flash, not a cut.
const FLASH_RATIO = 0.5;
// Thresholds at sensitivity 0; every 20 points halves them, so the default 60
// is 0.08 (adaptive) and 0.1 (fixed). Adaptive compares the excess over the
// recent median; fixed compares the combined difference itself. On the
// synthetic calibration set, true cuts exceed 0.096 and non-cuts stay at or
// below 0.074 (a flat colour brightening in compressed steps).
const THRESHOLDS: Readonly<Record<SceneDetectionMode, number>> = Object.freeze({adaptive: 0.64, fixed: 0.8});

// Per-channel 16-bin histograms with linear binning: bin centres sit at 8, 24,
// ..., 248 and each value splits a weight of 16 between its two nearest
// centres. A one-level brightness change therefore moves at most 1/16 of a
// pixel's weight, where hard bins would flip whole flat areas at a bin edge.
const BINS = 16, BIN_WEIGHT = 16;
const LOW_BIN = new Uint8Array(256), LOW_WEIGHT = new Uint8Array(256);
for (let value = 0; value < 256; value++) {
  const position = Math.min(Math.max(value - 8, 0), (BINS - 1) * BIN_WEIGHT);
  const bin = Math.min(position >> 4, BINS - 2);
  LOW_BIN[value] = bin; LOW_WEIGHT[value] = BIN_WEIGHT - (position - bin * BIN_WEIGHT);
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const rounded = (value: number): number => Math.round(value * 10000) / 10000;

/** Validates caller options and fills defaults. Unknown keys are rejected. */
export function sceneDetectionOptions(value: unknown = {}): SceneDetectionOptions {
  if (!object(value) || Object.keys(value).some(key => !['mode', 'sensitivity', 'minShotSeconds'].includes(key))) throw failure('SCENE_DETECTION_INVALID');
  const {mode = SCENE_DETECTION_DEFAULTS.mode, sensitivity = SCENE_DETECTION_DEFAULTS.sensitivity, minShotSeconds = SCENE_DETECTION_DEFAULTS.minShotSeconds} = value;
  const [shortest, longest] = SCENE_DETECTION_LIMITS.minShotSeconds;
  if (!SCENE_DETECTION_MODES.includes(mode as SceneDetectionMode) || !Number.isSafeInteger(sensitivity) ||
      (sensitivity as number) < 0 || (sensitivity as number) > 100 || typeof minShotSeconds !== 'number' ||
      !Number.isFinite(minShotSeconds) || minShotSeconds < shortest || minShotSeconds > longest) throw failure('SCENE_DETECTION_INVALID');
  return Object.freeze({mode: mode as SceneDetectionMode, sensitivity: sensitivity as number, minShotSeconds});
}

export const sceneThreshold = ({mode, sensitivity}: Pick<SceneDetectionOptions, 'mode' | 'sensitivity'>): number =>
  THRESHOLDS[mode] * 2 ** (-sensitivity / 20);

export const sceneMinShotFrames = (options: Pick<SceneDetectionOptions, 'minShotSeconds'>): number =>
  Math.max(1, Math.round(options.minShotSeconds * SCENE_DETECTION_LIMITS.fps));

export const sceneSegments = (cuts: readonly number[], frameCount: number): SceneSegment[] =>
  [0, ...cuts].map((startFrame, index) => Object.freeze({startFrame, endFrame: index < cuts.length ? cuts[index] : frameCount}));

interface Slot {readonly pixels: Uint8Array; readonly histogram: Int32Array}
interface Candidate {readonly frame: number; readonly score: number; readonly strength: number}

/** Streaming cut detector over decoded rgb24 frames on the 30 fps grid.
 *
 * Each frame pair is scored 0.75 x mean absolute pixel difference plus
 * 0.25 x mean per-channel histogram distance. A frame is a candidate when its
 * score is a local peak, clears the threshold (adaptive: over the median of
 * the previous 1.2 s of scores) and is not a flash, i.e. the picture does not
 * return to the pre-change content within 0.2 s. Candidates closer than the
 * minimum shot to the start, to the end or to a stronger accepted cut are
 * dropped, so a short tail merges into the previous segment.
 *
 * Retained storage is a ring of 2 x 6 + 2 frames, one score per frame and the
 * candidate list. A failed detector is terminal; finish is idempotent.
 */
export function createSceneDetector({width, height, options = SCENE_DETECTION_DEFAULTS, maxFrames}:
  {width: number; height: number; options?: SceneDetectionOptions; maxFrames?: number}): SceneDetector {
  const {maxEdge, maxDurationSeconds, fps, adaptiveWindowFrames, flashFrames} = SCENE_DETECTION_LIMITS;
  // One second of slack lets a decoder accept container rounding at the limit.
  const frameLimit = maxFrames ?? (maxDurationSeconds + 1) * fps;
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= maxEdge) ||
      !Number.isSafeInteger(frameLimit) || frameLimit < 1 || frameLimit > (maxDurationSeconds + 1) * fps) throw failure('SCENE_DETECTION_INVALID');
  const settings = sceneDetectionOptions(options);
  const threshold = sceneThreshold(settings), minShot = sceneMinShotFrames(settings), adaptive = settings.mode === 'adaptive';
  const pixelCount = width * height, frameBytes = pixelCount * 3;
  const ring: Slot[] = Array.from({length: 2 * flashFrames + 2}, () => ({pixels: new Uint8Array(frameBytes), histogram: new Int32Array(3 * BINS)}));
  const slot = (frame: number): Slot => ring[frame % ring.length];
  const scores = new Float64Array(frameLimit), window = new Float64Array(adaptiveWindowFrames);
  const candidates: Candidate[] = [];
  let frames = 0, filled = 0, failed: unknown, result: SceneDetectionResult | undefined;

  const histogram = ({pixels, histogram: bins}: Slot): void => {
    bins.fill(0);
    for (let offset = 0; offset < frameBytes; offset += 3) {
      for (let channel = 0; channel < 3; channel++) {
        const value = pixels[offset + channel], bin = channel * BINS + LOW_BIN[value], weight = LOW_WEIGHT[value];
        bins[bin] += weight; bins[bin + 1] += BIN_WEIGHT - weight;
      }
    }
  };
  // The histogram term alone is a lower bound, so a pair already at or above
  // the limit skips the pixel pass.
  const difference = (a: Slot, b: Slot, limit = Infinity): number => {
    let pixels = 0, bins = 0;
    for (let index = 0; index < 3 * BINS; index++) bins += Math.abs(a.histogram[index] - b.histogram[index]);
    const histogramPart = HISTOGRAM_WEIGHT * bins / (2 * BIN_WEIGHT * pixelCount * 3);
    if (histogramPart >= limit) return histogramPart;
    for (let index = 0; index < frameBytes; index++) pixels += Math.abs(a.pixels[index] - b.pixels[index]);
    return PIXEL_WEIGHT * pixels / (255 * frameBytes) + histogramPart;
  };
  const background = (frame: number): number => {
    const from = Math.max(1, frame - adaptiveWindowFrames), count = frame - from;
    if (count <= 0) return 0;
    for (let index = 0; index < count; index++) window[index] = scores[from + index];
    const sorted = window.subarray(0, count).sort();
    return count % 2 ? sorted[count >> 1] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
  };
  // Any frame before the change matching any frame at or after it, at most a
  // flash window apart, means the picture reverted: entry, decay and exit of
  // a multi-step flash are all covered, nearest pairs first. Matching means
  // under half the change and under what a cut across that span would need,
  // so a large flash cannot hide a real cut between two different shots.
  const flash = (frame: number, motion: number): boolean => {
    const half = scores[frame] * FLASH_RATIO, last = Math.min(frame + flashFrames, frames - 1);
    for (let span = 2; span <= flashFrames + 1; span++) {
      const limit = Math.min(half, motion * span + threshold);
      for (let before = Math.max(0, frame - span); before < frame && before + span <= last; before++) {
        if (difference(slot(before), slot(before + span), limit) < limit) return true;
      }
    }
    return false;
  };
  const evaluate = (frame: number): void => {
    const score = scores[frame];
    // Local peak: strictly above the previous score; a tie with the next keeps the first.
    if (!(score > scores[frame - 1]) || frame + 1 < frames && score < scores[frame + 1] || score < threshold) return;
    const motion = adaptive ? background(frame) : 0, strength = score - motion;
    if (strength < threshold || flash(frame, motion)) return;
    candidates.push({frame, score, strength});
  };
  const consume = (): void => {
    const current = frames++;
    histogram(slot(current));
    if (current) scores[current] = difference(slot(current - 1), slot(current));
    // A candidate needs one following score and the whole flash window.
    if (current - flashFrames >= 1) evaluate(current - flashFrames);
  };
  const select = (frameCount: number): Candidate[] => {
    const eligible = candidates.filter(({frame}) => frame >= minShot && frame <= frameCount - minShot)
      .sort((a, b) => b.strength - a.strength || a.frame - b.frame);
    const accepted: Candidate[] = [];
    for (const candidate of eligible) {
      let low = 0, high = accepted.length;
      while (low < high) {const middle = (low + high) >> 1; if (accepted[middle].frame < candidate.frame) low = middle + 1; else high = middle;}
      if (low > 0 && candidate.frame - accepted[low - 1].frame < minShot || low < accepted.length && accepted[low].frame - candidate.frame < minShot) continue;
      accepted.splice(low, 0, candidate);
    }
    return accepted;
  };

  return Object.freeze({
    frameBytes,
    get frames(): number {return frames;},
    write(chunk: Uint8Array): void {
      if (failed) throw failed;
      if (result) throw failure('SCENE_FRAMES_INVALID');
      try {
        if (!(chunk instanceof Uint8Array)) throw failure('SCENE_FRAMES_INVALID');
        let offset = 0;
        while (offset < chunk.length) {
          if (!filled && frames >= frameLimit) throw failure('SCENE_FRAME_LIMIT');
          const count = Math.min(frameBytes - filled, chunk.length - offset);
          slot(frames).pixels.set(chunk.subarray(offset, offset + count), filled);
          filled += count; offset += count;
          if (filled === frameBytes) {filled = 0; consume();}
        }
      } catch (error) {failed = error; throw error;}
    },
    progress(): SceneDetectionProgress {
      if (failed) throw failed;
      return Object.freeze({frames, cuts: Object.freeze(select(frames).map(({frame}) => frame))});
    },
    finish(frameCount: number = frames): SceneDetectionResult {
      if (failed) throw failed;
      if (result) return result;
      try {
        if (filled || !frames || !Number.isSafeInteger(frameCount) || frameCount < 1) throw failure('SCENE_FRAMES_INVALID');
        for (let frame = Math.max(1, frames - flashFrames); frame < frames; frame++) evaluate(frame);
        const cuts = select(frameCount).map(({frame, score}) => Object.freeze({frame, score: rounded(score)}));
        result = Object.freeze({profileId: SCENE_DETECTION_PROFILE_ID, fps, frameCount, options: settings, cuts: Object.freeze(cuts),
          segments: Object.freeze(sceneSegments(cuts.map(({frame}) => frame), frameCount))});
        return result;
      } catch (error) {failed = error; throw error;}
    },
  });
}
