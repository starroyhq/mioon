import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { TIMELINE_LOUDNESS_APPLY_LIMITATION, timelineLoudnessApplyErrorMessage, timelineLoudnessCanReview } from './timeline-loudness-apply-state.ts';
import type { TimelineLoudnessApplyView } from './timeline-loudness-apply-state.ts';
import type { TimelineMixLoudnessState } from './timeline-mix-loudness-state.ts';
export interface TimelineLoudnessApplyProps { readonly apply: TimelineLoudnessApplyView; readonly observation: TimelineMixLoudnessState; readonly onOpenTasks: () => void }
export default function TimelineLoudnessApply({ apply, observation, onOpenTasks }: TimelineLoudnessApplyProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const { state, controller } = apply, pending = state.phase === 'submitting' || state.phase === 'unknown';
  if (!observation.scope || !observation.projectId || observation.restored || !observation.visible) return null;
  const owned = state.scope === observation.scope && state.projectId === observation.projectId;
  const canReview = timelineLoudnessCanReview(observation) && (!owned || !['digesting', 'confirming', 'submitting', 'unknown'].includes(state.phase) && (!['error', 'applied'].includes(state.phase) || state.observationVersion !== observation.version));
  if (!observation.report && !owned) return null;
  const message = !owned ? '' : state.phase === 'digesting' ? t('audio.loudness.apply.digesting') : state.phase === 'confirming' ? t('audio.loudness.apply.confirming') :
    state.phase === 'submitting' ? t('audio.loudness.apply.submitting') : state.phase === 'unknown' ? t('audio.loudness.apply.unknown') :
    state.phase === 'applied' ? t('audio.loudness.apply.applied') : state.phase === 'stale' ? t('audio.loudness.apply.stale') : state.error ? timelineLoudnessApplyErrorMessage({ code: state.errorCode }, locale) : '';
  return <section data-testid="timeline-loudness-apply" aria-label={t('audio.loudness.apply.label')}>
    <p className="export-sample-peak-limitation">{t('audio.loudness.apply.limitation')}</p>
    <Button type="button" variant="ghost" className="button quiet small" data-testid="timeline-loudness-apply-review" disabled={!canReview}
      onClick={() => { void controller.review(observation); }}>{t('audio.loudness.apply.review')}</Button>
    {message && <p role="status" aria-live="polite" data-testid="timeline-loudness-apply-status">{message}</p>}
    {owned && pending && <Button type="button" variant="ghost" className="button quiet small" data-testid="timeline-loudness-apply-tasks" onClick={onOpenTasks}>{t('audio.loudness.apply.original')}</Button>}
  </section>;
}
