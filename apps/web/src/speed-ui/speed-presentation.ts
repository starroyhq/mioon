/** Presentation view builders for timeline clips, task popover, and task center.
 *
 * Returns null / empty lists whenever `capabilities.speed !== true`, keeping
 * format 3/4/5 rendering 100% untouched.
 */
import type {SpeedProcessingItem} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {MessageArguments, MessageKey} from '../../../../packages/i18n/src/index.ts';
import type {TaskOverviewItem} from '../TaskPopover.tsx';
import {
  clipTimingOf,
  formatSpeedRateLabel,
  processingItemActive,
  selectClipProcessingItem,
  speedProcessingCanRetry,
  speedProcessingReasonKey,
  timelineSpeedEnabled,
} from './speed-model.ts';
import type {SpeedClipLike, SpeedTimelineLike} from './speed-model.ts';
import type {SpeedProcessingPollState} from './use-speed-processing.ts';

type Translator = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;

export interface TimelineClipSpeedView {
  readonly isFreeze: boolean;
  readonly freezeTitle: string;
  /** Formatted suffix rendered after the clip name, e.g. ` · 2.0×`, ` · 0.5× · 倒放`, ` · 曲线 · 光流`. */
  readonly badgeText: string;
  readonly reversed: boolean;
  readonly processingActive: boolean;
  readonly processingPercent: number | null;
  readonly processingLabel: string;
  readonly processingFailed: boolean;
  readonly processingUnknown?: boolean;
}

/** Builds per-clip display views for `Timeline.tsx`. Returns `null` when
 * `timeline.capabilities.speed !== true` so existing timelines render identically. */
export function buildTimelineClipSpeedViews(
  timeline: (SpeedTimelineLike & {readonly clips?: readonly SpeedClipLike[]}) | null | undefined,
  processingItems: readonly SpeedProcessingItem[],
  t: Translator,
  pollState?: SpeedProcessingPollState,
): ReadonlyMap<string, TimelineClipSpeedView> | null {
  if (!timelineSpeedEnabled(timeline)) return null;
  const map = new Map<string, TimelineClipSpeedView>();
  for (const clip of timeline?.clips ?? []) {
    const timing = clipTimingOf(clip);
    const processing = selectClipProcessingItem(processingItems, clip.id);
    const active = Boolean(processing && processingItemActive(processing));
    const failed = processing?.status === 'failed';
    if (!timing && !active && !failed) continue;

    if (timing?.profile === 'timeline-freeze-v1') {
      map.set(clip.id, {
        isFreeze: true,
        freezeTitle: t('speed.freeze.clipName'),
        badgeText: '',
        reversed: false,
        processingActive: false,
        processingPercent: null,
        processingLabel: '',
        processingFailed: false,
      });
      continue;
    }

    const parts: string[] = [];
    let reversed = false;
    if (timing?.profile === 'timeline-speed-v1') {
      if (timing.basis.speed.kind === 'curve') {
        parts.push(t('speed.badge.curve'));
      } else {
        const {numerator, denominator} = timing.basis.speed.rate;
        if (numerator !== denominator) {
          parts.push(formatSpeedRateLabel(timing.basis.speed.rate));
        }
      }
      if (timing.view.direction === 'reverse') {
        reversed = true;
        parts.push(t('speed.badge.reverse'));
      }
      if (timing.interpolation === 'optical') {
        parts.push(t('speed.badge.optical'));
      }
    }

    const percent = processing?.status === 'running' && typeof processing.progress === 'number'
      ? Math.max(0, Math.min(100, Math.round(processing.progress)))
      : null;
    const statusUnknown = active && pollState === 'unknown';
    const processingLabel = !active ? ''
      : statusUnknown
        ? t('speed.processing.statusUnknown')
      : percent !== null
        ? t('speed.processing.clipProgress', {percent})
        : t('speed.processing.clipQueued');

    if (!parts.length && !active && !failed) continue;
    map.set(clip.id, {
      isFreeze: false,
      freezeTitle: '',
      badgeText: parts.length ? ` · ${parts.join(' · ')}` : '',
      reversed,
      processingActive: active,
      processingPercent: active && !statusUnknown ? (percent ?? 0) : null,
      processingLabel,
      processingFailed: failed,
      ...(statusUnknown ? {processingUnknown: true} : {}),
    });
  }
  return map;
}

