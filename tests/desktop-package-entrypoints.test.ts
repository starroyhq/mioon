import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath , pathToFileURL} from 'node:url';
import { parseArguments, buildCommands } from '../scripts/lib/local-tooling.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import { verifySettingsWarmAssets } from '../apps/desktop/scripts/settings-warm-assets.ts';
import {verifyWindowsPrivateStorageHelper} from '../apps/desktop/builder-config.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'apps/desktop');
const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const channels = [
  { script: 'package:linux:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux'] },
  { script: 'package:dir:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux', '--dir'] },
  { script: 'package:mac:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--mac'] },
  { script: 'package:win:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--win'] },
];

// Inspect only the simple, two-command manifest contract. Do not evaluate a
// shell, resolve installed tools, invoke the CLI, or execute these command plans.
type ChannelExpectation = typeof channels[number];
function packagingPlan(script: string, expected: ChannelExpectation) {
  const steps = script.split('&&').map(step => step.trim().split(/\s+/));
  const windows = expected.script === 'package:win:dev';
  assert.equal(steps.length, windows ? 3 : 2, 'Build must succeed before electron-builder; no extra stages');
  if (windows) assert.deepEqual(steps.shift(), ['pnpm', '--filter', '@mioon/node-host', 'build:native'], 'Windows packaging must build its native ACL helper first');
  for (const argv of steps) for (const token of argv) assert.match(token, /^[A-Za-z0-9_./=-]+$/, 'Only literal arguments are permitted');
  const [build, builder] = steps;
  assert.equal(build[0], 'node', 'Run the shared build before electron-builder');
  assert.equal(realpathSync(path.resolve(desktop, build[1])), realpathSync(path.join(root, 'scripts/tooling.ts')), 'Use the shared Web→desktop entrypoint from the desktop workspace');
  assert.equal(build.length, 4, 'Build requires only the tooling path, build command and explicit channel');
  const options = parseArguments(build.slice(2));
  assert.equal(options.command, 'build');
  assert.equal(options.channel, expected.channel, 'Build must select the expected channel');
  assert.equal(build[3], `--channel=${expected.channel}`, 'Local packaging must select development explicitly');
  assert.deepEqual(builder, ['electron-builder', '--config', expected.config, ...expected.targetArgs, '--publish', 'never'], 'Builder must retain the exact config, target and publication arguments');
  const config = require(path.resolve(desktop, 'builder-config.ts')).builderConfig(expected.channel);
  // Synthetic Vite path: buildCommands only constructs argv and never reads it.
  const viteEntry = path.join(root, 'node_modules/vite/bin/vite.js');
  const commands = buildCommands(root, { vite: { entry: viteEntry } } as unknown as Parameters<typeof buildCommands>[1], options.channel);
  return { commands, config, viteEntry };
}
const nativePrefix = (expected: ChannelExpectation): string => expected.script === 'package:win:dev' ? 'pnpm --filter @mioon/node-host build:native && ' : '';

for (const expected of channels) {
  test(`${expected.script} resolves the real tooling contract and plans Web before same-channel desktop staging`, () => {
    const { commands, config, viteEntry } = packagingPlan(manifest.scripts[expected.script] as string, expected);
    assert.deepEqual(commands, [
      { command: process.execPath, args: ['--max-old-space-size=1024', `--import=${pathToFileURL(path.join(root, 'scripts/lib/build-heap-probe.ts')).href}`, viteEntry, 'build'], cwd: path.join(root, 'apps/web') },
      { command: process.execPath, args: [path.join(desktop, 'scripts/build.ts'), `--channel=${expected.channel}`], cwd: root },
    ]);
    assert.equal(realpathSync(commands[1].args[0]), realpathSync(path.join(desktop, 'scripts/build.ts')));
    const channel = desktopIdentity.buildChannel(commands[1].args.slice(1));
    assert.equal(channel, expected.channel);
    const identity = desktopIdentity.identityForChannel(channel);
    assert.equal(config.appId, identity.appId);
    assert.equal(config.appId, expected.appId);
    assert.equal(config.productName, identity.productName);
    assert.equal(config.executableName, identity.executableName);
    assert.equal(path.resolve(desktop, config.directories.app), path.join(desktop, 'build'));
    assert.equal(path.resolve(desktop, config.directories.output), path.join(root, 'release/desktop', channel));
    assert.equal(config.publish, null);
    assert.deepEqual(config.linux.target, [{ target: 'tar.gz', arch: ['x64'] }]);
    assert.equal(config.linux.desktop.entry.StartupWMClass, expected.appId);
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.linux.artifactName, `${identity.executableName}-\${version}-\${os}-\${arch}.\${ext}`);
    assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }]);
    assert.deepEqual(config.mac.extraFiles, [{from: 'build/cli-launcher', to: 'Helpers', filter: [identity.executableName]}]);
    assert.ok(!config.files.some((file: string) => file.includes('cli-launcher')), 'Keep the native launcher out of ASAR');
    assert.equal(config.mac.artifactName, `${identity.executableName}-\${version}-mac.\${ext}`);
    assert.equal(config.mac.detectUpdateChannel, false);
    assert.equal(config.dmg.writeUpdateInfo, false);
    assert.equal(config.mac.identity, null, 'This change must not enable signing');
    assert.deepEqual(config.win, {
      target: [{target: 'portable', arch: ['x64']}], signExecutable: false, requestedExecutionLevel: 'asInvoker',
      extraResources: [{from: 'build/native', to: 'native', filter: ['mioon_private_storage.node']}],
      artifactName: `${identity.executableName}-\${version}-win-\${arch}.\${ext}`,
    });
  });
}

