import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import RecoveryStorageDetails from './RecoveryStorageDetails.tsx';
import type { ClipDraftController, ClipDraftState } from './clip-draft-state.ts';

export default function ClipDraftRecovery({ state, controller, pending, onOpenRequests, disconnected = false, memoryOnly = false, restoredPersistence = false }: { disconnected?: boolean; memoryOnly?: boolean; restoredPersistence?: boolean; state: ClipDraftState; controller: ClipDraftController; pending: boolean; onOpenRequests?: () => void }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const confirm = useConfirmation();
  pending = pending || state.compositionPending;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const time = state.savedAt ? formatDate(state.savedAt, { timeStyle: 'medium' }) : '';
  const canOfferAbandon = state.dirty && (disconnected || state.autosavePaused || state.phase === 'error' || state.phase === 'saving' || state.submitting && !state.businessPending);
  async function abandon() {
    const captured = controller.capture();
    if (pendingRef.current || !controller.canAbandon(captured)) return;
    const accepted = await confirm(message('recovery.clip.abandonConfirm'));
    if (accepted && !pendingRef.current && controller.canAbandon(captured)) controller.abandonCurrentInput(captured);
  }
  const status = state.compositionPending ? t('volume.envelope.composing') : state.phase === 'unsupported' ? t('recovery.clip.unsupported')
    : state.phase === 'loading' ? state.autosavePaused ? t('recovery.clip.recheckingPaused') : t('recovery.clip.loading')
      : state.autosavePaused ? state.retainedRecord && !state.dirty ? t('recovery.clip.reset') : t('recovery.clip.paused')
        : state.phase === 'saving' ? t('recovery.clip.saving')
          : state.phase === 'saved' ? t('recovery.clip.saved', { time: time ? ` · ${time}` : '' })
            : state.phase === 'error' ? t('recovery.clip.unconfirmed')
              : state.candidate ? t('recovery.clip.candidate', { time: time ? ` · ${time}` : '' })
                : state.dirty ? t('recovery.clip.dirty') : t('recovery.clip.ready');
  return <section className="notice" data-testid="clip-draft-recovery" aria-label={t('recovery.clip.label')}>
    <p role="status" data-testid="clip-draft-status">{status}</p>
    <p className="input-hint">{t(memoryOnly ? 'opacity.restored.currentDraft' : restoredPersistence ? 'opacity.restored.draftDisclosure' : 'recovery.clip.shortDisclosure')}</p>
    {restoredPersistence ? <details className="export-preflight-scope" data-testid="clip-draft-disclosure"><summary>{t('recovery.common.storageTitle')}</summary><p>{t('opacity.restored.draftStorage')}</p><p>{t('recovery.storage.clipCapacity')}</p><p>{t('recovery.storage.clipDiscard')}</p></details> : !memoryOnly && <RecoveryStorageDetails domain="clip" />}
    {state.candidate && <div><Button type="button" size="sm" variant="outline" data-testid="restore-clip-draft" disabled={pending || state.dirty || state.submitting} onClick={() => controller.restore()}>{t('recovery.clip.restore')}</Button><Button type="button" size="sm" variant="ghost" data-testid="discard-stored-clip-draft" disabled={pending || state.submitting} onClick={() => { void controller.discardStored(); }}>{t('recovery.clip.discard')}</Button>{state.dirty && <p className="input-hint">{t('recovery.clip.newInput')}</p>}</div>}
    {state.failure && <p className="input-hint" data-testid="clip-draft-failure-kind">{state.failure.kind === 'refused' ? t('recovery.clip.refused') : state.failure.kind === 'conflict' ? t('recovery.clip.conflict') : t('recovery.clip.unknown')} {t('recovery.clip.recheckOnly')}</p>}
    {state.error && <p role="alert">{renderMessage(state.errorDisplay) || t(restoredPersistence ? 'opacity.restored.draftUnavailable' : 'recovery.notice.unconfirmed')}</p>}
    {(state.phase === 'error' || state.autosavePaused) && <Button type="button" size="sm" variant="ghost" data-testid="reload-clip-draft" disabled={pending || state.submitting} onClick={() => { void controller.load(); }}>{t('recovery.clip.recheck')}</Button>}
    {canOfferAbandon && <Button type="button" size="sm" variant="outline" data-testid="abandon-current-clip-input" data-retained-input-action="abandon" disabled={pending || !controller.canAbandon()} onClick={abandon}>{t('recovery.clip.abandon')}</Button>}
    {pending && <p>{t('recovery.clip.pending')}{onOpenRequests && <Button type="button" size="sm" variant="ghost" onClick={onOpenRequests}>{t('recovery.clip.tasks')}</Button>}</p>}
  </section>;
}
