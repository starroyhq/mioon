import React from 'react';
import TimelineLoudnessApply from '../../apps/web/src/TimelineLoudnessApply.tsx';
import TimelineExportProfile from '../../apps/web/src/TimelineExportProfile.tsx';
import type { TimelineExportProfileProps } from '../../apps/web/src/TimelineExportProfile.tsx';
import { createTimelineLoudnessApplyController } from '../../apps/web/src/timeline-loudness-apply-state.ts';
import type { TimelineLoudnessApplyView, TimelineLoudnessApplyIntent } from '../../apps/web/src/timeline-loudness-apply-state.ts';
import type { TimelineMixLoudnessState } from '../../apps/web/src/timeline-mix-loudness-state.ts';
import { useTimelineLoudnessApply } from '../../apps/web/src/use-timeline-loudness-apply.ts';
import { submitTimelineLoudnessApply } from '../../apps/web/src/timeline-loudness-apply-submit.ts';
function consume(apply: TimelineLoudnessApplyView, observation: TimelineMixLoudnessState, intent: TimelineLoudnessApplyIntent, profile: TimelineExportProfileProps): void {
  const valid = <TimelineLoudnessApply apply={apply} observation={observation} onOpenTasks={() => undefined} />;
  const selector = <TimelineExportProfile {...profile} />;
  const closeBlocked: boolean = apply.controller.getCloseState().blocked;
  // @ts-expect-error Close status is immutable boolean metadata, not an unknown-risk permission.
  apply.controller.getCloseState().blocked = 'unknown';
  // @ts-expect-error Terminal recovery needs its independently captured workspace identity.
  apply.controller.recovered({ status: 'applied' });
  void closeBlocked;
  // @ts-expect-error A review must bind the full saved observation.
  apply.controller.review({ report: observation.report });
  // @ts-expect-error Client-specified clip gains cannot enter the request.
  intent.input.gains = [{ clipId: 'x', gain: 2 }];
  // @ts-expect-error Frozen intent is not editable by a late callback.
  intent.sourceIdentity = 'new-source';
  // @ts-expect-error No automatic/default target is accepted.
  intent.input.target = {};
  // @ts-expect-error Typed submit returns a durable outcome, not a truthy flag.
  createTimelineLoudnessApplyController({ getObservation: () => observation, confirm: async () => true, createRequestId: () => 'request-id', submit: async () => true });
  // @ts-expect-error Complete callback dependencies are required.
  submitTimelineLoudnessApply(intent, () => true, { mutate: async () => null });
  // @ts-expect-error No extra profile IDs or auto-select modes.
  const unknown = <TimelineExportProfile {...profile} value={{ ...profile.value, profileId: 'auto_loudness' }} />;
  void [valid, selector, unknown];
}
void consume;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Expect<T extends false> = T;
export type CheckedApply = Expect<IsAny<ReturnType<typeof useTimelineLoudnessApply>>>;
export type CheckedInput = Expect<IsAny<TimelineLoudnessApplyIntent['input']>>;

export type CheckedCloseState = Expect<IsAny<ReturnType<TimelineLoudnessApplyView['controller']['getCloseState']>>>;
