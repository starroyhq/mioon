import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';

export type TopbarSaveStatusProps = Readonly<{
  online: boolean;
  syncing: boolean;
  dirty: boolean;
  lastSync: Date | null;
  preferenceStatus: Readonly<{ phase: string; pending: boolean; canRetry?: boolean }>;
  onRetry: () => void;
  onReload: () => void;
}>;

export default function TopbarSaveStatus({
  online, syncing, dirty, lastSync, preferenceStatus, onRetry, onReload,
}: TopbarSaveStatusProps) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  return <>
    <div className="topbar-sync" title={lastSync ? t('shell.sync.last', { time: formatDate(lastSync, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : ''}>
      <span className={`status-dot ${!online ? 'red' : syncing ? 'orange' : 'green'}`} />
      {!online ? t('shell.sync.disconnected') : syncing ? t('shell.sync.syncing') : dirty ? t('shell.sync.unsaved') : t('shell.sync.saved')}
    </div>
    <div className="workspace-save-status" data-testid="workspace-save-status" data-phase={preferenceStatus.phase} role="status">
      {['local', 'conflict', 'error'].includes(preferenceStatus.phase) ? <>
        <span>{preferenceStatus.phase === 'conflict' ? t('shell.sync.otherWindow') : t('shell.sync.viewNotSynced')}</span>
        {preferenceStatus.phase === 'error' && preferenceStatus.canRetry && <Button variant="ghost" className="text-button" data-testid="retry-workspace-save" onClick={onRetry}>{t('shell.retry')}</Button>}
        <Button variant="ghost" className="text-button" data-testid="reload-workspace-preferences" onClick={onReload}>{t('shell.sync.loadSaved')}</Button>
      </> : preferenceStatus.pending ? <span>{t('shell.sync.savingView')}</span> : null}
    </div>
  </>;
}
