import type { MediaStatusReason, MediaStatusView } from '../../../../packages/contracts/src/media-reference.ts';
export type { MediaStatusReason, MediaStatusView } from '../../../../packages/contracts/src/media-reference.ts';
export const MEDIA_MISSING_REASONS = Object.freeze(['not-found', 'no-access', 'not-downloaded', 'other-platform', 'not-a-file'] as const);
export type MediaMissingReason = typeof MEDIA_MISSING_REASONS[number];
export type MediaStatusDisplay =
  | { readonly kind: 'online' }
  | { readonly kind: 'missing'; readonly reason: MediaMissingReason }
  | { readonly kind: 'changed' }
  /** Outside the project, not confirmed yet, size and modification time unchanged. */
  | { readonly kind: 'unconfirmed-found' }
  /** Not confirmed yet and only the modification time differs, so it could not be read to compare. */
  | { readonly kind: 'unconfirmed-maybe-changed' };
/** What the badges show; adds the two states of the check itself. */
export type MediaStatusUi = MediaStatusDisplay | { readonly kind: 'checking' } | { readonly kind: 'check-failed' };

const isMissingReason = (reason: MediaStatusReason): reason is MediaMissingReason => (MEDIA_MISSING_REASONS as readonly string[]).includes(reason);
/** L1's status as the screens show it. A file outside the project that the
 * user has not confirmed yet is neither "online" nor "changed" (decided 11-01):
 * unchanged size and time (`same-stats`) read "found, usable once confirmed";
 * a changed time (`unverified`) reads "may have changed, checked once
 * confirmed". L1 gives an unreadable outside file no other `online` reason;
 * should one appear, it is still not shown as usable. */
export function mediaStatusDisplay(view: MediaStatusView): MediaStatusDisplay {
  if (view.status === 'online') return view.outside && !view.readable ? { kind: 'unconfirmed-found' } : { kind: 'online' };
  if (view.status === 'changed') return view.reason === 'unverified' ? { kind: 'unconfirmed-maybe-changed' } : { kind: 'changed' };
  return { kind: 'missing', reason: isMissingReason(view.reason) ? view.reason : 'not-found' };
}
