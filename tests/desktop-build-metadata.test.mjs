import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, unlink, realpath, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import desktopBuildMetadata from '../apps/desktop/build-metadata.cjs';
import desktopIdentity from '../apps/desktop/identity.cjs';

const { readBuildMetadata, validateBuildMetadata, validateStagedMetadata } = desktopBuildMetadata;
const { identityForChannel } = desktopIdentity;
const require = createRequire(import.meta.url);
const rootPackage = (version = '2.3.4', electron = '55.6.7') => ({ version, devDependencies: { electron } });
const desktopPackage = (version = '2.3.4') => ({ version, description: 'Fixture desktop' });
const stagePackage = identity => ({ name: 'mioon-desktop', version: '2.3.4', main: 'main.cjs', private: true,
  desktopName: `${identity.appId}.desktop`, dependencies: {}, mioonDesktop: identity });

async function fixture(t, root = rootPackage(), desktop = desktopPackage()) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-build-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'apps/desktop'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(root));
  await writeFile(path.join(directory, 'apps/desktop/package.json'), JSON.stringify(desktop));
  return directory;
}

async function builderFixture(t) {
  const directory = await fixture(t);
  for (const name of ['builder-config.cjs', 'subtitle-resources.cjs', 'build-metadata.cjs', 'identity.cjs']) {
    await copyFile(new URL(`../apps/desktop/${name}`, import.meta.url), path.join(directory, 'apps/desktop', name));
  }
  return { directory, builderConfig: require(path.join(directory, 'apps/desktop/builder-config.cjs')) };
}

test('metadata uses the root app version and exact Electron pin without changing manifests', () => {
  const root = rootPackage(), desktop = desktopPackage();
  const before = JSON.stringify({ root, desktop });
  const metadata = validateBuildMetadata(root, desktop);
  assert.equal(metadata.appVersion, '2.3.4');
  assert.equal(metadata.electronVersion, '55.6.7');
  assert.equal(metadata.desktopPackage.description, 'Fixture desktop');
  assert.equal(JSON.stringify({ root, desktop }), before);
});

test('exact versions permit valid SemVer prerelease and build identifiers', () => {
  for (const version of ['0.0.0', '1.2.3-rc.1', '1.2.3-beta.0+build.01', '1.2.3-0A.0-']) {
    const metadata = validateBuildMetadata(rootPackage(version, version), desktopPackage(version));
    assert.equal(metadata.appVersion, version);
    assert.equal(metadata.electronVersion, version);
  }
});

test('desktop and root version mismatch fails without rewriting either version', () => {
  const root = rootPackage(), desktop = desktopPackage('2.3.3');
  assert.throws(() => validateBuildMetadata(root, desktop), /does not match root package\.json version 2\.3\.4/);
  assert.equal(root.version, '2.3.4');
  assert.equal(desktop.version, '2.3.3');
});

test('missing, non-object and malformed app metadata fails clearly', () => {
  for (const invalid of [undefined, null, [], '2.3.4', 234]) {
    assert.throws(() => validateBuildMetadata(invalid, desktopPackage()), /Root package\.json must contain a JSON object/);
    assert.throws(() => validateBuildMetadata(rootPackage(), invalid), /Desktop package\.json must contain a JSON object/);
  }
  for (const version of [undefined, null, 234, '', '2.3', '^2.3.4', 'v2.3.4', '02.3.4', '2.3.4-01', '2.3.4\n']) {
    assert.throws(() => validateBuildMetadata({ version, devDependencies: { electron: '55.6.7' } }, desktopPackage()), /Root package\.json version must be an exact semantic version/);
    assert.throws(() => validateBuildMetadata(rootPackage(), { version }), /Desktop package\.json version must be an exact semantic version/);
  }
});

test('Electron metadata rejects missing pins, ranges, tags and malformed exact versions', () => {
  for (const electron of [undefined, null, false, 55, {}, [], '', '^55.6.7', '~55.6.7', '>=55.6.7', '55.x',
    '*', 'latest', 'v55.6.7', '=55.6.7', '55.6', '55.6.7 || 56.0.0', '55.6.7 ', '55.6.7\n',
    '055.6.7', '55.06.7', '55.6.07', '55.6.7-01', '55.6.7-', '55.6.7+', '55.6.7-rc..1']) {
    assert.throws(() => validateBuildMetadata({ version: '2.3.4', devDependencies: { electron } }, desktopPackage()), /devDependencies\.electron must be an exact semantic version/);
  }
  assert.throws(() => validateBuildMetadata({ version: '2.3.4' }, desktopPackage()), /devDependencies\.electron/);
});

test('reader resolves metadata relative to the supplied root and remains read-only on mismatch', async t => {
  const directory = await fixture(t);
  assert.equal(readBuildMetadata(directory).appVersion, '2.3.4');
  assert.equal(readBuildMetadata(directory).electronVersion, '55.6.7');
  const desktopFile = path.join(directory, 'apps/desktop/package.json');
  const staleDesktop = JSON.stringify(desktopPackage('2.3.3'));
  await writeFile(desktopFile, staleDesktop);
  const staging = path.join(directory, 'apps/desktop/build');
  await mkdir(staging);
  await writeFile(path.join(staging, 'sentinel'), 'existing stage');
  assert.throws(() => readBuildMetadata(directory), /does not match/);
  assert.equal(await readFile(desktopFile, 'utf8'), staleDesktop);
  assert.equal(await readFile(path.join(staging, 'sentinel'), 'utf8'), 'existing stage');
});

