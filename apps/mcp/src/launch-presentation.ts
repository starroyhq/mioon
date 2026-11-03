import {presentationLocale} from '@mioon/i18n/presentation';
import type {Locale, MessageKey} from '@mioon/i18n';

/** Only explicit validated values establish presentation language, even on failure. */
export function localizedLaunchOptions(argv: readonly string[], fail: (text: string, key: MessageKey) => never, onLocale: (value: Locale | undefined) => void) {
  let locale: Locale | undefined;
  const supplied = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const match = /^--(locale)(?:=(.*))?$/s.exec(argv[index]);
    if (!match || supplied.has(match[1]))
      fail('MCP accepts only one optional --locale zh-Hans|zh-Hant|en|ja at process launch.', 'mcp.error.launchOptions');
    const [, name, inline] = match;
    supplied.add(name);
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined) fail('--locale requires an explicit value.', 'mcp.error.localeRequired');
    {
      try { locale = presentationLocale(value); }
      catch { fail('--locale must be one of zh-Hans, zh-Hant, en, ja.', 'mcp.error.locale'); }
      onLocale(locale);
    }
  }
  return Object.freeze({locale});
}
