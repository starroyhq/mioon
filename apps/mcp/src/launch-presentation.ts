import {presentationLocale} from '@mioon/i18n/presentation';
import type {Locale} from '@mioon/i18n';

/** Only explicit validated values establish presentation language, even on failure. */
export function localizedLaunchOptions<T>(argv: readonly string[], originOptions: (value: string | undefined) => T, fail: (text: string, key: string) => never, onLocale: (value: Locale | undefined) => void) {
  let origin: string | undefined, locale: Locale | undefined;
  const supplied = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const match = /^--(workspace-origin|locale)(?:=(.*))?$/s.exec(argv[index]);
    if (!match || supplied.has(match[1]))
      fail(locale === undefined ? 'MCP accepts only one optional --workspace-origin UUID at process launch.' : 'MCP accepts only one optional --workspace-origin UUID and --locale zh-Hans|zh-Hant|en|ja at process launch.', 'mcp.error.launchOptions');
    const [, name, inline] = match;
    supplied.add(name);
    const value = inline === undefined ? argv[++index] : inline;
    if (value === undefined) fail(name === 'workspace-origin' ? '--workspace-origin requires an explicit UUID.' : '--locale requires an explicit value.', name === 'workspace-origin' ? 'mcp.error.originRequired' : 'mcp.error.localeRequired');
    if (name === 'workspace-origin') origin = value;
    else {
      try { locale = presentationLocale(value); }
      catch { fail('--locale must be one of zh-Hans, zh-Hant, en, ja.', 'mcp.error.locale'); }
      onLocale(locale);
    }
  }
  // The supplied callback owns only the known workspace-origin validator.
  return Object.freeze({invocation: Object.freeze(originOptions(origin)), locale});
}
