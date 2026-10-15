import { APP_LANGUAGE_CHANNEL, APP_LANGUAGE_EVENT, isLanguageSnapshot } from '../../../packages/i18n/src/preference.ts';
import type { LanguageBridge, LanguageRequest, LanguageSnapshot } from '../../../packages/i18n/src/preference.ts';
import { isLanguagePreference } from '../../../packages/i18n/src/locale.ts';
interface Transport {
  invoke(channel: typeof APP_LANGUAGE_CHANNEL, request: LanguageRequest): Promise<unknown>;
  on(channel: typeof APP_LANGUAGE_EVENT, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof APP_LANGUAGE_EVENT, listener: (event: unknown, value: unknown) => void): void;
}
const checked = (value: unknown): LanguageSnapshot => {
  if (!isLanguageSnapshot(value)) throw new Error('Invalid app-language response.');
  return Object.freeze({ ...value });
};
/** Fixed presentation-only bridge; Electron events, paths and arbitrary channels never escape. */
export function createAppLanguageBridge(transport: Transport): LanguageBridge {
  return Object.freeze({
    read: async () => checked(await transport.invoke(APP_LANGUAGE_CHANNEL, { action: 'read' })),
    async set(preference) {
      if (!isLanguagePreference(preference)) throw new Error('Invalid app-language preference.');
      return checked(await transport.invoke(APP_LANGUAGE_CHANNEL, { action: 'set', preference }));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('Invalid app-language listener.');
      let active = true;
      const receive = (_event: unknown, value: unknown) => { if (active && isLanguageSnapshot(value)) listener(checked(value)); };
      transport.on(APP_LANGUAGE_EVENT, receive);
      return () => { if (active) { active = false; transport.removeListener(APP_LANGUAGE_EVENT, receive); } };
    },
  } satisfies LanguageBridge);
}
