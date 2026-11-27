/** XMEML represents NTSC rates as an integer timebase times 1000/1001. */
export function premiereNativeTimebase(clock: {readonly fps: number; readonly fpsDenominator?: number}): {
  readonly timebase: number;
  readonly ntsc: boolean;
} | null {
  const denominator = clock.fpsDenominator ?? 1;
  if (denominator === 1 && [24, 25, 30, 50, 60].includes(clock.fps)) return {timebase: clock.fps, ntsc: false};
  // Probe fractions are reduced, including 24000/1001, 30000/1001 and 60000/1001.
  if (denominator === 1001 && [24000, 30000, 60000].includes(clock.fps)) {
    return {timebase: clock.fps / 1000, ntsc: true};
  }
  return null;
}
