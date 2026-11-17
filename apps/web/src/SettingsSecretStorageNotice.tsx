import React from 'react';
import {Button} from '@mioon/ui/components/button';
import {hasDesktopWindowBridge} from './desktop-window-client.ts';
import {useI18n} from './i18n/I18nProvider.tsx';

export function SettingsSecretStorageNotice({storage, pendingConfirmed, retry, disabled, testId}: {
  storage: {persistentAvailable: boolean; reasonCode: string | null} | null | undefined;
  pendingConfirmed?: boolean;
  retry: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  const {t} = useI18n();
  if (!storage || storage.persistentAvailable) return null;
  const desktop = hasDesktopWindowBridge();
  if (!desktop) return <p role="status" data-testid={testId}>{t('connections.storage.desktopRequired')}</p>;
  if (storage.reasonCode === 'OS_SECRET_STORE_PENDING') {
    return pendingConfirmed ? <p role="status" data-testid={testId}>{t('connections.storage.keychainPending')}</p> : null;
  }
  return <div className="settings-with-help" role="status" data-testid={testId}>
    <span>{t('connections.storage.unavailableReason')}</span>
    <Button type="button" variant="ghost" disabled={disabled} onClick={retry}>{t('projectFile.common.retry')}</Button>
  </div>;
}
