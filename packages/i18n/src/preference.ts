import { isLanguagePreference, isLocale } from './locale.ts';
import type { LanguagePreference, Locale } from './types.ts';
export const LANGUAGE_STORAGE_KEY = 'mioon.app-language.v1';
export const LANGUAGE_PREFERENCE_MAX_BYTES = 4096;
export type LanguagePersistence = 'saved' | 'session' | 'read-failed' | 'host-unavailable';
export interface LanguageSnapshot { readonly version: 1; readonly revision: number; readonly preference: LanguagePreference; readonly locale: Locale; readonly persistence: LanguagePersistence }
export interface LanguageBridge { read(): Promise<LanguageSnapshot>; set(preference: LanguagePreference): Promise<LanguageSnapshot>; subscribe(listener: (value: LanguageSnapshot) => void): () => void }
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
const fields = (value: Record<string, unknown>, keys: readonly string[]) => Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
});
export function parseLanguagePreference(raw: string): LanguagePreference {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LANGUAGE_PREFERENCE_MAX_BYTES) throw new TypeError('Invalid language preference.');
  const value: unknown = JSON.parse(raw);
  if (!plain(value) || !fields(value, ['version', 'preference']) || value.version !== 1 || !isLanguagePreference(value.preference)) throw new TypeError('Invalid language preference.');
  return value.preference;
}
export const serializeLanguagePreference = (preference: LanguagePreference): string => {
  if (!isLanguagePreference(preference)) throw new TypeError('Invalid language preference.');
  return JSON.stringify({ version: 1, preference }) + '\n';
};
export function isLanguageSnapshot(value: unknown): value is LanguageSnapshot {
  return plain(value) && fields(value, ['version', 'revision', 'preference', 'locale', 'persistence']) && value.version === 1 &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && isLanguagePreference(value.preference) && isLocale(value.locale) &&
    typeof value.persistence === 'string' && ['saved', 'session', 'read-failed', 'host-unavailable'].includes(value.persistence) &&
    (value.preference === 'system' || value.preference === value.locale);
}
export const APP_LANGUAGE_CHANNEL = 'mioon:app-language:v1';
export const APP_LANGUAGE_EVENT = 'mioon:app-language-state:v1';
export type LanguageRequest = { readonly action: 'read' } | { readonly action: 'set'; readonly preference: LanguagePreference };
export function isLanguageRequest(value: unknown): value is LanguageRequest {
  return plain(value) && (fields(value, ['action']) && value.action === 'read' ||
    fields(value, ['action', 'preference']) && value.action === 'set' && isLanguagePreference(value.preference));
}