test('entrypoint checks reject the old staging-only path and channel or publication regressions', () => {
  for (const expected of channels) {
    // Start mutations from the required contract so an existing legacy script
    // cannot make an unrelated negative assertion pass for the wrong reason.
    const builder = `electron-builder --config ${expected.config} ${expected.targetArgs.join(' ')} --publish never`;
    const script = `${nativePrefix(expected)}node ../../scripts/tooling.ts build --channel=${expected.channel} && ${builder}`;
    const old = `${nativePrefix(expected)}node scripts/build.ts --channel=${expected.channel} && ${builder}`;
    assert.throws(() => packagingPlan(old, expected), /shared Web→desktop entrypoint/);
    assert.throws(() => packagingPlan(script.replace('&&', ';'), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('&&', ''), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('--publish never', '--publish always'), expected), /Builder must retain the exact config, target and publication arguments/);
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, ''), expected), /Build requires only the tooling path, build command and explicit channel/);
    assert.throws(() => packagingPlan(script.replace('--channel=development', '--channel=production'), expected), /Build must select the expected channel/);
    assert.throws(() => packagingPlan(script.replace(expected.config, '.generated/electron-builder.cjs'), expected), /Builder must retain the exact config, target and publication arguments/);
  }
});

test('entrypoint checks reject missing, reversed or extra stages and misrouted builder arguments', () => {
  for (const expected of channels) {
    const build = `node ../../scripts/tooling.ts build --channel=${expected.channel}`;
    const prefix = nativePrefix(expected);
    const builder = `electron-builder --config ${expected.config} ${expected.targetArgs.join(' ')} --publish never`;
    const script = `${prefix}${build} && ${builder}`;
    for (const missing of [build, builder]) {
      assert.throws(() => packagingPlan(missing, expected), /Build must succeed before electron-builder; no extra stages/, `${expected.script}: missing command`);
    }
    assert.throws(() => packagingPlan(`${prefix}${builder} && ${build}`, expected), /Run the shared build before electron-builder/, `${expected.script}: reversed commands`);
    assert.throws(() => packagingPlan(`${prefix}${build} && ${build} && ${builder}`, expected), /Build must succeed before electron-builder; no extra stages/, `${expected.script}: extra stage`);
    assert.throws(() => packagingPlan(`${prefix}${build} --extra && ${builder}`, expected), /Build requires only the tooling path, build command and explicit channel/, `${expected.script}: extra build argument`);
    for (const wrongTarget of ['--linux', '--mac', '--win'].filter(target => target !== expected.targetArgs[0])) {
      assert.throws(() => packagingPlan(script.replace(expected.targetArgs[0], wrongTarget), expected), /Builder must retain the exact config, target and publication arguments/, `${expected.script}: wrong target ${wrongTarget}`);
    }
    assert.throws(() => packagingPlan(script.replace(expected.targetArgs[0], ''), expected), /Builder must retain the exact config, target and publication arguments/, `${expected.script}: missing target`);
    if (expected.targetArgs.includes('--dir')) {
      assert.throws(() => packagingPlan(script.replace(' --dir', ''), expected), /Builder must retain the exact config, target and publication arguments/, `${expected.script}: missing --dir`);
    }
    assert.throws(() => packagingPlan(script.replace('--publish', '--dir --publish'), expected), /Builder must retain the exact config, target and publication arguments/, `${expected.script}: extra --dir`);
    assert.throws(() => packagingPlan(`${script} --x64`, expected), /Builder must retain the exact config, target and publication arguments/, `${expected.script}: extra builder argument`);
  }
});

