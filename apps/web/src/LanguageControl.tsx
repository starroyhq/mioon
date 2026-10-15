import React, { useId } from 'react';
import { LANGUAGE_LABELS, LOCALES, isLanguagePreference } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
export default function LanguageControl() {
  const { t, preference, persistence, saving, setPreference } = useI18n();
  const id = useId();
  const notice = persistence === 'session' ? t('language.sessionOnly') : persistence === 'read-failed' ? t('language.readFailed') : persistence === 'host-unavailable' ? t('language.hostUnavailable') : '';
  return <div className="language-control" data-testid="language-control">
    <label htmlFor={id} className="sr-only">{t('language.label')}</label>
    <select id={id} data-testid="language-select" value={preference} aria-describedby={notice ? `${id}-notice` : undefined}
      aria-busy={saving} onChange={event => { if (isLanguagePreference(event.target.value)) void setPreference(event.target.value); }}>
      <option value="system">{t('language.system')}</option>
      {LOCALES.map(locale => <option key={locale} value={locale}>{LANGUAGE_LABELS[locale]}</option>)}
    </select>
    {notice && <span id={`${id}-notice`} role="status" className="language-notice">{notice}</span>}
    {saving && <span className="sr-only" role="status">{t('language.saving')}</span>}
  </div>;
}