test('reader reports malformed JSON and missing manifests with the failing path', async t => {
  const directory = await fixture(t);
  const rootFile = path.join(directory, 'package.json');
  await writeFile(rootFile, '{broken');
  assert.throws(() => readBuildMetadata(directory), error => {
    assert.ok(error.message.includes(rootFile));
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  await writeFile(rootFile, JSON.stringify(rootPackage()));
  const desktopFile = path.join(directory, 'apps/desktop/package.json');
  await unlink(desktopFile);
  assert.throws(() => readBuildMetadata(directory), error => {
    assert.ok(error.message.includes(desktopFile));
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});

test('staging validates every identity field and rejects missing or stale app versions', () => {
  for (const channel of ['production', 'development']) {
    const identity = identityForChannel(channel), expected = { appVersion: '2.3.4', identity };
    const valid = stagePackage(identity);
    assert.doesNotThrow(() => validateStagedMetadata(valid, expected));
    for (const key of ['channel', 'appId', 'productName', 'executableName']) {
      for (const value of [undefined, 'stale-value']) {
        assert.throws(() => validateStagedMetadata({ ...valid, mioonDesktop: { ...identity, [key]: value } }, expected), /identity mismatch; rebuild with --channel=/);
      }
    }
    for (const version of [undefined, null, '2.3.3', '2.3.4+old', 234]) {
      assert.throws(() => validateStagedMetadata({ ...valid, version }, expected), /version mismatch; rebuild version 2\.3\.4 with --channel=/);
    }
    for (const invalid of [null, undefined, [], {}, { version: '2.3.4' }]) {
      assert.throws(() => validateStagedMetadata(invalid, expected), /identity mismatch/);
    }
  }
});

test('staging rejects missing or changed packaging envelope fields and nonempty dependencies', () => {
  for (const channel of ['production', 'development']) {
    const identity = identityForChannel(channel), expected = { appVersion: '2.3.4', identity };
    const valid = stagePackage(identity);
    for (const [key, value] of [['name', 'other-app'], ['main', 'other.cjs'], ['private', false],
      ['desktopName', 'other.desktop'], ['dependencies', { electron: '55.6.7' }], ['dependencies', []],
      ['dependencies', null], ['dependencies', '']]) {
      assert.throws(() => validateStagedMetadata({ ...valid, [key]: value }, expected), /package metadata mismatch; rebuild with --channel=/);
    }
    for (const key of ['name', 'main', 'private', 'desktopName', 'dependencies']) {
      const missing = { ...valid };
      delete missing[key];
      assert.throws(() => validateStagedMetadata(missing, expected), /package metadata mismatch/);
    }
  }
});

test('builder config takes its Electron version from root metadata and validates before loading a stage', async t => {
  const { directory, builderConfig } = await builderFixture(t);
  const config = builderConfig('production');
  assert.equal(config.electronVersion, '55.6.7');
  assert.equal(config.publish, null);
  assert.equal(config.asar, true);
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  await writeFile(path.join(directory, 'apps/desktop/package.json'), JSON.stringify(desktopPackage('2.3.3')));
  assert.throws(() => builderConfig('production'), /does not match/);
  await writeFile(path.join(directory, 'apps/desktop/package.json'), JSON.stringify(desktopPackage()));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(rootPackage('2.3.4', '^55.6.7')));
  assert.throws(() => builderConfig('production'), /devDependencies\.electron/);
});

test('beforePack rejects stale same-channel versions and names for both channels using fixture manifests only', async t => {
  const { directory, builderConfig } = await builderFixture(t);
  const stage = path.join(directory, 'apps/desktop/build');
  await mkdir(stage);
  await cp(new URL('../packages/business/resources/subtitles/',import.meta.url),path.join(stage,'subtitles'),{recursive:true});
  const stageFile = path.join(stage, 'package.json'), context = { packager: { info: { appDir: stage } } };
  for (const channel of ['production', 'development']) {
    const identity = identityForChannel(channel), config = builderConfig(channel);
    const valid = stagePackage(identity);
    await writeFile(stageFile, JSON.stringify(valid));
    await config.beforePack(context);
    for (const version of [undefined, '2.3.3']) {
      await writeFile(stageFile, JSON.stringify({ ...valid, version }));
      await assert.rejects(config.beforePack(context), /version mismatch/);
    }
    for (const key of ['channel', 'appId', 'productName', 'executableName']) {
      await writeFile(stageFile, JSON.stringify({ ...valid, mioonDesktop: { ...identity, [key]: 'stale-value' } }));
      await assert.rejects(config.beforePack(context), /identity mismatch/);
    }
    await writeFile(stageFile, JSON.stringify({ ...valid, dependencies: { electron: '55.6.7' } }));
    await assert.rejects(config.beforePack(context), /package metadata mismatch/);
  }
});

test('staging build preflights metadata before cleanup and writes the root application version', async () => {
  const source = await readFile(new URL('../apps/desktop/scripts/build.ts', import.meta.url), 'utf8');
  const validation = source.indexOf('desktopBuildMetadata.readBuildMetadata(root)');
  const cleanup = source.indexOf('await rm(output,');
  assert.ok(validation >= 0 && cleanup > validation, 'Metadata validation must run before staging removal');
  assert.match(source, /version: appVersion/);
  assert.doesNotMatch(source, /version: pkg\.version/);
});