test('Windows packages refuse production, missing helpers, malformed PE files and mismatched architectures', async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-win-package-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const {builderConfig} = require(path.join(desktop, 'builder-config.ts'));
  assert.equal(builderConfig('production').win, undefined);
  await assert.rejects(builderConfig('production').beforePack({electronPlatformName: 'win32', arch: 1,
    packager: {info: {appDir: directory}}}), /only for development/);
  await assert.rejects(verifyWindowsPrivateStorageHelper(directory, 3), /requires x64/);
  await assert.rejects(verifyWindowsPrivateStorageHelper(directory, 1), /Build the Windows x64 private storage helper/);
  await mkdir(path.join(directory, 'native'));
  const file = path.join(directory, 'native/mioon_private_storage.node');
  await writeFile(file, 'not a PE file');
  await assert.rejects(verifyWindowsPrivateStorageHelper(directory, 1), /invalid executable header/);
  const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x00004550, 128);
  bytes.writeUInt16LE(0xaa64, 132);
  await writeFile(file, bytes);
  await assert.rejects(verifyWindowsPrivateStorageHelper(directory, 1), /architecture must match/);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({name: 'mioon-desktop', version: rootManifest.version,
    main: 'main.cjs', private: true, desktopName: 'app.starroy.mioon.dev.desktop', dependencies: {},
    mioonDesktop: desktopIdentity.identityForChannel('development')}));
  await assert.rejects(builderConfig('development').beforePack({electronPlatformName: 'win32', arch: 1,
    packager: {info: {appDir: directory}}}), /architecture must match/);
  bytes.writeUInt16LE(0x8664, 132); await writeFile(file, bytes);
  await verifyWindowsPrivateStorageHelper(directory, 1);
  bytes.writeUInt32LE(0x7fffffff, 60); await writeFile(file, bytes);
  await assert.rejects(verifyWindowsPrivateStorageHelper(directory, 1), /invalid executable header/);
});

test('the pinned Windows signer skips signing through the explicit development configuration', async () => {
  const builder = createRequire(require.resolve('electron-builder'));
  const libraries = createRequire(builder.resolve('app-builder-lib'));
  const {Arch} = libraries('builder-util') as {Arch: {x64: number}};
  assert.equal(Arch.x64, 1);
  type Signer = {platformSpecificBuildOptions: unknown; shouldSignFile(file: string, fallback: boolean): boolean};
  const {WinPackager} = builder('app-builder-lib') as {WinPackager: {prototype: {signIf(this: Signer, file: string): Promise<boolean>}}};
  const configuration = require(path.join(desktop, 'builder-config.ts')).builderConfig('development').win;
  const disabled: Signer = {platformSpecificBuildOptions: configuration, shouldSignFile: () => true};
  // A signing attempt would need the deliberately absent signing queue/manager.
  assert.equal(await WinPackager.prototype.signIf.call(disabled, 'fixture.exe'), false);
  assert.equal(configuration.signAndEditExecutable, undefined, 'PE metadata and icon editing remain enabled');
});

test('default desktop package aliases select development and leave production staging to the release workflow', () => {
  const otherScripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => !channels.some(item => item.script === name)));
  assert.deepEqual(otherScripts, {
    build: 'node scripts/build.ts',
    'prepare:builder-config': 'node scripts/prepare-builder-config.ts',
    start: 'electron build',
    smoke: 'node scripts/smoke.ts',
    'package:linux': 'pnpm run package:linux:dev',
    'package:dir': 'pnpm run package:dir:dev',
    'package:mac': 'pnpm run package:mac:dev',
  });
  assert.equal(rootManifest.scripts['desktop:build:production'], undefined);
  const release = readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');
  assert.match(release, /run: node scripts\/tooling\.ts build --channel=production/);
  assert.match(release, /pnpm exec electron-builder --config \.generated\/electron-builder\.cjs --linux/);
  assert.match(release, /pnpm exec electron-builder --config \.generated\/electron-builder\.cjs --mac/);
});

