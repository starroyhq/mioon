import {presentationLocale} from '@mioon/i18n/presentation';
import {renderMessage} from '@mioon/i18n';
import type {Locale} from '@mioon/i18n';

/** Locale events are visited by the existing parser, which alone owns command
 * validation and error precedence. This helper never validates business inputs. */
export function backupPresentationArguments(argv: readonly string[], fail: () => never, onLocale: (value: Locale | undefined) => void) {
  const argumentsWithoutLocale: string[] = [];
  const events: {index: number; value: string | undefined}[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--locale' || argument.startsWith('--locale=')) {
      events.push({index: argumentsWithoutLocale.length, value: argument === '--locale' ? argv[++index] : argument.slice('--locale='.length)});
    } else argumentsWithoutLocale.push(argument);
  }
  let nextEvent = 0;
  return {
    argv: argumentsWithoutLocale,
    visit(index: number, allowLocale = true) {
      while (nextEvent < events.length && events[nextEvent].index <= index) {
        // A locale flag cannot replace the value of a business option.
        if (!allowLocale) fail();
        const event = events[nextEvent++];
        if (nextEvent > 1 || event.value === undefined) fail();
        let locale: Locale | undefined;
        try { locale = presentationLocale(event.value); } catch { fail(); }
        onLocale(locale);
      }
    },
  };
}

export function localizeBackupHelp<T extends {requirements: string[]; privacy: string[]; safety: string[]; output: string}>(help: T, locale?: Locale): T {
  if (locale === undefined) return help;
  const sections = Object.fromEntries((['requirements', 'privacy', 'safety'] as const).map(section => [section, help[section].map((_, index) => renderMessage(locale, {key: `backup.${section}.${index}`}))]));
  return {...help, ...sections, output: renderMessage(locale, {key: 'backup.output'})};
}

/** Code comes from the command's fixed safeError allowlist, never raw errors. */
export function backupDiagnostic(code: string, legacyMessage: string, locale?: Locale): string {
  return locale === undefined ? legacyMessage : renderMessage(locale, {key: `backup.error.${code}`});
}
