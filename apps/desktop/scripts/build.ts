import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile, readdir, realpath, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import desktopIdentity from '../identity.ts';
import desktopBuildMetadata from '../build-metadata.ts';
import {main as checkTypes} from '../../../scripts/tooling.ts';
import {measureBuildStage, withDesktopTypecheckTiming, type BuildTimingStage} from '../../../scripts/lib/build-timings.ts';
import {hasOuterTypecheckEvidence} from '../../../scripts/lib/typecheck-evidence.ts';
import {prepareBuilderConfig} from './prepare-builder-config.ts';
import {buildMacCliLauncher} from './build-cli-launcher.ts';
import {localRequireBundlePlugin} from './bundle-local-require.ts';
import {stageTrayResources} from '../tray-resources.ts';
import {stageProjectNotices} from './stage-project-notices.ts';
import {verifySettingsWarmAssets} from './settings-warm-assets.ts';
import {stageProjectExampleResources, verifyProjectExampleResources} from '../../../packages/business/src/project-example-resources.ts';
import {verifySubtitleResources,SUBTITLE_RESOURCE_FILES} from '../subtitle-resources.ts';
const identity = desktopIdentity.identityForChannel(desktopIdentity.buildChannel(process.argv.slice(2)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { appVersion, desktopPackage: pkg } = desktopBuildMetadata.readBuildMetadata(root);
// Direct desktop/package entries check real TS before replacing staging. The
// full local build runs that same check first and passes private evidence only
// while the sources are unchanged, so the normal build checks exactly once.
if (await hasOuterTypecheckEvidence(root)) console.log('Desktop staging reuses the outer build typecheck for unchanged sources.');
else await withDesktopTypecheckTiming(async () => {
  if (await checkTypes(['typecheck']) !== 0) throw new Error('Type checking failed; desktop staging was not replaced.');
});
// Keep the ignored electron-builder CJS entrypoints derived from typed source.
await measureBuildStage('desktop-builder-config', () => prepareBuilderConfig());
const desktop = path.join(root, 'apps/desktop');
const output = path.join(desktop, 'build');
const web = path.join(root, 'apps/web/dist');
const examples = path.join(web, 'project-examples');
await measureBuildStage('desktop-web-validation', async () => {
  await Promise.all(['index.html', 'settings.html'].map(file => readFile(path.join(web, file)))).catch(() => {
    throw new Error('Build the shared web UI first: pnpm build');
  });
  await verifySettingsWarmAssets(file => readFile(path.join(web, file), 'utf8'));
  verifyProjectExampleResources(examples);
});
await measureBuildStage('desktop-staging-reset', async () => {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
});
const desktopModuleManifests = new Set<string>();
for (const name of ['main', 'backend', 'project-catalog']) {
  // The audit test pins this loop line; the cast only narrows the fixed names above to timing stages.
  const result = await measureBuildStage(`desktop-${name}-bundle` as BuildTimingStage, () => build({ entryPoints: [path.join(desktop, `src/${name}.ts`)], outfile: path.join(output, `${name}.cjs`),
    absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'original-fs'], metafile: name === 'main',
    plugins:[localRequireBundlePlugin(root)],
    define: { 'import.meta.url': '__mioon_import_meta_url', __MIOON_DESKTOP_CHANNEL__: JSON.stringify(identity.channel) },
    banner: { js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    sourcemap: false, legalComments: 'eof', logLevel: 'info' }));
  if (name === 'main') {
    const emitted = Object.values(result.metafile!.outputs).flatMap(bundle => Object.entries(bundle.inputs)
      .filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file));
    if (!emitted.some(file => /(?:^|\/)node_modules\/electron-updater\/out\/main\.js$/u.test(file))) {
      throw new Error('The desktop main bundle does not include electron-updater.');
    }
    // Include installed optional peer dependencies when the bundler emitted
    // them (for example debug's supports-color), as well as declared packages.
    for (const file of emitted) {
      const parts = file.split('/');
      const index = parts.lastIndexOf('node_modules');
      if (index < 0) continue;
      const length = parts[index + 1]?.startsWith('@') ? 2 : 1;
      desktopModuleManifests.add(path.resolve(root, ...parts.slice(0, index + 1 + length), 'package.json'));
    }
  }
}
await measureBuildStage('desktop-cli-runtime-bundles', () => build({
  entryPoints: ['cli-runtime', 'mcp-runtime'].map(name => path.join(desktop, `src/${name}.ts`)),
  outdir: output, outExtension: {'.js': '.cjs'}, absWorkingDir: root,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'original-fs'],
  plugins: [localRequireBundlePlugin(root)],
  define: {'import.meta.url': '__mioon_import_meta_url'},
  banner: {js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'},
  sourcemap: false, legalComments: 'eof', logLevel: 'info',
}));
// A sandboxed preload has only Electron's fixed bridge API, never Node imports.
await measureBuildStage('desktop-preload-bundle', () => build({ entryPoints: [path.join(desktop, 'src/preload.ts')], outfile: path.join(output, 'preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
  sourcemap: false, legalComments: 'eof', logLevel: 'info' }));
await measureBuildStage('desktop-resource-staging', async () => {
await cp(web, path.join(output, 'web'), { recursive: true, dereference: true,
  filter: source => source !== examples });
await stageProjectExampleResources(examples, path.join(output, 'examples'));
await mkdir(path.join(output, 'icons'));
await cp(path.join(desktop, 'resources/icon.png'), path.join(output, 'icons/icon.png'));
await stageTrayResources(path.join(desktop, 'resources/tray'), path.join(output, 'icons/tray'));
const subtitleSource=path.join(root,'packages/business/resources/subtitles');
await verifySubtitleResources(subtitleSource);
await mkdir(path.join(output,'subtitles'));
for(const file of SUBTITLE_RESOURCE_FILES)await cp(path.join(subtitleSource,file),path.join(output,'subtitles',file));
await verifySubtitleResources(path.join(output,'subtitles'));
});
if (process.platform === 'darwin') {
  await measureBuildStage('desktop-native-staging', () => buildMacCliLauncher({desktop, output, appVersion, identity}));
}
// Windows desktop storage opens only through the ACL helper staged beside the
// bundles (outside ASAR when packaged); it is built separately, never here.
if(process.platform==='win32'){
  await measureBuildStage('desktop-native-staging', async () => {
  const helper=path.join(root,'packages/node-host/build/Release/mioon_private_storage.node');
  await access(helper).catch(()=>{throw new Error('Build the Windows private storage helper first: pnpm --filter @mioon/node-host build:native');});
  await mkdir(path.join(output,'native'));
  await cp(helper,path.join(output,'native','mioon_private_storage.node'));
  });
}
await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'mioon-desktop', version: appVersion,
  private: true, license: pkg.license, desktopName: `${identity.appId}.desktop`, mioonDesktop: identity, description: pkg.description, author: 'Mioon', main: 'main.cjs', dependencies: {} }, null, 2));
