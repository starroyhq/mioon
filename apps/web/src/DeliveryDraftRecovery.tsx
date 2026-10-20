import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import ExportRangeSummary from './ExportRangeSummary.tsx';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import type { LocalDeliveryRenderInput } from '@mioon/contracts/local-delivery';
import type { LocalDeliveryController, LocalDeliveryState } from './local-delivery-state.ts';

export interface DeliveryDraftRecoveryProps {
  state: LocalDeliveryState;
  controller: LocalDeliveryController;
  disabled?: boolean;
}
const title = (value: string, t: ReturnType<typeof useI18n>['t']) => value === '' ? t('recovery.delivery.defaultName') : value;
function frozenProfile(input: LocalDeliveryRenderInput, t: ReturnType<typeof useI18n>['t']): string {
  const settings = input.exportSettings;
  if (!settings) return t('recovery.delivery.defaultSettings');
  const resolution = settings.resolution === 'native' ? t('recovery.delivery.native') : settings.resolution === 'short_360' ? t('recovery.delivery.short360') : t('recovery.delivery.short1080');
  const rate = settings.rateControl.mode === 'bitrate' ? t('export.settings.rateTarget', { rate: settings.rateControl.targetKbps / 1000 }) : settings.rateControl.quality === 'compact' ? t('export.settings.compact') : settings.rateControl.quality === 'high' ? t('export.settings.high') : t('export.settings.standard');
  return `MP4 · H.264 · ${resolution} · ${rate}`;
}

/** Passive right-dock presentation. Every write or execution has a named,
 * explicit control; rendering this panel never restores or submits anything. */
