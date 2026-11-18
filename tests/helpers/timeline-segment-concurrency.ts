import { availableParallelism } from 'node:os';

/** Default segment concurrency of one timeline render, mirroring the formula in
 * `packages/business/src/timeline-media.ts`. Tests that observe individual
 * encoder children derive their expected launch wave from this value instead of
 * assuming a single-core runner where only one segment can be in flight. */
export function defaultTimelineSegmentConcurrency(parallelism: number = availableParallelism()): number {
  return Math.min(4, Math.max(1, Math.floor((parallelism - 2) / 2)));
}
