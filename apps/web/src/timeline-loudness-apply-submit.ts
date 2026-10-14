import type { TimelineLoudnessApplyInput } from '@mioon/contracts/timeline-loudness-apply';
import type { TimelineLoudnessApplyIntent, TimelineLoudnessApplyOutcome } from './timeline-loudness-apply-state.ts';
interface Failure { readonly error: unknown; readonly dispatched: boolean; readonly rejected: boolean }
export interface TimelineLoudnessDurableOptions {
  readonly returnAfterNavigation: true;
  readonly canExecute: (preparedTask?: unknown) => boolean;
  readonly validateResponse: (response: unknown) => void;
  readonly onFailure: (error: unknown, details: Readonly<{ dispatched: boolean; rejected: boolean }>) => void;
}
export interface TimelineLoudnessSubmissionDependencies {
  readonly mutate: (operation: string, input: TimelineLoudnessApplyInput, revision: number, options: TimelineLoudnessDurableOptions) => Promise<unknown>;
  readonly isDurable: (operation: string) => boolean;
  readonly isPending: (projectId: string) => boolean;
  readonly acknowledged: (operation: string, input: TimelineLoudnessApplyInput, value: unknown) => boolean;
}
/** Only adapts the established mutateTimeline→runDurable→edit-task flow.
 * Never invokes RPC or mints a replacement key, including after an unknown. */
export async function submitTimelineLoudnessApply(intent: TimelineLoudnessApplyIntent, canExecute: (preparedTask?: unknown) => boolean,
  dependencies: TimelineLoudnessSubmissionDependencies): Promise<TimelineLoudnessApplyOutcome> {
  if (!dependencies.isDurable(intent.operation) || !canExecute()) return { status: 'rejected' };
  let failure: Failure | undefined;
  try {
    const result = await dependencies.mutate(intent.operation, intent.input, intent.input.expectedRevision, {
      returnAfterNavigation: true, canExecute,
      validateResponse: value => { if (!dependencies.acknowledged(intent.operation, intent.input, value)) throw Object.assign(new Error('响度应用确认与原请求不一致。'), { code: 'BACKEND_PROTOCOL_ERROR' }); },
      onFailure: (error, details) => { failure = { error, ...details }; },
    });
    if (result && dependencies.acknowledged(intent.operation, intent.input, result)) return { status: 'applied' };
    // A failed prepare can still have persisted the original task. An unavailable
    // task list also remains fenced until an explicit lookup establishes outcome.
    return { status: dependencies.isPending(intent.input.projectId) || failure?.dispatched && !failure.rejected ? 'unknown' : 'rejected', error: failure?.error };
  } catch (error) { return { status: 'unknown', error }; }
}
