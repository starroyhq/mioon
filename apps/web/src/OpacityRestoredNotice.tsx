import React from 'react';
import {useI18n} from './i18n/I18nProvider.tsx';

/** Disclosure only. The application mount and server independently verify43;
 * rendering this notice never grants permission or reads an excluded draft. */
export default function OpacityRestoredNotice({draftsPersistent = false}: {draftsPersistent?: boolean}) {
  const {t} = useI18n();
  return <section className="notice" role="status" data-testid="opacity-restored-notice">
    <strong>{t('opacity.restored.title')}</strong>
    <p>{t('opacity.restored.capabilities')}</p>
    <p data-testid="opacity-restored-draft-policy">{t(draftsPersistent ? 'opacity.restored.sourceDrafts' : 'opacity.restored.drafts')}</p>
    {draftsPersistent && <p data-testid="opacity-restored-draft-storage">{t('opacity.restored.draftsPersistent')}</p>}
    <p>{t('opacity.restored.view')}</p>
  </section>;
}
