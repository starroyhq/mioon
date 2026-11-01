import type { ProjectInvalidReason } from '../../../../packages/contracts/src/project-file.ts';

/** Project file screens (U1) are controlled views: data and state arrive as
 * props and every action is a callback. Requests, storage and timers stay with
 * the callers (S6, U2). "Empty" is `ready` with an empty value. */
export type ViewState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly retryable: boolean }
  | { readonly kind: 'ready'; readonly value: T };

/** A user action in flight or failed. `action` names the button it came from. */
export type ActionState<A extends string> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly action: A }
  | { readonly kind: 'error'; readonly action: A };

/** Picks platform wording such as "Show in Finder" and shortcut symbols. */
export type HostPlatform = 'mac' | 'windows' | 'linux' | 'web';

/** Whether a recent project can be opened now. Follows `ProjectAvailability`
 * of the host's `list()` in the project host draft (#107). The host reports the
 * invalid reason as a string; S6 maps it onto `ProjectInvalidReason`. */
export type ProjectAvailabilityView =
  | { readonly state: 'open' | 'busy' | 'available' | 'locked' | 'missing' }
  | { readonly state: 'invalid'; readonly reason: ProjectInvalidReason };
