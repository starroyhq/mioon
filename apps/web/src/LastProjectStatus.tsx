import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import type { LastProjectController, LastProjectState } from './last-project-state.ts';

export default function LastProjectStatus({ state, controller, restored = false }: { state: LastProjectState; controller: LastProjectController; restored?: boolean }) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  if (restored) return <section className="input-hint" aria-label={t('projects.locator')} title={t('projects.locatorRestoredHint')} data-testid="last-project-status" data-phase="unavailable"><span role="status">{t('projects.locatorRestored')}</span></section>;
  const status = state.phase === 'saved' ? t('projects.locatorSaved')
    : state.phase === 'pending' ? t('projects.locatorPending')
      : state.phase === 'conflict' ? t('projects.locatorConflict')
        : state.phase === 'unavailable' ? t('projects.locatorUnavailable')
          : state.phase === 'error' ? t('projects.locatorUnconfirmed')
            : state.phase === 'loading' ? t('projects.locatorLoading')
              : state.targetStatus === 'missing' ? t('projects.locatorMissing')
                : t('projects.recent');
  return <section aria-label={t('projects.locator')} title={t('projects.locatorStatus', { status })} data-testid="last-project-status" data-phase={state.phase}
    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, whiteSpace: 'nowrap' }}>
    <span role="status" aria-live="polite">{status}</span>
    <details style={{ position: 'relative' }}>
      <summary aria-label={t('projects.locatorDetails')}>{t('shell.details')}</summary>
      <div className="notice" style={{ position: 'absolute', top: '100%', right: 0, width: 280, zIndex: 30, whiteSpace: 'normal' }}>
        <p>{t('projects.locatorScope')}</p>
        {state.uncertain && <p role="alert">{t('projects.locatorUncertain')}</p>}
        {!state.uncertain && state.phase === 'conflict' && <p role="alert">{t('projects.locatorWritesStopped')}</p>}
        {state.identityBlocked && <p>{t('projects.locatorIdentityChanged')}</p>}
        {state.phase === 'unavailable' && <p>{t('projects.locatorManualOpen')}</p>}
        {state.rechecked && (state.phase === 'error' || state.phase === 'conflict') && <p data-testid="last-project-rechecked">{t('projects.locatorRechecked')}</p>}
        {state.canRetry && <Button type="button" size="sm" variant="outline" data-testid="last-project-retry" onClick={() => { void controller.retry(); }}>{t('projects.retrySameWrite')}</Button>}
        {(state.phase === 'error' || state.phase === 'conflict' || state.phase === 'unavailable') && state.canRecheck &&
          <Button type="button" size="sm" variant="ghost" data-testid="last-project-recheck" onClick={() => { void controller.recheck(); }}>{t('shell.readOnlyCheck')}</Button>}
        {state.reading && state.phase !== 'loading' && <span role="status">{t('shell.checkingReadOnly')}</span>}
      </div>
    </details>
  </section>;
}
