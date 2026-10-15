import type {Locale} from '@mioon/i18n';
import {presentationLocale} from '@mioon/i18n/presentation';

// Pure parsing: callers own errors and locale state; no input reads or dispatch.
const valueOptions = new Set(['input', 'input-file', 'request-id', 'file', 'timeout-ms', 'interval-ms', 'output', 'max-bytes', 'workspace-origin', 'locale']);
const switches = new Set(['help', 'version', 'json']);
export function argumentsFor(argv: readonly string[], fail: (text: string, key: string, params?: Record<string, string>) => never, onLocale: (locale: Locale | undefined) => void) {
  const words: string[] = [], options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '-h') { options.help = true; continue; }
    if (!argument.startsWith('-')) { words.push(argument); continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(argument);
    if (!match) fail('Invalid option. Use --help for supported arguments.', 'cli.error.invalidOption');
    const [, name, inline] = match;
    if (Object.hasOwn(options, name)) fail(`Option --${name} can only be supplied once.`, 'cli.error.duplicateOption', {name});
    if (switches.has(name)) { if (inline !== undefined) fail(`Option --${name} does not take a value.`, 'cli.error.switchValue', {name}); options[name] = true; continue; }
    if (!valueOptions.has(name)) fail('Unsupported option. Use --help; credentials belong in private connection files, never command-line arguments.', 'cli.error.unsupportedOption');
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || (value.startsWith('--') && name !== 'input')) fail(`Option --${name} requires a value.`, 'cli.error.missingValue', {name});
    if (name === 'locale') {
      try { onLocale(presentationLocale(value)); }
      catch { fail('--locale must be one of zh-Hans, zh-Hant, en, ja.', 'cli.error.locale'); }
    }
    options[name] = value;
  }
  return {words, options};
}