export default function DeliveryDraftRecovery({ state, controller, disabled = false }: DeliveryDraftRecoveryProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const blocked = disabled || state.busy;
  const unconfirmedPreparation = Boolean(state.retainedPreparation && state.intent?.intentId !== state.retainedPreparation.intentId);
  const savedTime = state.savedAt ? formatDate(state.savedAt, { dateStyle: 'medium', timeStyle: 'medium' }) : '';
  const status = state.phase === 'unsupported' ? t('recovery.delivery.unsupported')
    : state.phase === 'loading' ? t('recovery.delivery.loading')
      : state.autosavePaused ? t('recovery.delivery.paused')
        : state.phase === 'saving' ? t('recovery.delivery.saving')
          : state.candidate ? t('recovery.delivery.candidate')
            : state.phase === 'saved' ? t('recovery.delivery.saved', { time: savedTime ? ` · ${savedTime}` : '' })
              : state.phase === 'error' ? t('recovery.delivery.unconfirmed')
                : state.dirty ? t('recovery.delivery.dirty') : t('recovery.delivery.ready');
  // Recovery prioritizes an unconfirmed newer preparation over an older row.
  // Display all identity fields from that same target, without changing either.
  const original = unconfirmedPreparation ? null : state.intent;
  const retained = state.retainedPreparation;
  const displayed = unconfirmedPreparation ? retained : original ?? retained;
  const originalInput = displayed?.input;
  const originalTimelineId = displayed?.timelineId;
  const originalRevision = displayed?.baseRevision;
  const intentLabel = state.intentPhase === 'preparing' ? t('recovery.delivery.preparing')
    : state.intentPhase === 'executing' ? t('recovery.delivery.executing')
      : state.intentUncertain ? t('recovery.delivery.uncertain')
        : original?.outcome.status === 'pending' ? t('recovery.delivery.pending')
          : original?.outcome.status === 'accepted' ? t('recovery.delivery.accepted')
            : original?.outcome.status === 'not_applied' ? t('recovery.delivery.notApplied') : '';
  const recoveryNeeded = Boolean(state.candidate || state.baselineConflict || state.draftFailure || state.draftError || state.autosavePaused || state.intentUncertain || state.intentFailure || unconfirmedPreparation);
  return <section className="notice delivery-draft-recovery" data-testid="delivery-draft-recovery" data-recovery-needed={recoveryNeeded} aria-label={t('recovery.delivery.label')}>
    <p role="status" aria-live="polite" data-testid="delivery-draft-status">{status}</p>
    <RecoveryStorageDetails domain="delivery" />
    {state.phase === 'unsupported' && <p className="input-hint">{t('recovery.delivery.unsupportedHelp')}</p>}
    {state.candidate && <div data-testid="delivery-draft-candidate">
      <p>{t('recovery.delivery.savedName')}<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(state.candidate.raw.deliveryName, t)}</strong></p>
      <p className="input-hint">{t('export.revision', { revision: state.candidate.baseRevision })} · <time dateTime={state.candidate.updatedAt}>{formatDate(state.candidate.updatedAt, { dateStyle: 'medium', timeStyle: 'medium' })}</time></p>
      <details data-testid="delivery-draft-provenance"><summary>{t('recovery.delivery.provenance')}</summary><p style={{ overflowWrap: 'anywhere' }}>{t('recovery.delivery.provenanceValue', { timeline: state.candidate.timelineId, draft: state.candidate.draftId })}</p></details>
      <div className="clip-form-actions">
        <Button type="button" size="sm" variant="outline" data-testid="restore-delivery-draft" disabled={blocked} onClick={() => controller.restore()}>{t('recovery.delivery.restore')}</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="keep-current-delivery-name" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.keepCurrent(); }}>{t('recovery.delivery.keep')}</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="discard-stored-delivery-draft" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.discardStored(); }}>{t('recovery.delivery.discard')}</Button>
      </div>
      <p className="input-hint">{t('recovery.delivery.choicesHelp')}</p>
    </div>}
    {state.baselineConflict && state.baseline && <div className="notice warning" data-testid="delivery-draft-baseline-conflict">
      <p>{t('recovery.delivery.baseline', { revision: state.baseline.baseRevision })}</p>
      <Button type="button" size="sm" variant="outline" data-testid="use-current-delivery-baseline" disabled={blocked || state.autosavePaused || unconfirmedPreparation} onClick={() => { void controller.keepCurrent(); }}>{t('recovery.delivery.rebase')}</Button>
    </div>}
    {state.draftFailure && <p className="input-hint" data-testid="delivery-draft-failure-kind">{state.draftFailure.kind === 'refused' ? state.draftFailure.code === 'LOCAL_DELIVERY_LOCAL_VALIDATION' ? t('recovery.common.validation') : state.draftFailure.code === 'LOCAL_DELIVERY_LOCAL_RETRY_LIMIT' ? t('recovery.delivery.retryLimit') : state.draftFailure.code === 'LOCAL_DELIVERY_CAPACITY' ? t('recovery.delivery.capacity') : t('recovery.delivery.refused') : state.draftFailure.kind === 'conflict' ? t('recovery.delivery.conflict') : t('recovery.delivery.saveUnknown')} {t('recovery.common.readOnly')}</p>}
    {unconfirmedPreparation && <p className="input-hint">{t('recovery.delivery.preparationPending')}</p>}
    {state.retainedDraftWrite && state.autosavePaused && <p className="input-hint" data-testid="delivery-draft-retry-original">{t('recovery.delivery.retryName')}<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(state.retainedDraftWrite.raw.deliveryName, t)}</strong> · {t('export.revision', { revision: state.retainedDraftWrite.baseRevision })}。{t('recovery.common.retryIdentity')}</p>}
    {state.autosavePaused && state.draftRetry && <Button type="button" size="sm" variant="outline" data-testid="retry-delivery-name-save" disabled={blocked || state.phase === 'saving' || unconfirmedPreparation} onClick={() => { void controller.retryDraftSave(); }}>{state.draftRetry === 'same' ? t('recovery.delivery.retrySame') : t('recovery.delivery.saveCurrent')}</Button>}
    {state.autosavePaused && state.draftFailure && !state.draftRetry && <p className="input-hint">{t('recovery.delivery.deletionUncertain')}</p>}
    {state.draftError && <p role="alert" data-testid="delivery-draft-error">{renderMessage(state.draftErrorDisplay) || t('recovery.notice.unconfirmed')}</p>}
    {state.draftFailure?.kind === 'refused' && !state.leaveWithoutSaving && <Button type="button" size="sm" variant="outline" data-testid="leave-without-saving-delivery-name" disabled={blocked || state.phase === 'saving'} onClick={() => controller.allowLeaveWithoutSaving()}>{t('recovery.delivery.leave')}</Button>}
    {(state.phase === 'error' || state.autosavePaused || state.intentUncertain || state.intentFailure) && <Button type="button" size="sm" variant="ghost" data-testid="reload-local-delivery" disabled={blocked} onClick={() => { void controller.load(); }}>{t('recovery.common.recheck')}</Button>}
    {(original || state.intentUncertain || state.intentPhase === 'preparing') && <div data-testid="delivery-original-intent">
      <p role="status" aria-live="polite">{intentLabel}</p>
      {originalInput && <details open={recoveryNeeded || original?.outcome.status !== 'accepted'}>
        <summary>{t('recovery.delivery.originalDetails')}</summary>
        <p>{t('recovery.delivery.originalName')}<strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{title(originalInput.deliveryName ?? '', t)}</strong></p>
        <p className="input-hint">{t('recovery.delivery.originalProfile', { revision: originalRevision ?? '', profile: frozenProfile(originalInput, t) })}</p>
        <ExportRangeSummary input={originalInput} label={t('recovery.delivery.originalRange')} showWhole testId="delivery-original-range" />
        <details data-testid="delivery-intent-provenance"><summary>{t('recovery.delivery.originalDetails')}</summary><p style={{ overflowWrap: 'anywhere' }}>{t('recovery.delivery.requestDetails', { request: originalInput.requestId, timeline: originalTimelineId ?? '' })}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'inherit' }}>{JSON.stringify(originalInput, null, 2)}</pre></details>
        {(original?.outcome.status === 'pending' || state.intentUncertain) && <p className="input-hint">{t('recovery.delivery.recoverHelp')}</p>}
        {original?.outcome.status === 'accepted' && !state.intentUncertain && <p className="input-hint">{t('recovery.delivery.acceptedHelp')}</p>}
        {original?.outcome.status === 'not_applied' && !state.intentUncertain && <p className="input-hint">{t('recovery.delivery.notAppliedHelp')}</p>}
        {(original?.outcome.status === 'pending' || state.intentUncertain) && <Button type="button" size="sm" variant="outline" data-testid="recover-original-delivery" disabled={blocked} onClick={() => { void controller.recover(); }}>{t('recovery.delivery.recover')}</Button>}
      </details>}
      {state.intentUncertain && !original && <p className="input-hint">{t('recovery.delivery.noAcknowledgement')}</p>}
    </div>}
    {state.intentFailure && <p className="input-hint" data-testid="delivery-intent-failure-kind">{state.intentFailure.kind === 'refused' && !state.pending ? t('recovery.delivery.intentRefused') : state.intentFailure.kind === 'conflict' ? t('recovery.delivery.intentConflict') : t('recovery.delivery.intentUnknown')}</p>}
    {state.intentError && <p role="alert" data-testid="delivery-intent-error">{renderMessage(state.intentErrorDisplay) || t('recovery.notice.unconfirmed')}</p>}
  </section>;
}
