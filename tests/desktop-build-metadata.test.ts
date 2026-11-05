import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {createHash} from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, unlink, realpath, cp, chmod, lstat, rename } from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import desktopBuildMetadata from '../apps/desktop/build-metadata.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import {NOTICE_FILES} from '../apps/desktop/runtime-notices.ts';
import {PROJECT_EXAMPLE_METADATA_FILES, stageProjectExampleResources, verifyProjectExampleResources} from '../packages/business/src/project-example-resources.ts';

const { readBuildMetadata, validateBuildMetadata, validateStagedMetadata } = desktopBuildMetadata;
const { identityForChannel } = desktopIdentity;
const require = createRequire(import.meta.url);
const rootPackage = (version = '2.3.4', electron = '55.6.7') => ({ version, devDependencies: { electron } });
const desktopPackage = (version = '2.3.4') => ({ version, description: 'Fixture desktop' });
const stagePackage = (identity: ReturnType<typeof identityForChannel>) => ({ name: 'mioon-desktop', version: '2.3.4', main: 'main.cjs', private: true,
  desktopName: `${identity.appId}.desktop`, dependencies: {}, mioonDesktop: identity });

async function fixture(t: TestContext, root = rootPackage(), desktop = desktopPackage()) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-build-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'apps/desktop'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(root));
  await writeFile(path.join(directory, 'apps/desktop/package.json'), JSON.stringify(desktop));
  return directory;
}

async function builderFixture(t: TestContext) {
  const directory = await fixture(t);
  for (const name of ['subtitle-resources.ts', 'runtime-notices.ts', 'build-metadata.ts', 'identity.ts']) {
    await copyFile(new URL(`../apps/desktop/${name}`, import.meta.url), path.join(directory, 'apps/desktop', name));
  }
  // Keep the real verifier while resolving it from its original module URL.
  // The fixture may be on a different Windows drive from the workspace.
  const source = await readFile(new URL('../apps/desktop/builder-config.ts', import.meta.url), 'utf8');
  const specifier = "from '@mioon/business/project-example-resources'";
  assert.equal(source.split(specifier).length, 2, 'exactly one reviewed builder dependency is rebound');
  await writeFile(path.join(directory, 'apps/desktop/builder-config.ts'), source.replace(specifier,
    `from ${JSON.stringify(new URL('../packages/business/src/project-example-resources.ts', import.meta.url).href)}`));
  return { directory, builderConfig: require(path.join(directory, 'apps/desktop/builder-config.ts')).builderConfig };
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
  assert.throws(() => readBuildMetadata(directory), (error: unknown) => {
    const failure = error as Error & {cause?: unknown};
    assert.ok(failure.message.includes(rootFile));
    assert.ok(failure.cause instanceof SyntaxError);
    return true;
  });
  await writeFile(rootFile, JSON.stringify(rootPackage()));
  const desktopFile = path.join(directory, 'apps/desktop/package.json');
  await unlink(desktopFile);
  assert.throws(() => readBuildMetadata(directory), (error: unknown) => {
    const failure = error as Error & {cause?: {code?: string}};
    assert.ok(failure.message.includes(desktopFile));
    assert.equal(failure.cause?.code, 'ENOENT');
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
      ['dependencies', null], ['dependencies', '']] as Array<[string, unknown]>) {
      assert.throws(() => validateStagedMetadata({ ...valid, [key]: value }, expected), /package metadata mismatch; rebuild with --channel=/);
    }
    for (const key of ['name', 'main', 'private', 'desktopName', 'dependencies']) {
      const missing: Record<string, unknown> = { ...valid };
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
  await stageProjectExampleResources(fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url)), path.join(stage, 'examples'));
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

test('beforePack rejects missing or corrupted examples after metadata and subtitle checks without changing the stage', async t => {
  const {directory, builderConfig} = await builderFixture(t), stage = path.join(directory, 'apps/desktop/build');
  await mkdir(stage); await cp(new URL('../packages/business/resources/subtitles/', import.meta.url), path.join(stage, 'subtitles'), {recursive: true});
  const identity = identityForChannel('production'), metadata = JSON.stringify(stagePackage(identity)), metadataFile = path.join(stage, 'package.json');
  await writeFile(metadataFile, metadata);
  const config = builderConfig('production'), context = {packager: {info: {appDir: stage}}};
  await assert.rejects(config.beforePack(context), {code: 'ENOENT'});
  const examples = path.join(stage, 'examples');
  const entries = await stageProjectExampleResources(fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url)), examples);
  await config.beforePack(context);
  const asset = path.join(entries[0].directory, entries[0].manifest.assets[0].path), original = await readFile(asset);
  await chmod(asset, 0o600); await writeFile(asset, Buffer.alloc(original.length));
  await assert.rejects(config.beforePack(context), {code: 'PROJECT_EXAMPLE_RESOURCES_INVALID'});
  assert.equal(await readFile(metadataFile, 'utf8'), metadata);
  assert.deepEqual(await readFile(asset), Buffer.alloc(original.length), 'verification does not silently repair corrupted package resources');
});

