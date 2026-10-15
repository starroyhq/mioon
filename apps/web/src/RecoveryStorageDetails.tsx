import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';

export type RecoveryStorageDetailsProps =
  | { domain: 'clip' | 'delivery' | 'shot-text' }
  | { domain: 'task-center'; durableOperationCount: number };

/** Disclosure only. Storage limits and retention follow the existing contracts;
 * opening this native disclosure does not read, restore, or submit anything. */
export default function RecoveryStorageDetails(props: RecoveryStorageDetailsProps) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  if (props.domain === 'task-center') return <details className="helper muted" data-testid="recovery-task-storage-disclosure">
    <summary>{t('recovery.storage.title')}</summary>
    <p>{t('recovery.storage.durableCount', { count: props.durableOperationCount })}</p>
    <p>{t('recovery.storage.otherRules')}</p>
    <p>{t('recovery.storage.exceptions')}</p>
    <ul>
      <li>{t('recovery.storage.clipSlots')}</li>
      <li>{t('recovery.storage.deliverySlots')}</li>
      <li>{t('recovery.storage.textSlots')}</li>
      <li>{t('recovery.storage.recentSlot')}</li>
    </ul>
    <p>{t('recovery.storage.slotRetention')}</p>
    <p>{t('recovery.storage.privacy')}</p>
  </details>;

  if (props.domain === 'clip') return <details className="export-preflight-scope" data-testid="clip-draft-disclosure">
    <summary>{t('recovery.common.storageTitle')}</summary>
    <p>{t('recovery.storage.clipContent')}</p>
    <p>{t('recovery.storage.clipPrivacy')}</p>
    <p>{t('recovery.storage.clipCapacity')}</p>
    <p>{t('recovery.storage.clipDiscard')}</p>
    <p>{t('recovery.storage.clipBackup')}</p>
  </details>;

  if (props.domain === 'delivery') return <details className="export-preflight-scope" data-testid="delivery-draft-disclosure">
    <summary>{t('recovery.common.storageTitle')}</summary>
    <p>{t('recovery.storage.deliveryContent')}</p>
    <p>{t('recovery.storage.deliveryRequest')}</p>
    <p>{t('recovery.storage.deliveryCapacity')}</p>
    <p>{t('recovery.storage.deliveryPrivacy')}</p>
    <p>{t('recovery.storage.deliveryBackup')}</p>
  </details>;

  return <details className="export-preflight-scope" data-testid="shot-text-draft-disclosure">
    <summary>{t('recovery.common.storageTitle')}</summary>
    <p>{t('recovery.storage.textContent')}</p>
    <p>{t('recovery.storage.textRequest')}</p>
    <p>{t('recovery.storage.textCapacity')}</p>
    <p>{t('recovery.storage.textPrivacy')}</p>
    <p>{t('recovery.storage.textBackup')}</p>
  </details>;
}
