import type { ProjectEntryAvailability } from '../../../../packages/contracts/src/project-entry.ts';

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

/** Controlled views and the host use the same strict directory contract. */
export type ProjectAvailabilityView = ProjectEntryAvailability;
