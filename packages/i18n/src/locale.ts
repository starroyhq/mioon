import type { LanguagePreference, Locale } from './types.ts';
export const LOCALES = Object.freeze(['zh-Hans', 'zh-Hant', 'en', 'ja'] as const);
export const LANGUAGE_LABELS: Readonly<Record<Locale, string>> = Object.freeze({ 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語' });
export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
export const isLanguagePreference = (value: unknown): value is LanguagePreference => value === 'system' || isLocale(value);
/** OS regions only normalize input. Catalogs and UI never expose region variants. */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const input = value.trim().replaceAll('_', '-').split(/[.@]/u)[0];
  if (!input || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(input)) return null;
  let parsed: Intl.Locale;
  try { parsed = new Intl.Locale(input); } catch { return null; }
  if (parsed.language === 'en') return 'en';
  if (parsed.language === 'ja') return 'ja';
  if (parsed.language !== 'zh') return null;
  if (parsed.script === 'Hant') return 'zh-Hant';
  if (parsed.script === 'Hans') return 'zh-Hans';
  if (parsed.script) return null;
  return ['TW', 'HK', 'MO'].includes(parsed.region ?? '') ? 'zh-Hant' : 'zh-Hans';
}
export function resolveLocale(preference: LanguagePreference, systemLanguages: readonly unknown[] = []): Locale {
  if (isLocale(preference)) return preference;
  for (const value of systemLanguages) { const locale = normalizeLocale(value); if (locale) return locale; }
  return 'en';
}
