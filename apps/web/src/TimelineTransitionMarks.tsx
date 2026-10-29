import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { CLIP_TRANSITION_LIMITS, type ClipTransition, type TransitionClip } from '@mioon/contracts';
import Icon from './icons.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import { defaultTransition } from './clip-transition-state.ts';
import { selectedTransitionCuts, timelineTransitionMarks, timelineTransitionSources } from './timeline-transition-marks.ts';
import './timeline-transition.css';

/** One video track's transition marks and, at the selected clip's cuts, the
 * buttons that add the default transition as one saved edit. A mark selects
 * the incoming clip, whose inspector edits the transition. */
export default function TimelineTransitionMarks({ clips, trackId, assets, selectedClipId, pixelsPerFrame, disabled, disabledReason, onSelect, onAdd }: {
  clips: readonly TransitionClip[]; trackId: string; assets: readonly { readonly id: string; readonly mimeType: string; readonly duration?: unknown }[];
  selectedClipId: string | null; pixelsPerFrame: number; disabled: boolean; disabledReason?: string | null;
  onSelect: (clipId: string) => unknown; onAdd?: ((clipId: string, transition: ClipTransition) => unknown) | undefined;
}) {
  const { t } = useI18n();
  const marks = timelineTransitionMarks(clips, trackId);
  const cuts = onAdd ? selectedTransitionCuts(clips, selectedClipId, trackId, timelineTransitionSources(assets)) : [];
  return <>
    {marks.map(mark => {
      const label = t('timeline.transition.mark', { kind: t(`clip.transition.kind.${mark.kind}`), frames: mark.durationFrames });
      // A short transition keeps a visible bar, centred on the span it covers.
      const span = (mark.endFrame - mark.startFrame) * pixelsPerFrame, width = Math.max(6, span);
      return <Button key={mark.incomingId} type="button" variant="ghost" className="timeline-transition-mark" data-testid={`timeline-transition-${mark.incomingId}`} data-kind={mark.kind}
        style={{ left: mark.startFrame * pixelsPerFrame - (width - span) / 2, width }} aria-label={label} title={label}
        onClick={event => { event.stopPropagation(); onSelect(mark.incomingId); }}><Icon name="transition" size={10} /></Button>;
    })}
    {cuts.map(cut => {
      const transition = defaultTransition(cut.maxFrames), reason = disabledReason || (cut.maxFrames < CLIP_TRANSITION_LIMITS.minFrames ? t('clip.transition.noRoom') : null);
      const label = t('timeline.transition.add', { frames: transition.durationFrames });
      // Focusable when disabled, so hovering or focusing it still tells why.
      return <Button key={`add:${cut.incomingId}`} type="button" variant="ghost" className="timeline-transition-add" data-testid={`timeline-transition-add-${cut.incomingId}`}
        style={{ left: cut.cutFrame * pixelsPerFrame }} aria-label={label} aria-description={reason ?? undefined} title={reason ?? label} disabled={disabled || Boolean(reason)} focusableWhenDisabled
        onClick={event => { event.stopPropagation(); if (!disabled && !reason) void onAdd?.(cut.incomingId, transition); }}><Icon name="plus" size={12} /></Button>;
    })}
  </>;
}
