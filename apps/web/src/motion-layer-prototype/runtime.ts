export interface MotionFrameProps<Params> {
  readonly frame: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly params: Params;
}

export function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/** Normalize the sampled frames of a transition to include both endpoints. */
export function frameProgress(frame: number, durationFrames: number): number {
  if (frame < 0) return 0;
  if (durationFrames <= 1 || frame >= durationFrames - 1) return 1;
  return frame / (durationFrames - 1);
}

/** Solve x(t) for the CSS cubic Bézier, then evaluate y(t) for the same t. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new RangeError('Invalid motion easing control points');
  }
  const coordinate = (t: number, first: number, second: number) => {
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
  };
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let low = 0;
    let high = 1;
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (coordinate(mid, x1, x2) < progress) low = mid;
      else high = mid;
    }
    return coordinate((low + high) / 2, y1, y2);
  };
}

/** The step response of an underdamped spring with normalized settling time. */
export function springProgress(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const damping = 7;
  const frequency = 12;
  const phase = frequency * progress;
  return 1 - Math.exp(-damping * progress) * (Math.cos(phase) + damping / frequency * Math.sin(phase));
}

export function sequenceFrame(frame: number, startFrame: number, durationFrames: number): number | undefined {
  const localFrame = frame - startFrame;
  return localFrame >= 0 && localFrame < durationFrames ? localFrame : undefined;
}

export function staggerFrame(frame: number, itemIndex: number, delayFramesPerItem: number): number {
  return frame - Math.round(itemIndex * delayFramesPerItem);
}

export function fadeOpacity(frame: number, durationFrames: number, enterFrames: number, exitFrames: number): number {
  if (sequenceFrame(frame, 0, durationFrames) === undefined) return 0;
  const entrance = frameProgress(frame, enterFrames);
  const exit = exitFrames === 0 ? 1 : 1 - frameProgress(frame - (durationFrames - exitFrames), exitFrames);
  return Math.min(entrance, exit);
}

/** Random access to a reproducible sample given a 32-bit seed and an index. */
export function seededRandom(seed: number, sampleIndex: number): number {
  // Use a Weyl increment and the MurmurHash3 32-bit finalizer to mix nearby indices.
  let sample = (seed + Math.imul(sampleIndex, 0x9e3779b9)) | 0;
  sample = Math.imul(sample ^ (sample >>> 16), 0x85ebca6b);
  sample = Math.imul(sample ^ (sample >>> 13), 0xc2b2ae35);
  return ((sample ^ (sample >>> 16)) >>> 0) / 0x100000000;
}
