import type { Box } from './canvas-fit.ts';

export interface MioFollowPoint { x: number; y: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function createMioCursorMotion() {
  let key: string | undefined;
  let point: MioFollowPoint | undefined;
  let from: MioFollowPoint | undefined;
  let since = 0;
  let duration = 0;

  return (nextKey: string, anchor: MioFollowPoint, area: Box, now: number, drift: number, reduced: boolean): MioFollowPoint => {
    if (key !== nextKey || reduced) {
      key = nextKey;
      from = point;
      since = now;
      duration = from && !reduced ? Math.min(650, 360 + 0.16 * Math.hypot(anchor.x - from.x, anchor.y - from.y)) : 0;
    }
    const age = Math.max(0, now - since);
    const eased = duration > 0 ? 1 - Math.pow(1 - Math.min(1, age / duration), 2) : 1;
    const offset = reduced ? 0 : drift;
    // Different periods keep the pointer from tracing the same circle.
    const x = anchor.x + (offset ? offset * (18 * Math.sin(age / 630) + 4 * Math.sin(age / 1070)) : 0);
    const y = anchor.y + (offset ? offset * (12 * Math.sin(age / 850) + 4 * Math.sin(age / 440)) : 0);
    point = {
      x: clamp(from ? from.x + (x - from.x) * eased : x, area.left, area.right),
      y: clamp(from ? from.y + (y - from.y) * eased : y, area.top, area.bottom),
    };
    return point;
  };
}
