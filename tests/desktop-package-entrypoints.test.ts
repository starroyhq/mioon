import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, buildCommands } from '../scripts/lib/local-tooling.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import { verifySettingsWarmAssets } from '../apps/desktop/scripts/settings-warm-assets.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'apps/desktop');
const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const channels = [
  { script: 'package:linux', channel: 'production', config: '.generated/electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--linux'] },
  { script: 'package:dir', channel: 'production', config: '.generated/electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--linux', '--dir'] },
  { script: 'package:mac', channel: 'production', config: '.generated/electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--mac'] },
  { script: 'package:linux:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux'] },
  { script: 'package:dir:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux', '--dir'] },
  { script: 'package:mac:dev', channel: 'development', config: '.generated/electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--mac'] },
];

// Inspect only the simple, two-command manifest contract. Do not evaluate a
// shell, resolve installed tools, invoke the CLI, or execute these command plans.
type ChannelExpectation = typeof channels[number];
function packagingPlan(script: string, expected: ChannelExpectation) {
  const steps = script.split('&&').map(step => step.trim().split(/\s+/));
  assert.equal(steps.length, 2, 'Build must succeed before electron-builder; no extra stages');
  for (const argv of steps) for (const token of argv) assert.match(token, /^[A-Za-z0-9_./=-]+$/, 'Only literal arguments are permitted');
  const [build, builder] = steps;
  assert.equal(build[0], 'node', 'Run the shared build before electron-builder');
  assert.equal(realpathSync(path.resolve(desktop, build[1])), realpathSync(path.join(root, 'scripts/tooling.ts')), 'Use the shared Web→desktop entrypoint from the desktop workspace');
  assert.equal(build.length, 4, 'Build requires only the tooling path, build command and explicit channel');
  const options = parseArguments(build.slice(2));
  assert.equal(options.command, 'build');
  assert.equal(options.channel, expected.channel, 'Build must select the expected channel');
  assert.equal(build[3], `--channel=${expected.channel}`, 'Both channels must be explicit, including development');
  assert.deepEqual(builder, ['electron-builder', '--config', expected.config, ...expected.targetArgs, '--publish', 'never'], 'Builder must retain the exact config, target and publication arguments');
  const config = require(path.resolve(desktop, 'builder-config.ts')).builderConfig(expected.channel);
  // Synthetic Vite path: buildCommands only constructs argv and never reads it.
  const viteEntry = path.join(root, 'node_modules/vite/bin/vite.js');
  const commands = buildCommands(root, { vite: { entry: viteEntry } } as unknown as Parameters<typeof buildCommands>[1], options.channel);
  return { commands, config, viteEntry };
}

for (const expected of channels) {
  test(`${expected.script} resolves the real tooling contract and plans Web before same-channel desktop staging`, () => {
    const { commands, config, viteEntry } = packagingPlan(manifest.scripts[expected.script] as string, expected);
    assert.deepEqual(commands, [
      { command: process.execPath, args: ['--max-old-space-size=768', viteEntry, 'build'], cwd: path.join(root, 'apps/web') },
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
    assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }]);
    assert.equal(config.mac.identity, null, 'This change must not enable signing');
  });
}

test('entrypoint checks reject the old staging-only path and channel or publication regressions', () => {
  for (const expected of channels) {
    // Start mutations from the required contract so an existing legacy script
    // cannot make an unrelated negative assertion pass for the wrong reason.
    const builder = `electron-builder --config ${expected.config} ${expected.targetArgs.join(' ')} --publish never`;
    const script = `node ../../scripts/tooling.ts build --channel=${expected.channel} && ${builder}`;
    const old = `node scripts/build.ts --channel=${expected.channel} && ${builder}`;
    assert.throws(() => packagingPlan(old, expected), /shared Web→desktop entrypoint/);
    assert.throws(() => packagingPlan(script.replace('&&', ';'), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('&&', ''), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('--publish never', '--publish always'), expected), /Builder must retain the exact config, target and publication arguments/);
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, ''), expected), /Build requires only the tooling path, build command and explicit channel/);
    const other = channels.find(item => item.channel !== expected.channel);
    if (!other) throw new Error(`missing opposite-channel entry for ${expected.channel}`);
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, `--channel=${other.channel}`), expected), /Build must select the expected channel/);
    assert.throws(() => packagingPlan(script.replace(expected.config, other.config), expected), /Builder must retain the exact config, target and publication arguments/);
  }
});

test('entrypoint checks reject missing, reversed or extra stages and misrouted builder arguments', () => {
  for (const expected of channels) {
    const build = `node ../../scripts/tooling.ts build --channel=${expected.channel}`;
    const builder = `electron-builder --config ${expected.config} ${expected.targetArgs.join(' ')} --publish never`;
    const script = `${build} && ${builder}`;
    for (const missing of [build, builder]) {
      assert.throws(() => packagingPlan(missing, expected), /Build must succeed before electron-builder; no extra stages/, `${expected.script}: missing command`);
    }
    assert.throws(() => packagingPlan(`${builder} && ${build}`, expected), /Run the shared build before electron-builder/, `${expected.script}: reversed commands`);
    assert.throws(() => packagingPlan(`${build} && ${build} && ${builder}`, expected), /Build must succeed before electron-builder; no extra stages/, `${expected.script}: extra stage`);
    assert.throws(() => packagingPlan(`${build} --extra && ${builder}`, expected), /Build requires only the tooling path, build command and explicit channel/, `${expected.script}: extra build argument`);
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

test('other desktop entrypoints retain their existing behavior', () => {
  const otherScripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => !channels.some(item => item.script === name)));
  assert.deepEqual(otherScripts, {
    build: 'node scripts/build.ts',
    'prepare:builder-config': 'node scripts/prepare-builder-config.ts',
    start: 'electron build',
    smoke: 'node scripts/smoke.ts',
    'build:production': 'node scripts/build.ts --channel=production',
  });
});

test('root Linux package aliases forward directly to the checked workspace scripts', () => {
  assert.equal(rootManifest.scripts['desktop:package:linux'], 'pnpm --filter @mioon/desktop package:linux');
  assert.equal(rootManifest.scripts['desktop:package:linux:dev'], 'pnpm --filter @mioon/desktop package:linux:dev');
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
