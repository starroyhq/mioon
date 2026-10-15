import { isLocale } from './locale.ts';
import { translate, renderMessage, catalogs } from './index.ts';
import type { Locale } from './types.ts';

/** Launch-only presentation preference. No OS/env inference, persistence or RPC input. */
export function presentationLocale(value: unknown): Locale | undefined {
  if (value === undefined) return undefined;
  if (!isLocale(value)) throw new TypeError('--locale must be one of zh-Hans, zh-Hant, en, ja.');
  return value;
}

function text(locale: Locale, key: string): string {
  if (!Object.hasOwn(catalogs, key)) throw new TypeError('Unknown presentation message key.');
  return renderMessage(locale, {key});
}

/** Do not translate schemas/results or mutate discovery definitions. */
export function localizeHelp<T extends { options: Record<string, string>; connection: string[]; safety: string }>(help: T, locale?: Locale): T {
  if (locale === undefined) return help;
  const options = Object.fromEntries(Object.keys(help.options).map(option => [option, text(locale, `cli.option.${option.slice(2)}`)]));
  options['--locale'] = translate(locale, 'cli.option.locale');
  return { ...help, options, connection: ['desktop', 'web', 'token'].map(key => text(locale, `cli.connection.${key}`)), safety: translate(locale, 'cli.safety') };
}

export function localizeToolDescription(operation: string, original: string, locale?: Locale): string {
  return locale === undefined ? original : text(locale, `operation.${operation}`);
}
