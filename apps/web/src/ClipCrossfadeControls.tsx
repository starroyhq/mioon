import React, { useId } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { CrossfadeBlock, CrossfadeCandidate } from './timeline-crossfade-state.ts';

const blockedMessage = { envelope: 'crossfade.blocked.envelope', locked: 'crossfade.blocked.locked' } as const satisfies Record<CrossfadeBlock, string>;

/** Lists the selected clip's crossfade pairs. Applying is one saved timeline
 * edit for both clips, not a draft change, so it waits for a clean draft. */
export default function ClipCrossfadeControls({ candidates, disabled, disabledReason, onCrossfade }: {
  candidates: readonly CrossfadeCandidate[]; disabled: boolean; disabledReason?: string; onCrossfade?: (outgoingClipId: string, incomingClipId: string) => unknown;
}) {
  const { t } = useI18n();
  const id = useId();
  return <fieldset className="clip-crossfade" data-testid="clip-crossfade" aria-describedby={`${id}-hint`}>
    <legend>{t('crossfade.title')}</legend>
    {candidates.length === 0 ? <p className="input-hint" data-testid="crossfade-empty">{t('crossfade.empty')}</p> : candidates.map(candidate => {
      const blocked = candidate.blocked ? t(blockedMessage[candidate.blocked]) : '';
      return <div className="field-row clip-crossfade-row" key={`${candidate.outgoingClipId}:${candidate.incomingClipId}`} data-testid="crossfade-candidate">
        <span className="clip-crossfade-pair">
          <span>{t(candidate.role === 'outgoing' ? 'crossfade.toNext' : 'crossfade.fromPrevious', { name: candidate.partnerName })}</span>
          <span className="input-hint">{t('crossfade.range', { start: candidate.startFrame, frames: candidate.durationFrames })}</span>
          {blocked && <span className="input-hint" role="status">{blocked}</span>}
        </span>
        <Button type="button" variant="outline" size="sm" data-testid="crossfade-apply" disabled={disabled || Boolean(candidate.blocked) || !onCrossfade}
          onClick={() => { if (!disabled && !candidate.blocked) onCrossfade?.(candidate.outgoingClipId, candidate.incomingClipId); }}>{t('crossfade.apply')}</Button>
      </div>;
    })}
    {disabledReason && candidates.length > 0 && <p className="input-hint" role="status" data-testid="crossfade-disabled">{disabledReason}</p>}
    <p id={`${id}-hint`} className="input-hint">{t('crossfade.hint')}</p>
  </fieldset>;
}
