import { APP_LANGUAGE_EVENT, isLanguageRequest, parseLanguagePreference, serializeLanguagePreference } from '../../../packages/i18n/src/preference.ts';
import type { LanguageSnapshot } from '../../../packages/i18n/src/preference.ts';
import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { LanguagePreference } from '../../../packages/i18n/src/types.ts';
export interface LanguageIPCEvent { readonly sender: unknown; readonly senderFrame: unknown }
interface Options {
  systemLanguages: () => readonly string[];
  isTrusted: (event: LanguageIPCEvent) => boolean;
  broadcast: (channel: typeof APP_LANGUAGE_EVENT, state: LanguageSnapshot) => void;
  onChanged?: (state: LanguageSnapshot) => void;
  storage: { read: () => string | null; write: (text: string) => void };
}
/** Independent app preferences: never touches workspace/project settings or credentials. */
export function createAppLanguageHost(options: Options) {
  const storage = options.storage;
  let preference: LanguagePreference = 'system', persistence: LanguageSnapshot['persistence'] = 'saved', revision = 0;
  try { const raw = storage.read(); if (raw !== null) preference = parseLanguagePreference(raw); }
  catch { persistence = 'read-failed'; }
  let announcedLocale = resolveLocale(preference, options.systemLanguages());
  const snapshot = (): LanguageSnapshot => Object.freeze({ version: 1, revision, preference, locale: resolveLocale(preference, options.systemLanguages()), persistence });
  function dispatch(event: LanguageIPCEvent, request: unknown): LanguageSnapshot {
    if (!isLanguageRequest(request) || !options.isTrusted(event)) throw new Error('Rejected app-language request.');
    if (request.action === 'read') {
      const current = snapshot();
      if (current.locale !== announcedLocale) {
        announcedLocale = current.locale; revision++;
        const next = snapshot(); options.onChanged?.(next); options.broadcast(APP_LANGUAGE_EVENT, next); return next;
      }
      return current;
    }
    preference = request.preference;
    try { storage.write(serializeLanguagePreference(preference)); persistence = 'saved'; }
    catch { persistence = 'session'; }
    revision++;
    const next = snapshot(); announcedLocale = next.locale; options.onChanged?.(next); options.broadcast(APP_LANGUAGE_EVENT, next); return next;
  }
  return Object.freeze({ snapshot, dispatch });
}
