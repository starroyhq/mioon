/** The ruler edits integer-frame position, independently of source playback. */
export function rulerFrameForKey(key, frame, maxFrame = 18000) {
  const current = Number.isFinite(Number(frame)) ? Math.round(Number(frame)) : 0;
  const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 30, PageDown: -30 };
  const next = key === 'Home' ? 0 : key === 'End' ? maxFrame : Object.hasOwn(steps, key) ? current + steps[key] : null;
  return next === null ? null : Math.max(0, Math.min(maxFrame, next));
}