await measureBuildStage('desktop-license-staging', async () => {
await mkdir(path.join(output, 'licenses'), { recursive: true });
await stageProjectNotices(root, path.join(output, 'licenses'));
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
    try {
      const exported = require.resolve(`${name}/package.json`);
      // The MCP SDK exports its CJS partition's package.json, containing
      // only the module type. Licenses belong to the actual package root.
      const declared = JSON.parse(await readFile(exported, 'utf8'));
      if (typeof declared.name === 'string' && typeof declared.version === 'string') dependency = exported;
    } catch {}
    if (!dependency) {
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
await collectLicenses(path.join(root, 'apps/cli/package.json'));
await collectLicenses(path.join(root, 'apps/mcp/package.json'));
await collectLicenses(path.join(desktop, 'package.json'));
for (const manifest of desktopModuleManifests) await collectLicenses(manifest);
await cp(path.join(root, 'packages/ui/src/LICENSE.shadcn.md'), path.join(output, 'licenses/shadcn-ui-LICENSE.md'));
notices.push('- Noto Sans CJK SC 2.004, extracted face: SIL OFL 1.1 (external subtitles/OFL-1.1.txt, SOURCE-COPYRIGHT.txt and README.md).');
notices.push('- shadcn/ui checked-in components: MIT (shadcn-ui-LICENSE.md)');
await writeFile(path.join(output, 'licenses/THIRD-PARTY-NOTICES.md'), notices.join('\n') + '\n');
});
console.log(`Desktop identity: ${identity.appId} (${identity.channel})`);
console.log('Desktop staging contains the shared backend, CLI and MCP runtimes, and the built web UI.');
