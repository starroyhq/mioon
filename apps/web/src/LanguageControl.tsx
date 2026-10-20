import React, { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { WorkbenchSelect } from '@mioon/ui/components/workbench-select';
import { LANGUAGE_LABELS, LOCALES, isLanguagePreference } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
export default function LanguageControl({ visible = true }: { visible?: boolean }) {
  const { t, preference, persistence, saving, setPreference } = useI18n();
  const id = useId();
  const scope = useMemo(() => ({ visible }), [visible]);
  const current = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => { current.current = scope; return () => { current.current = null; }; }, [scope]);
  const notice = persistence === 'session' ? t('language.sessionOnly') : persistence === 'read-failed' ? t('language.readFailed') : persistence === 'host-unavailable' ? t('language.hostUnavailable') : '';
  return <div className="language-control" data-testid="language-control">
    <label htmlFor={id} className="sr-only">{t('language.label')}</label>
    <WorkbenchSelect id={id} data-testid="language-select" value={preference} visible={visible} aria-label={t('language.label')} aria-describedby={notice ? `${id}-notice` : undefined}
      aria-busy={saving} onChange={event => { if (scope.visible && current.current === scope && isLanguagePreference(event.target.value)) void setPreference(event.target.value); }}>
      <option value="system">{t('language.system')}</option>
      {LOCALES.map(locale => <option key={locale} value={locale}>{LANGUAGE_LABELS[locale]}</option>)}
    </WorkbenchSelect>
    {notice && <span id={`${id}-notice`} role="status" className="language-notice">{notice}</span>}
    {saving && <span className="sr-only" role="status">{t('language.saving')}</span>}
  </div>;
}