test('the pinned Mac signer skips only verified example data while retaining code and every resource byte', async t => {
  const {directory, builderConfig} = await builderFixture(t);
  const builder = createRequire(require.resolve('electron-builder'));
  const libraries = createRequire(builder.resolve('app-builder-lib'));
  const libraryRoot = path.dirname(builder.resolve('app-builder-lib/package.json'));
  const {Arch} = libraries('builder-util') as {Arch: {arm64: number}};
  type SignOptions = Record<string, unknown> & {ignore(file: string): boolean};
  const {MacTargetHelper} = require(path.join(libraryRoot, 'out/mac/MacTargetHelper.js')) as {
    MacTargetHelper: new (packager: {config: {electronVersion: string}; resourceList: Promise<string[]>;
      platformSpecificBuildOptions: Record<string, never>}) => {
        buildSignOptions(app: string, identity: {name: string}, type: string, isMas: boolean,
          config: unknown, keychain: undefined, arch: number): Promise<SignOptions>;
      };
  };
  const signer = libraries('@electron/osx-sign') as {
    walkAsync(contents: string): Promise<string[]>;
    signApp(options: Record<string, unknown>): Promise<void>;
  };
  const signerRequire = createRequire(libraries.resolve('@electron/osx-sign'));
  const signerUtilities = signerRequire('./util') as {
    execFileAsync(file: string, args: readonly string[]): Promise<string>;
  };
  const commands: string[][] = [];
  // Keep the real builder regex conversion, binary walker and signing loop.
  // This single command boundary cannot reach codesign, security or a keychain.
  t.mock.method(signerUtilities, 'execFileAsync', async (file: string, args: readonly string[]) => {
    assert.equal(file, 'codesign', 'identity lookup and other external commands are forbidden in this fixture');
    assert.equal(args.includes('--keychain'), false);
    commands.push([...args]);
    return '';
  });

  const app = path.join(directory, 'fixture.app'), contents = path.join(app, 'Contents');
  const examples = path.join(contents, 'Resources/examples');
  await mkdir(path.dirname(examples), {recursive: true});
  const [example] = await stageProjectExampleResources(fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url)), examples);
  const payloads = [example.manifest.projectFile, ...example.manifest.assets].map(item => path.join(example.directory, item.path));
  const resources = [...payloads, ...PROJECT_EXAMPLE_METADATA_FILES.map(name => path.join(example.directory, name))];
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const originals = await Promise.all(resources.map(async file => ({file, bytes: await readFile(file), mode: (await lstat(file)).mode & 0o777})));
  if (process.platform !== 'win32') for (const original of originals) assert.equal(original.mode, 0o444);

  const codeFiles = [
    'MacOS/mioon',
    'Frameworks/mioon Helper.app/Contents/MacOS/helper',
    'Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Resources/app.asar.unpacked/native.node',
    'Resources/native.dylib',
    'Resources/examples-evil/timeline-basics/media/overlay-star.png',
    'Resources/examples/timeline-basics/media/overlay-star.png.node',
  ].map(relative => path.join(contents, relative));
  for (const file of codeFiles) {
    await mkdir(path.dirname(file), {recursive: true});
    // Synthetic Mach-O-like bytes are observed, never executed or signed.
    await writeFile(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  const expectedCode = [...codeFiles, app,
    path.join(contents, 'Frameworks/mioon Helper.app'),
    path.join(contents, 'Frameworks/Electron Framework.framework')];
  const candidates = await signer.walkAsync(contents);
  for (const file of [...payloads, ...codeFiles]) assert.ok(candidates.includes(file), `real binary walker must include ${path.relative(contents, file)}`);

  for (const channel of ['production', 'development']) {
    const config = builderConfig(channel);
    const helper = new MacTargetHelper({config: {electronVersion: config.electronVersion},
      resourceList: Promise.resolve([]), platformSpecificBuildOptions: {}});
    const options = await helper.buildSignOptions(app, {name: 'MIOON_TEST_NO_SIGNING_IDENTITY'}, 'distribution', false, config.mac, undefined, Arch.arm64);
    commands.length = 0;
    await signer.signApp({...options, identity: 'MIOON_TEST_NO_SIGNING_IDENTITY', identityValidation: false,
      preEmbedProvisioningProfile: false, preAutoEntitlements: false});
    const signed = commands.filter(args => args.includes('--sign')).map(args => args.at(-1));
    for (const original of originals) {
      const bytes = await readFile(original.file);
      assert.deepEqual(bytes, original.bytes, 'signing selection cannot rewrite delivered example data');
      assert.equal(digest(bytes), digest(original.bytes));
      assert.equal((await lstat(original.file)).mode & 0o777, original.mode);
    }
    assert.deepEqual(signed.filter(file => payloads.includes(file!)), [], 'verified example data must never be individually signed');
    for (const file of expectedCode) assert.ok(signed.includes(file), `code must remain in the real signing loop: ${path.relative(directory, file)}`);
    for (const file of resources) {
      assert.equal(options.ignore(file.replaceAll('\\', '/')), true, 'exact data paths must match with POSIX separators');
      assert.equal(options.ignore(file.replaceAll('/', '\\')), true, 'exact data paths must match with Windows separators');
    }
    for (const file of expectedCode) {
      assert.equal(options.ignore(file.replaceAll('\\', '/')), false, 'code and approximate resource names must remain eligible');
      assert.equal(options.ignore(file.replaceAll('/', '\\')), false, 'separator compatibility must not broaden the ignored names');
    }
  }
  // Remove only the injected code lookalike before checking the strict catalog.
  await rm(codeFiles.at(-1)!);
  assert.deepEqual(verifyProjectExampleResources(examples)[0].manifest, example.manifest);
});

