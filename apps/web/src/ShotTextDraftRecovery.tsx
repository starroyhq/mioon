import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import type { LocalShotTextController, LocalShotTextState } from './local-shot-text-state.ts';

export interface ShotTextDraftRecoveryProps {
  state: LocalShotTextState; controller: LocalShotTextController; disabled?: boolean; canSave?: boolean; onInspect?: (shotId: string) => void;
}
const rawStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
/** No inputs, dialogs or effects: this recovery view operates the existing form. */
export default function ShotTextDraftRecovery({ state, controller, disabled = false, canSave = false, onInspect }: ShotTextDraftRecoveryProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const blocked = disabled || state.busy || state.phase === 'saving';
  const unconfirmed = Boolean(state.retainedPreparation && state.intent?.intentId !== state.retainedPreparation.intentId);
  const original = state.intent, retained = state.retainedPreparation, originalInput = original?.input ?? retained?.input;
  const originalRevision = original?.baseRevision ?? retained?.baseRevision;
  const other = state.projectPendingIntent && state.projectPendingIntent.shotId !== state.shotId ? state.projectPendingIntent : null;
  const status = state.phase === 'unsupported' ? t('recovery.text.unsupported')
    : state.phase === 'loading' ? t('recovery.text.loading')
      : state.autosavePaused ? t('recovery.text.paused')
        : state.phase === 'saving' ? t('recovery.text.saving')
          : state.candidate ? t('recovery.text.candidate')
            : state.phase === 'saved' ? t('recovery.text.saved', { time: state.savedAt ? ` · ${formatDate(state.savedAt, { dateStyle: 'medium', timeStyle: 'medium' })}` : '' })
              : state.dirty ? t('recovery.text.dirty') : t('recovery.text.synced');
  return <section className="notice shot-text-draft-recovery" data-testid="shot-text-draft-recovery" aria-label={t('recovery.text.label')}>
    <p role="status" aria-live="polite" data-testid="shot-text-draft-status">{status}</p>
    {state.phase !== 'unsupported' && <Button type="button" size="sm" className="button primary" data-testid="save-shot-text" disabled={blocked || !canSave} onClick={() => { void controller.submit(); }}>{t('recovery.text.save')}</Button>}
    {state.dirty && (!state.raw.title.trim() || state.raw.title.length > 150 || state.raw.prompt.length > 5000) && <p className="input-hint" role="status">{t('recovery.text.validationHelp')}</p>}
    <RecoveryStorageDetails domain="shot-text" />
    {state.phase === 'unsupported' && <p className="input-hint">{t('recovery.text.unsupportedHelp')}</p>}
    {state.candidate && <div data-testid="shot-text-draft-candidate">
      <p>{t('recovery.text.savedTitle')}<strong style={rawStyle}>{state.candidate.raw.title || t('recovery.common.originalTitle')}</strong></p>
      <details data-testid="shot-text-draft-provenance"><summary>{t('recovery.text.provenance', { revision: state.candidate.baseRevision })}</summary>
        <p style={rawStyle}>{state.candidate.raw.prompt || t('recovery.common.emptyPrompt')}</p><p style={rawStyle}>{t('recovery.text.draftIdentity', { draft: state.candidate.draftId, time: formatDate(state.candidate.updatedAt, { dateStyle: 'medium', timeStyle: 'medium' }) })}</p>
        <p style={rawStyle}>{t('recovery.text.originalTitle')}{state.candidate.baseText.title}</p><p style={rawStyle}>{t('recovery.text.originalPrompt')}{state.candidate.baseText.prompt || t('recovery.common.emptyPrompt')}</p>
      </details>
      <div className="clip-form-actions">
        <Button type="button" size="sm" variant="outline" data-testid="restore-shot-text" disabled={blocked || state.pending} onClick={() => controller.restore()}>{t('recovery.text.restore')}</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="keep-current-shot-text" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.keepCurrent(); }}>{t('recovery.text.keep')}</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="discard-shot-text-draft" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.discardStored(); }}>{t('recovery.text.discard')}</Button>
      </div>
    </div>}
    {state.baselineConflict && state.baseline && <div className="notice warning" data-testid="shot-text-baseline-conflict"><p>{t('recovery.text.baseline', { revision: state.baseline.baseRevision })}</p>
      <Button type="button" size="sm" variant="outline" disabled={blocked || state.pending || state.autosavePaused || unconfirmed} onClick={() => { void controller.keepCurrent(); }}>{t('recovery.text.rebase')}</Button>
    </div>}
    {state.draftFailure && <p className="input-hint" data-testid="shot-text-failure-kind">{state.draftFailure.kind === 'refused' ? state.draftFailure.code === 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION' ? t('recovery.common.validation') : state.draftFailure.code === 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT' ? t('recovery.text.retryLimit') : t('recovery.text.refused') : state.draftFailure.kind === 'conflict' ? t('recovery.text.conflict') : t('recovery.text.unknown')} {t('recovery.common.readOnly')}</p>}
    {unconfirmed && <p className="input-hint">{t('recovery.text.preparationPending')}</p>}
    {state.retainedDraftWrite && state.autosavePaused && <details data-testid="shot-text-retry-provenance"><summary>{t('recovery.text.retryDetails')}</summary><p style={rawStyle}>{state.retainedDraftWrite.raw.title || t('recovery.common.originalTitle')}</p><p style={rawStyle}>{state.retainedDraftWrite.raw.prompt || t('recovery.common.emptyPrompt')}</p><p>{t('recovery.common.retryIdentity')}</p></details>}
    {state.autosavePaused && state.draftRetry && <Button type="button" size="sm" variant="outline" data-testid="retry-shot-text-draft" disabled={blocked || unconfirmed} onClick={() => { void controller.retryDraftSave(); }}>{state.draftRetry === 'same' ? t('recovery.text.retrySame') : t('recovery.text.saveCurrent')}</Button>}
    {state.autosavePaused && (state.draftFailure || state.retainedDeletion) && !state.draftRetry && <p className="input-hint">{t('recovery.text.deletionUncertain')}</p>}
    {state.retainedDeletion && <Button type="button" size="sm" variant="outline" data-testid="retry-shot-text-deletion" disabled={blocked} onClick={() => { void controller.retryDraftDeletion(); }}>{t('recovery.text.retryDeletion')}</Button>}
    {state.retainedDeletion && <Button type="button" size="sm" variant="outline" data-testid="accept-shot-text-current-state" disabled={blocked} onClick={() => { void controller.acceptCurrentAfterDeletion(); }}>{t('recovery.text.acceptState')}</Button>}
    {state.draftError && <p role="alert">{renderMessage(state.draftErrorDisplay) || t('recovery.notice.unconfirmed')}</p>}
    {state.draftFailure?.kind === 'refused' && !state.leaveWithoutSaving && <Button type="button" size="sm" variant="outline" data-testid="leave-shot-text-unsaved" disabled={blocked} onClick={() => controller.allowLeaveWithoutSaving()}>{t('recovery.text.leave')}</Button>}
    {(state.phase === 'error' || state.autosavePaused || state.intentUncertain || state.intentFailure || state.retainedDeletion || other) && <Button type="button" size="sm" variant="ghost" data-testid="reload-shot-text" disabled={blocked} onClick={() => { void controller.load(); }}>{t('recovery.common.recheck')}</Button>}
    {other && <div role="status" data-testid="other-shot-text-pending"><p>{t('recovery.text.otherPending')}</p>{onInspect && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => onInspect(other.shotId)}>{t('recovery.text.inspect')}</Button>}</div>}
    {(original || state.intentUncertain) && <div data-testid="shot-text-original-intent">
      <p role="status">{state.intentPhase === 'preparing' ? t('recovery.text.preparing') : state.intentPhase === 'executing' ? t('recovery.text.executing') : state.intentUncertain ? t('recovery.text.intentUnknown') : original?.outcome.status === 'applied' ? t('recovery.text.applied') : original?.outcome.status === 'not_applied' ? t('recovery.text.notApplied') : t('recovery.text.pending')}</p>
      {originalInput && <details data-testid="shot-text-intent-provenance"><summary>{t('recovery.text.originalDetails', { revision: originalRevision ?? '' })}</summary><p style={rawStyle}>{t('recovery.text.requestId', { request: originalInput.requestId })}</p><pre style={{ ...rawStyle, fontSize: 'inherit' }}>{JSON.stringify(originalInput, null, 2)}</pre></details>}
      {(original?.outcome.status === 'pending' || state.intentUncertain) && <><p className="input-hint">{t('recovery.text.recoverHelp')}</p><Button type="button" size="sm" variant="outline" data-testid="recover-shot-text-request" disabled={blocked || Boolean(other)} onClick={() => { void controller.recover(); }}>{t('recovery.text.recover')}</Button></>}
      {original?.outcome.status === 'not_applied' && !state.intentUncertain && <p className="input-hint">{t('recovery.text.notAppliedHelp')}</p>}
      {original?.outcome.status === 'applied' && !state.intentUncertain && <p className="input-hint">{t('recovery.text.appliedHelp')}</p>}
    </div>}
    {state.intentError && <p role="alert">{renderMessage(state.intentErrorDisplay) || t('recovery.notice.unconfirmed')}</p>}
  </section>;
}
