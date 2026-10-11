import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import desktopIdentity from '../apps/desktop/identity.cjs';
import { dataPaths, ensureDataIdentity, writeConnection, removeConnection } from '../apps/desktop/src/config.mjs';
import { migrateData } from '../apps/desktop/scripts/migrate-data.mjs';
import { openStore } from '@mioon/business';
const { identityForChannel, buildChannel } = desktopIdentity;
const require = createRequire(import.meta.url);
const production = identityForChannel('production'), development = identityForChannel('development');
const temp = () => mkdtemp(path.join(tmpdir(), 'wb-identity-'));

test('production and development IDs are exact, distinct and immutable', () => {
  assert.equal(production.appId, 'app.starroy.mioon');
  assert.equal(development.appId, 'app.starroy.mioon.dev');
  assert.notEqual(production.productName, development.productName);
  assert.notEqual(production.executableName, development.executableName);
  assert.ok(Object.isFrozen(production)); assert.ok(Object.isFrozen(development));
  for (const invalid of ['', undefined, 'dev', 'test', '__proto__']) assert.throws(() => identityForChannel(invalid));
});

test('build defaults to development and selects production only by an explicit validated argument', () => {
  assert.equal(buildChannel([]), 'development');
  assert.equal(buildChannel(['--channel=development']), 'development');
  assert.equal(buildChannel(['--channel=production']), 'production');
  for (const args of [['--channel=prod'], ['--channel='], ['--production'], ['--channel=production', '--channel=development']]) assert.throws(() => buildChannel(args));
});

test('runtime identity is embedded and never selected from packaged state or a launch environment', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /identityForChannel\(__MIOON_DESKTOP_CHANNEL__\)/);
  assert.match(main, /app\.setAppUserModelId\(identity\.appId\)/);
  assert.match(main, /app\.setDesktopName\(`\$\{identity\.appId\}\.desktop`\)/);
  assert.doesNotMatch(main, /process\.env\.(?:NODE_ENV|MIOON_DESKTOP_CHANNEL|MIOON_APP_ID)/);
  const build = await readFile(new URL('../apps/desktop/scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /__MIOON_DESKTOP_CHANNEL__: JSON\.stringify\(identity\.channel\)/);
  assert.match(build, /mioonDesktop: identity/);
});

test('both package configs retain security and separate identities, names and output directories', () => {
  const prod = require('../apps/desktop/electron-builder.cjs'), dev = require('../apps/desktop/electron-builder.dev.cjs');
  for (const [config, identity] of [[prod, production], [dev, development]]) {
    assert.equal(config.appId, identity.appId);
    assert.equal(config.productName, identity.productName);
    assert.equal(config.linux.desktop.entry.StartupWMClass, identity.appId);
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.publish, null); assert.equal(config.asar, true);
    assert.equal(config.electronFuses.runAsNode, false);
    assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  }
  assert.notEqual(prod.directories.output, dev.directories.output);
  assert.notEqual(prod.linux.artifactName, dev.linux.artifactName);
  assert.notEqual(prod.mac.artifactName, dev.mac.artifactName);
});

