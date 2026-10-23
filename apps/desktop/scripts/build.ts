import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import desktopIdentity from '../identity.ts';
import desktopBuildMetadata from '../build-metadata.ts';
import {main as checkTypes} from '../../../scripts/tooling.ts';
import {prepareBuilderConfig} from './prepare-builder-config.ts';
import {localRequireBundlePlugin} from './bundle-local-require.ts';
const identity = desktopIdentity.identityForChannel(desktopIdentity.buildChannel(process.argv.slice(2)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { appVersion, desktopPackage: pkg } = desktopBuildMetadata.readBuildMetadata(root);
// Every direct desktop/package entry checks real TS before replacing staging.
if (await checkTypes(['typecheck']) !== 0) throw new Error('Type checking failed; desktop staging was not replaced.');
// Keep the ignored electron-builder CJS entrypoints derived from typed source.
await prepareBuilderConfig();
const desktop = path.join(root, 'apps/desktop');
const output = path.join(desktop, 'build');
const web = path.join(root, 'apps/web/dist');
await readFile(path.join(web, 'index.html')).catch(() => { throw new Error('Build the shared web UI first: pnpm build'); });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['main', 'backend']) {
  await build({ entryPoints: [path.join(desktop, `src/${name}.ts`)], outfile: path.join(output, `${name}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
    plugins:[localRequireBundlePlugin(root)],
    define: { 'import.meta.url': '__mioon_import_meta_url', __MIOON_DESKTOP_CHANNEL__: JSON.stringify(identity.channel) },
    banner: { js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    sourcemap: false, legalComments: 'eof', logLevel: 'info' });
}
// A sandboxed preload has only Electron's fixed bridge API, never Node imports.
await build({ entryPoints: [path.join(desktop, 'src/preload.ts')], outfile: path.join(output, 'preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
  sourcemap: false, legalComments: 'eof', logLevel: 'info' });
await cp(web, path.join(output, 'web'), { recursive: true, dereference: true });
await mkdir(path.join(output, 'icons'));
await cp(path.join(desktop, 'resources/icon.png'), path.join(output, 'icons/icon.png'));
const subtitleSource=path.join(root,'packages/business/resources/subtitles');
import {verifySubtitleResources,SUBTITLE_RESOURCE_FILES} from '../subtitle-resources.ts';
await verifySubtitleResources(subtitleSource);
await mkdir(path.join(output,'subtitles'));
for(const file of SUBTITLE_RESOURCE_FILES)await cp(path.join(subtitleSource,file),path.join(output,'subtitles',file));
await verifySubtitleResources(path.join(output,'subtitles'));
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'mioon-desktop', version: appVersion,
  private: true, desktopName: `${identity.appId}.desktop`, mioonDesktop: identity, description: pkg.description, author: 'Mioon', main: 'main.cjs', dependencies: {} }, null, 2));
await mkdir(path.join(output, 'licenses'), { recursive: true });
const seen = new Set(), notices = ['# Third-party notices', '',
  'Packaged Electron and Chromium notices: LICENSE.electron.txt and LICENSES.chromium.html.',
  'On macOS they are in the application bundle at Contents/Resources/licenses; on Linux they are beside the executable.', ''];
async function collectLicenses(packageFile: string): Promise<void> {
  // Export-restricted packages use the fallback path below. Resolve its pnpm
  // symlink before walking dependencies, whose modules are beside the real file.
  const manifest = await realpath(packageFile);
  const metadata = JSON.parse(await readFile(manifest, 'utf8'));
  const key = `${metadata.name}@${metadata.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const directory = path.dirname(manifest), require = createRequire(manifest);
  if (!metadata.name.startsWith('@mioon/')) {
    const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
    for (const file of files) await cp(path.join(directory, file), path.join(output, 'licenses', `${metadata.name.replaceAll('/', '-')}-${file}`));
    if (metadata.name === 'mmx-cli' && metadata.version === '1.0.28' && !metadata.license && !files.length) {
      // This published SDK declares MIT in README but omits LICENSE and the
      // manifest field. Preserve that evidence without inventing license text.
      const readme = await readFile(path.join(directory, 'README.md'), 'utf8');
      if (!/^## License\s+\[MIT\]\(LICENSE\)\s*$/m.test(readme)) throw new Error('mmx-cli upstream license declaration changed');
      const notice = 'mmx-cli-LICENSE-DECLARATION.md';
      await writeFile(path.join(output, 'licenses', notice), `# ${key} upstream license declaration\n\nSource: https://registry.npmjs.org/mmx-cli/1.0.28 (published README.md)\nRepository: https://github.com/MiniMax-AI/cli\n\nREADME declaration: [MIT](LICENSE).\nThe published package omits the LICENSE text and package.json license field. No full license text was supplied by the publisher.\n`);
      notices.push(`- ${key}: MIT (upstream README declaration; full license text omitted by publisher; ${notice})`);
    } else notices.push(`- ${key}: ${metadata.license || 'See bundled notices'}${files.length ? ` (${files.join(', ')})` : ''}`);
  }
  for (const name of Object.keys(metadata.dependencies || {})) {
    let dependency;
    try { dependency = require.resolve(`${name}/package.json`); }
    catch {
      for (const directory of require.resolve.paths(name) || []) {
        const candidate = path.join(directory, name, 'package.json');
        try { const data = JSON.parse(await readFile(candidate, 'utf8'));
          if (data.name === name) { dependency = candidate; break; } }
        catch {}
      }
    }
    if (!dependency) throw new Error(`Cannot collect license metadata for ${name}`);
    await collectLicenses(dependency);
  }
}
await collectLicenses(path.join(root, 'apps/web/package.json'));
await collectLicenses(path.join(root, 'apps/server/package.json'));
await cp(path.join(root, 'packages/ui/src/LICENSE.shadcn.md'), path.join(output, 'licenses/shadcn-ui-LICENSE.md'));
notices.push('- Noto Sans CJK SC 2.004, extracted face: SIL OFL 1.1 (external subtitles/OFL-1.1.txt, SOURCE-COPYRIGHT.txt and README.md).');
notices.push('- shadcn/ui checked-in components: MIT (shadcn-ui-LICENSE.md)');
await writeFile(path.join(output, 'licenses/THIRD-PARTY-NOTICES.md'), notices.join('\n') + '\n');
console.log(`Desktop identity: ${identity.appId} (${identity.channel})`);
console.log('Desktop staging contains bundled shared backend and the same built web UI; no node_modules or data directories.');
