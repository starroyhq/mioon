import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, buildCommands } from '../scripts/lib/local-tooling.mjs';
import desktopIdentity from '../apps/desktop/identity.cjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'apps/desktop');
const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const channels = [
  { script: 'package:mac', channel: 'production', config: 'electron-builder.cjs', appId: 'app.starroy.mioon' },
  { script: 'package:mac:dev', channel: 'development', config: 'electron-builder.dev.cjs', appId: 'app.starroy.mioon.dev' },
];

// Inspect only the simple, two-command manifest contract. Do not evaluate a
// shell, resolve installed tools, invoke the CLI, or execute these command plans.
function packagingPlan(script, expected) {
  const steps = script.split('&&').map(step => step.trim().split(/\s+/));
  assert.equal(steps.length, 2, 'Build must succeed before electron-builder; no extra stages');
  for (const argv of steps) for (const token of argv) assert.match(token, /^[A-Za-z0-9_./=-]+$/, 'Only literal arguments are permitted');
  const [build, builder] = steps;
  assert.equal(build[0], 'node');
  assert.equal(realpathSync(path.resolve(desktop, build[1])), realpathSync(path.join(root, 'scripts/tooling.mjs')), 'Use the shared Web→desktop entrypoint from the desktop workspace');
  assert.equal(build.length, 4);
  const options = parseArguments(build.slice(2));
  assert.equal(options.command, 'build');
  assert.equal(options.channel, expected.channel);
  assert.equal(build[3], `--channel=${expected.channel}`, 'Both channels must be explicit, including development');
  assert.deepEqual(builder, ['electron-builder', '--config', expected.config, '--mac', '--publish', 'never']);
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
    assert.equal(config.appId, desktopIdentity.identityForChannel(channel).appId);
    assert.equal(config.appId, expected.appId);
    assert.equal(path.resolve(desktop, config.directories.app), path.join(desktop, 'build'));
    assert.equal(path.resolve(desktop, config.directories.output), path.join(root, 'release/desktop', channel));
    assert.equal(config.publish, null);
    assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }]);
    assert.equal(config.mac.identity, null, 'This change must not enable signing');
  });
}

test('entrypoint checks reject the old staging-only path and channel or publication regressions', () => {
  for (const expected of channels) {
    const script = manifest.scripts[expected.script];
    const old = `node scripts/build.mjs --channel=${expected.channel} && electron-builder --config ${expected.config} --mac --publish never`;
    assert.throws(() => packagingPlan(old, expected), /shared Web→desktop entrypoint/);
    assert.throws(() => packagingPlan(script.replace('&&', ';'), expected));
    assert.throws(() => packagingPlan(script.replace('--publish never', '--publish always'), expected));
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, ''), expected));
    const other = channels.find(item => item.channel !== expected.channel);
    assert.throws(() => packagingPlan(script.replace(`--channel=${expected.channel}`, `--channel=${other.channel}`), expected));
    assert.throws(() => packagingPlan(script.replace(expected.config, other.config), expected));
  }
});

test('other desktop and platform entrypoints retain their existing behavior', () => {
  const otherScripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => !channels.some(item => item.script === name)));
  assert.deepEqual(otherScripts, {
    build: 'node scripts/build.mjs',
    start: 'electron build',
    'package:linux': 'node scripts/build.mjs --channel=production && electron-builder --config electron-builder.cjs --linux --publish never',
    'package:dir': 'node scripts/build.mjs --channel=production && electron-builder --config electron-builder.cjs --linux --dir --publish never',
    smoke: 'node scripts/smoke.mjs',
    'build:production': 'node scripts/build.mjs --channel=production',
    'package:linux:dev': 'node scripts/build.mjs --channel=development && electron-builder --config electron-builder.dev.cjs --linux --publish never',
    'package:dir:dev': 'node scripts/build.mjs --channel=development && electron-builder --config electron-builder.dev.cjs --linux --dir --publish never',
  });
});