test('packaging refuses missing or opposite-channel staging, including packaged development', async () => {
  const root = await temp();
  await cp(new URL('../packages/business/resources/subtitles/',import.meta.url),path.join(root,'subtitles'),{recursive:true});
  const { appVersion } = require('../apps/desktop/build-metadata.cjs').readBuildMetadata();
  try {
    for (const identity of [production, development]) {
      const config = require(identity.channel === 'production' ? '../apps/desktop/electron-builder.cjs' : '../apps/desktop/electron-builder.dev.cjs');
      const context = { packager: { info: { appDir: root } } };
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mioon-desktop', version: appVersion,
        main: 'main.cjs', private: true, desktopName: `${identity.appId}.desktop`, dependencies: {}, mioonDesktop: identity }));
      await config.beforePack(context);
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ mioonDesktop: identity === production ? development : production }));
      await assert.rejects(config.beforePack(context), /identity mismatch/);
      await writeFile(path.join(root, 'package.json'), '{}');
      await assert.rejects(config.beforePack(context), /identity mismatch/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('package commands explicitly rebuild the correct channel before electron-builder', async () => {
  const pkg = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  for (const target of ['linux', 'dir', 'mac']) {
    const build = target === 'mac' ? 'node ../../scripts/tooling.mjs build' : 'node scripts/build.mjs';
    const targetFlags = target === 'dir' ? '--linux --dir' : `--${target}`;
    for (const [suffix, channel, config] of [['', 'production', 'electron-builder.cjs'], [':dev', 'development', 'electron-builder.dev.cjs']]) {
      assert.equal(pkg.scripts[`package:${target}${suffix}`], `${build} --channel=${channel} && electron-builder --config ${config} ${targetFlags} --publish never`);
    }
  }
});

test('default channel directories isolate workspace, config and discovery from each other and legacy data', () => {
  const prod = dataPaths('/home/u/.config', undefined, 'production');
  const dev = dataPaths('/home/u/.config', undefined, 'development');
  assert.equal(prod.userData, '/home/u/.config/app.starroy.mioon');
  assert.equal(dev.userData, '/home/u/.config/app.starroy.mioon.dev');
  for (const key of ['userData', 'dataDir', 'configFile']) assert.notEqual(prod[key], dev[key]);
  assert.equal(dataPaths('/other', '/explicit', 'production').userData, '/explicit');
  assert.throws(() => dataPaths('/other', '/explicit', 'bad'));
  assert.throws(() => dataPaths('/other', '../relative', 'production'));
});

test('data identity marker prevents accidental opposite-channel reuse of an explicit override', async () => {
  const root = await temp(), paths = dataPaths('/unused', root, 'production');
  try {
    await ensureDataIdentity(paths, production);
    const before = await readFile(path.join(root, 'desktop-identity.json'), 'utf8');
    assert.equal((await stat(path.join(root, 'desktop-identity.json'))).mode & 0o777, 0o600);
    await ensureDataIdentity(paths, production);
    await assert.rejects(ensureDataIdentity(paths, development), /another app channel/);
    assert.equal(await readFile(path.join(root, 'desktop-identity.json'), 'utf8'), before);
    await writeFile(path.join(root, 'desktop-identity.json'), '{broken');
    await assert.rejects(ensureDataIdentity(paths, production), /unreadable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('channel discovery rotates and cleans up independently with additive identity metadata', async () => {
  const root = await temp();
  const prod = dataPaths(root, undefined, 'production'), dev = dataPaths(root, undefined, 'development');
  try {
    await ensureDataIdentity(prod, production); await ensureDataIdentity(dev, development);
    const prodFile = await writeConnection(prod, { url: 'http://127.0.0.1:12345', token: 'prod', pid: process.pid, identity: production });
    const devFile = await writeConnection(dev, { url: 'http://127.0.0.1:12346', token: 'dev', pid: process.pid, identity: development });
    assert.notEqual(prodFile, devFile);
    const descriptor = JSON.parse(await readFile(devFile, 'utf8'));
    assert.equal(descriptor.version, 1); assert.equal(descriptor.appId, development.appId); assert.equal(descriptor.channel, 'development');
    await removeConnection(prod);
    await assert.rejects(readFile(prodFile), { code: 'ENOENT' });
    assert.equal(await readFile(descriptor.tokenFile, 'utf8'), 'dev\n');
    assert.equal(JSON.parse(await readFile(devFile, 'utf8')).url, 'http://127.0.0.1:12346');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new identity never moves legacy data; explicit migration copies into a fresh channel workspace', async () => {
  const root = await temp(), legacy = path.join(root, 'video-workbench');
  const source = path.join(legacy, 'workspace'), prod = dataPaths(root, undefined, 'production');
  try {
    const store = openStore(source); store.put('projects', { id: '12345678-1234-4234-8234-123456789abc', name: 'Legacy', revision: 1 }); store.close();
    await writeFile(path.join(source, 'media/legacy.txt'), 'unchanged original');
    const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    const before = await hash(path.join(source, 'workbench.sqlite'));
    await ensureDataIdentity(prod, production);
    assert.deepEqual(await readdir(prod.userData), ['desktop-identity.json']);
    assert.equal(await hash(path.join(source, 'workbench.sqlite')), before);
    const result = await migrateData(source, prod.dataDir);
    assert.equal(result.projects, 1); assert.equal(result.sourceUnchanged, true);
    assert.equal(await hash(path.join(source, 'workbench.sqlite')), before);
    assert.equal(await readFile(path.join(source, 'media/legacy.txt'), 'utf8'), 'unchanged original');
    assert.equal(await readFile(path.join(prod.dataDir, 'media/legacy.txt'), 'utf8'), 'unchanged original');
    await assert.rejects(migrateData(source, prod.dataDir), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
