import { build } from 'esbuild';
import { isWarmSettingsScriptPath } from '../src/settings-warm-assets.ts';

type ReadAsset = (file: string) => string | Promise<string>;

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const name = match[1].toLowerCase();
    if (result.has(name)) throw new Error('Duplicate attribute in settings.html');
    result.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function initialScripts(html: string): string[] {
  const scripts = new Set<string>();
  let entryCount = 0;
  // Vite emits quoted attributes. Tokenize comments and raw-text elements so
  // their contents cannot be mistaken for resource declarations.
  const tags = /<!--[\s\S]*?-->|<(script|style)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>([\s\S]*?)<\/\1\s*>|<([a-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>/giu;
  for (const [, rawName, rawAttributes, rawText, tagName, tagAttributes] of html.matchAll(tags)) {
    const name = (rawName ?? tagName)?.toLowerCase();
    if (!name) continue;
    const attr = attributes(rawAttributes ?? tagAttributes);
    if (name === 'script' || name === 'link') {
      const isEntry = name === 'script';
      const url = attr.get(isEntry ? 'src' : 'href') ?? '';
      if (!isWarmSettingsScriptPath(url) || (isEntry
        ? attr.get('type')?.toLowerCase() !== 'module' || rawText?.trim() !== '' || url.startsWith('/assets/settings-boot-close-')
        : attr.get('rel')?.toLowerCase() !== 'modulepreload')) {
        throw new Error(`Unexpected ${name} resource in settings.html`);
      }
      if (isEntry) entryCount++;
      scripts.add(url);
    } else if (['base', 'embed', 'iframe', 'object'].includes(name) || attr.has('http-equiv') ||
      ['src', 'srcset', 'poster'].some(key => attr.has(key)) ||
      /@import\b|url\s*\(/iu.test(rawText ?? attr.get('style') ?? '')) {
      throw new Error(`Unexpected ${name} resource in settings.html`);
    }
  }
  if (entryCount !== 1) throw new Error('settings.html must have one settings module entry');
  return [...scripts];
}

/** Check the resources requested before the settings renderer is promoted. */
export async function verifySettingsWarmAssets(readAsset: ReadAsset): Promise<void> {
  const read = async (file: string): Promise<string> => {
    try { return await readAsset(file); }
    catch { throw new Error(`Missing settings warm asset: ${file}`); }
  };
  const scripts = initialScripts(await read('settings.html'));
  await build({
    entryPoints: scripts, outdir: 'settings-warm-assets', bundle: true, write: false, format: 'esm', logLevel: 'silent',
    plugins: [{name: 'settings-warm-assets', setup(builder) {
      builder.onResolve({filter: /.*/}, args => {
        // The boot module defers these until it receives the active context.
        if (args.kind === 'dynamic-import') return {path: args.path, external: true};
        const pathname = args.path.startsWith('./') ? `/assets/${args.path.slice(2)}` : args.path;
        if ((args.kind !== 'entry-point' && args.kind !== 'import-statement') || !isWarmSettingsScriptPath(pathname)) {
          return {errors: [{text: `Unexpected static dependency in settings warm asset: ${args.importer}`}]};
        }
        return {path: pathname, namespace: 'settings-warm-assets'};
      });
      builder.onLoad({filter: /.*/, namespace: 'settings-warm-assets'}, async args => ({
        contents: await read(args.path.slice(1)), loader: 'js',
      }));
    }}],
  });
}