export function speedProcessingActiveLabel(
  item: SpeedProcessingItem,
  t: Translator,
): string {
  if (item.kind === 'reverse') return t('speed.processing.reverseActive');
  if (item.kind === 'preview') return t('speed.processing.previewActive');
  return t('speed.processing.opticalActive');
}

export function speedProcessingItemTitle(
  item: SpeedProcessingItem,
  clipName: string,
  t: Translator,
): string {
  const key = item.kind === 'reverse'
    ? 'speed.processing.reverseTitle'
    : item.kind === 'preview'
      ? 'speed.processing.previewTitle'
      : 'speed.processing.opticalTitle';
  return t(key, {name: clipName});
}

export function speedProcessingItemStatusText(item: SpeedProcessingItem, t: Translator): string {
  if (item.status === 'queued') return t('speed.processing.statusQueued');
  if (item.status === 'running') {
    const percent = typeof item.progress === 'number' ? Math.max(0, Math.min(100, Math.round(item.progress))) : 0;
    return t('speed.processing.statusRunning', {percent});
  }
  if (item.status === 'failed') return t('speed.processing.statusFailed');
  return t('speed.processing.statusReady');
}

export function speedProcessingFailureSentence(item: SpeedProcessingItem, t: Translator): string {
  const reasonText = t(speedProcessingReasonKey(item.reason) as never);
  if (item.reason === 'INTERPOLATION_UNAVAILABLE' || item.reason === 'UNSUPPORTED_FORMAT') {
    return reasonText;
  }
  const key = item.kind === 'reverse'
    ? 'speed.processing.reverseFailed'
    : item.kind === 'preview'
      ? 'speed.processing.previewFailed'
      : 'speed.processing.opticalFailed';
  return t(key, {reason: reasonText});
}

/** Builds overview items for `TaskPopover` (active and failed items only). */
export function buildSpeedProcessingOverviewItems(options: {
  readonly enabled: boolean;
  readonly items: readonly SpeedProcessingItem[];
  readonly clipNameFor: (clipId: string) => string;
  readonly t: Translator;
  readonly onCancel: (taskId: string) => void;
  readonly onRetry: (taskId: string) => void;
}): TaskOverviewItem[] {
  if (!options.enabled || !options.items.length) return [];
  const out: TaskOverviewItem[] = [];
  for (const item of options.items) {
    if (item.status === 'ready') continue;
    const label = speedProcessingItemTitle(item, options.clipNameFor(item.clipId), options.t);
    const active = processingItemActive(item);
    const failed = item.status === 'failed';
    const canRetry = speedProcessingCanRetry(item);
    const percent = item.status === 'running' && typeof item.progress === 'number'
      ? Math.max(0, Math.min(100, Math.round(item.progress)))
      : item.status === 'queued' ? 0 : undefined;
    out.push({
      id: `speed:${item.taskId}`,
      label,
      status: speedProcessingItemStatusText(item, options.t),
      phase: failed ? 'attention' : 'active',
      tone: failed ? 'danger' : 'neutral',
      ...(percent !== undefined ? {progress: percent} : {}),
      ...(failed ? {detail: options.t(speedProcessingReasonKey(item.reason) as never)} : {}),
      ...(active ? {
        onCancel: () => options.onCancel(item.taskId),
        cancelLabel: options.t('speed.processing.cancel'),
      } : {}),
      ...(canRetry ? {
        onRetry: () => options.onRetry(item.taskId),
        retryLabel: options.t('speed.processing.retry'),
      } : {}),
    });
  }
  return out;
}
