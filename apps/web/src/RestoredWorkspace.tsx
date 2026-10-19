import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { RESTORE_DISABLED_REASON, RESTORE_BACKUP_REASON } from './restored-workspace.ts';
import './restored-workspace.css';

export function RestoredUnavailable({ title, backup = false }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <section className="restored-unavailable notice" role="status" data-testid={backup ? 'restored-backup-unavailable' : 'restored-operation-unavailable'}>
    <strong>{title ?? t('recovery.restored.unavailable')}</strong><p>{t(backup ? 'recovery.restored.backupReason' : 'recovery.restored.disabledReason')}</p>
    {!backup && <p>{t('recovery.restored.records')}</p>}
  </section>;
}
export default function RestoredWorkspace({ workspace }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  if (!workspace?.restored) return null;
  const count = workspace.heldCounts.reduce((sum, item) => sum + item.count, 0);
  const localReady = ['asset.import', 'shot.update', 'timeline.render'].every(operation => workspace.operationPolicy.some(item => item.operation === operation && item.available));
  return <section className="restored-workspace-banner" role="status" data-testid="restored-workspace-banner">
    <div><strong>{t('recovery.restored.branch')}</strong><span>{t('recovery.restored.historyCount', { availability: t(localReady ? 'recovery.restored.localReady' : 'recovery.restored.localLimited'), count })}</span></div>
    <p>{t('recovery.restored.backupReason')}</p>
    <details><summary>{t('recovery.restored.details')}</summary><p>{t('recovery.restored.disabledReason')}</p><p>{t('recovery.restored.created', { time: formatDate(workspace.createdAt, { dateStyle: 'medium', timeStyle: 'medium' }) })}</p><p>{t('recovery.restored.source', { id: workspace.source.backupId })}</p><p>{t('recovery.restored.origin', { origin: workspace.workspaceOrigin })}</p><p>{t('recovery.restored.independent')}</p></details>
  </section>;
}
