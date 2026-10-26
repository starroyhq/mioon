import {fixture as originalFixture} from './timeline-mix-loudness-ui-fixture.ts';
import type {TimelineMixLoudnessControllerOptions, TimelineMixLoudnessReadOptions} from '../../apps/web/src/timeline-mix-loudness-state.ts';
import type {TimelineMixLoudnessInput} from '../../packages/contracts/src/timeline-mix-loudness.ts';
type OriginalFixture = ReturnType<typeof originalFixture>;
export type StrictMixFixture = Omit<OriginalFixture,'calls'|'ready'> & {
  calls: {input: TimelineMixLoudnessInput; options: TimelineMixLoudnessReadOptions; context: ReturnType<OriginalFixture['live']>}[];
  ready(value?: unknown): ReturnType<OriginalFixture['ready']>;
};
// Keep the original fixture function and its complete controller behavior.
export const fixture = originalFixture as unknown as (patch?: Record<string, unknown>, overrides?: Partial<TimelineMixLoudnessControllerOptions>)=>StrictMixFixture;
