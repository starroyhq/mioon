import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, buildCommands } from '../scripts/lib/local-tooling.ts';
import desktopIdentity from '../apps/desktop/identity.cjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'apps/desktop');
const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const channels = [
  { script: 'package:linux', channel: 'production', config: 'electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--linux'] },
  { script: 'package:dir', channel: 'production', config: 'electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--linux', '--dir'] },
  { script: 'package:mac', channel: 'production', config: 'electron-builder.cjs', appId: 'app.starroy.mioon', targetArgs: ['--mac'] },
  { script: 'package:linux:dev', channel: 'development', config: 'electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux'] },
  { script: 'package:dir:dev', channel: 'development', config: 'electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--linux', '--dir'] },
  { script: 'package:mac:dev', channel: 'development', config: 'electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev', targetArgs: ['--mac'] },
];

// Inspect only the simple, two-command manifest contract. Do not evaluate a
// shell, resolve installed tools, invoke the CLI, or execute these command plans.
function packagingPlan(script, expected) {
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
  const config = require(path.resolve(desktop, builder[2]));
  // Synthetic Vite path: buildCommands only constructs argv and never reads it.
  const viteEntry = path.join(root, 'node_modules/vite/bin/vite.js');
  const commands = buildCommands(root, { vite: { entry: viteEntry } }, options.channel);
  return { commands, config, viteEntry };
}

for (const expected of channels) {
  test(`${expected.script} resolves the real tooling contract and plans Web before same-channel desktop staging`, () => {
    const { commands, config, viteEntry } = packagingPlan(manifest.scripts[expected.script], expected);
    assert.deepEqual(commands, [
      { command: process.execPath, args: ['--max-old-space-size=768', viteEntry, 'build'], cwd: path.join(root, 'apps/web') },
      { command: process.execPath, args: [path.join(desktop, 'scripts/build.mjs'), `--channel=${expected.channel}`], cwd: root },
    ]);
    assert.equal(realpathSync(commands[1].args[0]), realpathSync(path.join(desktop, 'scripts/build.mjs')));
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
    const old = `node scripts/build.mjs --channel=${expected.channel} && ${builder}`;
    assert.throws(() => packagingPlan(old, expected), /shared Web→desktop entrypoint/);
    assert.throws(() => packagingPlan(script.replace('&&', ';'), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('&&', ''), expected), /Build must succeed before electron-builder; no extra stages/);
    assert.throws(() => packagingPlan(script.replace('--publish never', '--publish always'), expected), /Builder must retain the exact config, target and publication arguments/);
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, ''), expected), /Build requires only the tooling path, build command and explicit channel/);
    const other = channels.find(item => item.channel !== expected.channel);
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
    build: 'node scripts/build.mjs',
    start: 'electron build',
    smoke: 'node scripts/smoke.ts',
    'build:production': 'node scripts/build.mjs --channel=production',
  });
});

test('root Linux package aliases forward directly to the checked workspace scripts', () => {
  assert.equal(rootManifest.scripts['desktop:package:linux'], 'pnpm --filter @mioon/desktop package:linux');
  assert.equal(rootManifest.scripts['desktop:package:linux:dev'], 'pnpm --filter @mioon/desktop package:linux:dev');
});
