import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import desktopIdentity from '../identity.cjs';
import desktopBuildMetadata from '../build-metadata.cjs';
const identity = desktopIdentity.identityForChannel(desktopIdentity.buildChannel(process.argv.slice(2)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { appVersion, desktopPackage: pkg } = desktopBuildMetadata.readBuildMetadata(root);
const desktop = path.join(root, 'apps/desktop');
const output = path.join(desktop, 'build');
const web = path.join(root, 'apps/web/dist');
await readFile(path.join(web, 'index.html')).catch(() => { throw new Error('Build the shared web UI first: pnpm build'); });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['main', 'backend']) {
  await build({ entryPoints: [path.join(desktop, `src/${name}.mjs`)], outfile: path.join(output, `${name}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
    define: { 'import.meta.url': '__mioon_import_meta_url', __MIOON_DESKTOP_CHANNEL__: JSON.stringify(identity.channel) },
    banner: { js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    sourcemap: false, legalComments: 'eof', logLevel: 'info' });
}
await cp(web, path.join(output, 'web'), { recursive: true, dereference: true });
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'mioon-desktop', version: appVersion,
  private: true, desktopName: `${identity.appId}.desktop`, mioonDesktop: identity, description: pkg.description, author: 'Mioon', main: 'main.cjs', dependencies: {} }, null, 2));
await mkdir(path.join(output, 'licenses'), { recursive: true });
const seen = new Set(), notices = ['# Third-party notices', '',
  'Packaged Electron and Chromium notices: LICENSE.electron.txt and LICENSES.chromium.html.',
  'On macOS they are in the application bundle at Contents/Resources/licenses; on Linux they are beside the executable.', ''];
async function collectLicenses(packageFile) {
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  const key = `${metadata.name}@${metadata.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const directory = path.dirname(packageFile), require = createRequire(packageFile);
  if (!metadata.name.startsWith('@mioon/')) {
    const files = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
    for (const file of files) await cp(path.join(directory, file), path.join(output, 'licenses', `${metadata.name.replaceAll('/', '-')}-${file}`));
    notices.push(`- ${key}: ${metadata.license || 'See bundled notices'}${files.length ? ` (${files.join(', ')})` : ''}`);
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
notices.push('- shadcn/ui checked-in components: MIT (shadcn-ui-LICENSE.md)');
await writeFile(path.join(output, 'licenses/THIRD-PARTY-NOTICES.md'), notices.join('\n') + '\n');
console.log(`Desktop identity: ${identity.appId} (${identity.channel})`);
console.log('Desktop staging contains bundled shared backend and the same built web UI; no node_modules or data directories.');
