import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
/** Editors show the one global writer's status; only the independent settings
 * surface forwards explicit recovery intents to that exact retained owner. */
export default function NativeLocatorStatus({ context, bridge, recovery = false }: {
  readonly context: ProjectWindowContext; readonly bridge: ProjectWindowBridge; readonly recovery?: boolean;
}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const state = context.locatorStatus;
  const label = !state ? t('projects.locatorChecking') : state.phase === 'saved' ? t('projects.locatorSaved') : state.phase === 'pending' ? t('projects.locatorPending')
    : state.phase === 'conflict' ? t('projects.locatorConflict') : state.phase === 'unavailable' ? t('projects.locatorUnavailable') : state.phase === 'error' ? t('projects.locatorUnconfirmed')
      : state.phase === 'loading' ? t('projects.locatorLoading') : t('projects.recent');
  return <section aria-label={t('projects.locator')} data-testid="native-last-project-status" data-phase={state?.phase ?? 'loading'} className={recovery ? 'project-home-notice' : 'native-locator-status'} style={recovery ? undefined : { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap' }}>
    <span role="status" aria-live="polite">{label}</span>
    {recovery ? <>
      <p>{t('projects.locatorOwner')}</p>
      {state?.uncertain && <p role="alert">{t('projects.locatorOriginalRetained')}</p>}
      {state?.phase === 'conflict' && <p role="alert">{t('projects.locatorConflictScope')}</p>}
      {state?.identityBlocked && <p>{t('projects.locatorKeepWindow')}</p>}
      {state?.rechecked && <p>{t('projects.locatorRechecked')}</p>}
      {state?.canRetry && <Button type="button" variant="outline" disabled={context.quitting} onClick={() => { void bridge.requestLocatorAction('retry', state.statusVersion).catch(() => {}); }}>{t('projects.retrySameWrite')}</Button>}
      {state?.canRecheck && <Button type="button" variant="ghost" disabled={context.quitting || state.reading} onClick={() => { void bridge.requestLocatorAction('recheck', state.statusVersion).catch(() => {}); }}>{t('shell.readOnlyCheck')}</Button>}
      {state?.reading && <span role="status">{t('shell.checkingReadOnly')}</span>}
    </> : <Button type="button" size="sm" variant="ghost" aria-label={t('projects.locatorView')} disabled={context.quitting} onClick={() => { void bridge.showSettings('agent').catch(() => {}); }}>{t('shell.details')}</Button>}
  </section>;
}
