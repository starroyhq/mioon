import { translate, message, renderMessage, formatDate, formatNumber } from '../../packages/i18n/src/index.ts';
import type { DisplayMessage, Locale, MessageArguments, MessageKey } from '../../packages/i18n/src/index.ts';
/** Pinned-language presentation fixture for existing custom React/esbuild harnesses.
 * It does not replace application controllers or weaken behavioral assertions. */
export function createI18nTestContext(locale: Locale = 'zh-Hans') {
  return Object.freeze({ locale, preference: locale, persistence: 'saved' as const, saving: false,
    t: <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => translate(locale, key, ...args),
    renderMessage: (value: DisplayMessage | string | null | undefined) => renderMessage(locale, value),
    formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => formatDate(locale, value, options),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, value, options),
    setPreference: async () => { throw new Error('A pinned test context cannot change language. Use the actual store for switching tests.'); },
  });
}
export function i18nTestModule(locale: Locale = 'zh-Hans') { const context = createI18nTestContext(locale); return { useI18n: () => context }; }
export { translate, message, renderMessage, formatDate, formatNumber };