test('beforePack and Mac afterPack reject same-size PNG and project changes without repairing the resources', async t => {
  const {directory, builderConfig} = await builderFixture(t), config = builderConfig('production');
  const builder = createRequire(require.resolve('electron-builder'));
  const libraries = createRequire(builder.resolve('app-builder-lib'));
  const {Arch} = libraries('builder-util') as {Arch: {arm64: number}};
  const stage = path.join(directory, 'apps/desktop/build');
  await mkdir(stage);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(stagePackage(identityForChannel('production'))));
  await cp(new URL('../packages/business/resources/subtitles/', import.meta.url), path.join(stage, 'subtitles'), {recursive: true});
  const [example] = await stageProjectExampleResources(fileURLToPath(new URL('../examples/project-file-v1/', import.meta.url)), path.join(stage, 'examples'));
  const damagedPaths = [example.manifest.projectFile.path, example.manifest.assets.find(asset => asset.path.endsWith('.png'))!.path];
  const beforeContext = {packager: {info: {appDir: stage}}};
  await config.beforePack(beforeContext);
  const rejectChange = async (file: string, check: () => Promise<void>) => {
    const original = await readFile(file), changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await chmod(file, 0o600); await writeFile(file, changed);
    assert.equal((await lstat(file)).size, original.length);
    await assert.rejects(check(), {code: 'PROJECT_EXAMPLE_RESOURCES_INVALID', details: {reason: 'content-hash'}});
    assert.deepEqual(await readFile(file), changed, 'validation must report, not repair, changed data');
    await writeFile(file, original); await chmod(file, 0o444);
  };
  for (const relative of damagedPaths) await rejectChange(path.join(example.directory, relative), () => config.beforePack(beforeContext));
  await config.beforePack(beforeContext);

  const appOutDir = path.join(directory, 'mac-package'), extracted = path.join(appOutDir, 'Electron.app');
  await mkdir(path.join(extracted, 'Contents/Resources'), {recursive: true});
  await writeFile(path.join(extracted, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${config.electronVersion}</string></dict></plist>`);
  for (const file of NOTICE_FILES) await writeFile(path.join(appOutDir, file.source), `Synthetic runtime notice: ${file.source}\n`);
  const afterContext = {appOutDir, electronPlatformName: 'darwin', arch: Arch.arm64,
    packager: {config, appInfo: {productFilename: config.executableName},
      info: {framework: {version: config.electronVersion, distMacOsAppName: 'Electron.app'}}}};
  await config.afterExtract(afterContext);
  for (const file of NOTICE_FILES) await rm(path.join(appOutDir, file.source));
  const app = path.join(appOutDir, `${config.executableName}.app`);
  await rename(extracted, app);
  const resources = path.join(app, 'Contents/Resources');
  await cp(path.join(stage, 'subtitles'), path.join(resources, 'subtitles'), {recursive: true});
  const [packaged] = await stageProjectExampleResources(path.join(stage, 'examples'), path.join(resources, 'examples'));
  for (const relative of damagedPaths) await rejectChange(path.join(packaged.directory, relative), () => config.afterPack(afterContext));
  await config.afterPack(afterContext);
  assert.deepEqual(verifyProjectExampleResources(path.join(resources, 'examples'))[0].manifest, example.manifest);
});