test('root Linux package aliases forward directly to the checked workspace scripts', () => {
  assert.equal(rootManifest.scripts['desktop:package:linux'], 'pnpm --filter @mioon/desktop package:linux:dev');
  assert.equal(rootManifest.scripts['desktop:package:linux:dev'], 'pnpm --filter @mioon/desktop package:linux:dev');
});

test('source smoke validates development staging before creating a profile or starting Electron', async () => {
  const source = readFileSync(path.join(desktop, 'scripts/smoke.ts'), 'utf8');
  const start = source.indexOf('const staging ='), end = source.indexOf('const directory =');
  assert.ok(start >= 0 && end > start && source.indexOf('const child = spawn(') > end);
  const check = (metadata: unknown): Promise<string> =>
    Function('path', 'desktop', 'readFile', 'identityForChannel',
      `return (async () => { ${source.slice(start, end)} return staging; })();`)(
      path, desktop, async () => JSON.stringify(metadata), desktopIdentity.identityForChannel);
  const development = desktopIdentity.identityForChannel('development');
  const production = desktopIdentity.identityForChannel('production');
  assert.equal(await check({mioonDesktop: development}), path.join(desktop, 'build'));
  await assert.rejects(check({mioonDesktop: production}), /requires build --channel=development/);
  await assert.rejects(check({mioonDesktop: {...development, appId: production.appId}}), /requires build --channel=development/);
});

const settingsEntry = 'assets/settings-aBc12_De.js';
const settingsHelper = 'assets/settings-boot-close-Xyz34_Fg.js';
const settingsHtml = `<style>body { background: #fff; }</style>
<script type="module" crossorigin src="/${settingsEntry}"></script>`;
const settingsPreload = `<link rel="modulepreload" crossorigin href="/${settingsHelper}">`;
const settingsAssets = {
  'settings.html': settingsHtml,
  [settingsEntry]: `import './${path.posix.basename(settingsHelper)}'; export * from '/${settingsHelper}';
    export const activate = () => import('./main-Qwe56_Rt.js');`,
  [settingsHelper]: 'export const ready = true;',
};

const readSettingsAssets = (files: Record<string, string>) => (file: string): string => {
  if (!Object.hasOwn(files, file)) throw new Error('Fixture asset unavailable');
  return files[file];
};

test('settings package guard follows the warm module graph and leaves deferred application imports alone', async () => {
  const read = readSettingsAssets(settingsAssets), accessed: string[] = [];
  await verifySettingsWarmAssets(file => { accessed.push(file); return read(file); });
  assert.deepEqual(accessed.sort(), ['settings.html', settingsEntry, settingsHelper].sort());
  await verifySettingsWarmAssets(readSettingsAssets({...settingsAssets, 'settings.html': `${settingsHtml}\n${settingsPreload}`}));
});

test('settings package guard rejects resources the warm renderer would be denied', async () => {
  for (const [element, message] of [
    ['<link rel="stylesheet" href="/assets/main-Qwe56_Rt.css">', /Unexpected link resource/],
    ['<link rel="preload" as="script" href="/assets/main-Qwe56_Rt.js">', /Unexpected link resource/],
    ['<link rel="modulepreload" href="/assets/main-Qwe56_Rt.js">', /Unexpected link resource/],
    ['<link rel="modulepreload" href="/assets/settings-boot-close-Xyz34_Fg.js?debug=1">', /Unexpected link resource/],
    ['<script type="module">import "/assets/settings-aBc12_De.js";</script>', /Unexpected script resource/],
    ['<script type="module" src="https://example.com/assets/settings-aBc12_De.js"></script>', /Unexpected script resource/],
    ['<style>@import "/assets/main-Qwe56_Rt.css";</style>', /Unexpected style resource/],
  ] as const) {
    await assert.rejects(verifySettingsWarmAssets(readSettingsAssets({...settingsAssets, 'settings.html': `${settingsHtml}\n${element}`})), message);
  }
  for (const dependency of ['./main-Qwe56_Rt.js', './main-Qwe56_Rt.css', './settings-boot-close-short.js']) {
    await assert.rejects(verifySettingsWarmAssets(readSettingsAssets({...settingsAssets, [settingsHelper]: `import '${dependency}';`})),
      /Unexpected static dependency in settings warm asset/);
  }
  await assert.rejects(verifySettingsWarmAssets(readSettingsAssets({'settings.html': settingsHtml, [settingsEntry]: settingsAssets[settingsEntry]})),
    /Missing settings warm asset: assets\/settings-boot-close-Xyz34_Fg\.js/);
});
