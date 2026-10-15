import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { translate, renderMessage, formatDate, formatNumber } from '../../../../packages/i18n/src/index.ts';
import type { DisplayMessage, LanguagePreference, Locale, MessageArguments, MessageKey } from '../../../../packages/i18n/src/index.ts';
import { LANGUAGE_STORAGE_KEY } from '../../../../packages/i18n/src/preference.ts';
import type { LanguageBridge, LanguagePersistence } from '../../../../packages/i18n/src/preference.ts';
import { createLanguageStore } from './language-store.ts';
interface I18nContextValue {
  locale: Locale; preference: LanguagePreference; persistence: LanguagePersistence; saving: boolean;
  t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
  renderMessage: (value: DisplayMessage | string | null | undefined) => string;
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  setPreference: (preference: LanguagePreference) => Promise<void>;
}
function display(locale: Locale) { return {
  t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => translate(locale, key, ...args),
  renderMessage: (value: DisplayMessage | string | null | undefined) => renderMessage(locale, value),
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatDate(locale, value, options),
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, value, options),
}; }
/** Standalone component rendering retains the legacy test locale. The actual
 * application always installs the provider before mounting business children. */
const Context = createContext<I18nContextValue>({ locale: 'zh-Hans', preference: 'zh-Hans', persistence: 'session', saving: false, ...display('zh-Hans'),
  setPreference: async () => { throw new Error('Language changes require I18nProvider.'); } });
function browserBridge(): LanguageBridge | null {
  const value = (window as Window & { __mioonAppLanguage?: LanguageBridge }).__mioonAppLanguage;
  if (value === undefined) return null;
  if (!value || typeof value.read !== 'function' || typeof value.set !== 'function' || typeof value.subscribe !== 'function') throw new Error('Invalid app-language bridge.');
  return value;
}
export function I18nProvider({ children, store: supplied }: { children: ReactNode; store?: ReturnType<typeof createLanguageStore> }) {
  const [store] = useState(() => supplied ?? createLanguageStore({ systemLanguages: [...navigator.languages], storage: () => localStorage, bridge: browserBridge() }));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const release = store.connect();
    const changed = (event: StorageEvent) => { if (event.key === LANGUAGE_STORAGE_KEY) store.receiveStorage(event.newValue); };
    const systemChanged = () => { void store.updateSystemLanguages([...navigator.languages]); };
    window.addEventListener('storage', changed);
    window.addEventListener('languagechange', systemChanged);
    return () => { release(); window.removeEventListener('storage', changed); window.removeEventListener('languagechange', systemChanged); };
  }, [store]);
  useLayoutEffect(() => {
    document.documentElement.lang = state.locale; document.title = translate(state.locale, 'app.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', translate(state.locale, 'app.description'));
  }, [state.locale]);
  const value = useMemo<I18nContextValue>(() => ({ locale: state.locale, preference: state.preference, persistence: state.persistence, saving: state.saving,
    ...display(state.locale), setPreference: store.setPreference }), [state.locale, state.preference, state.persistence, state.saving, store]);
  return <Context.Provider value={value}>{state.ready ? children : <main className="boot-page" role="status">{value.t('language.loading')}</main>}</Context.Provider>;
}
export const useI18n = (): I18nContextValue => useContext(Context);
export { createLanguageStore } from './language-store.ts';
