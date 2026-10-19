import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, link, truncate, realpath, lstat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const builderConfig = require('../apps/desktop/builder-config.cjs');
const { NOTICE_FILES, PLIST_MAX_BYTES } = require('../apps/desktop/runtime-notices.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;

async function fixture(t, { config = builderConfig('production'), platform = 'darwin', arch = 1 } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-runtime-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extracted = path.join(root, 'Electron.app');
  const resources = path.join(extracted, 'Contents/Resources');
  await mkdir(resources, { recursive: true });
  const info = path.join(extracted, 'Contents/Info.plist');
  await writeFile(info, plist(config.electronVersion));
  const originals = new Map();
  for (const file of NOTICE_FILES) {
    const bytes = Buffer.concat([Buffer.from(`${platform}/${arch}/${file.source}\r\n`), Buffer.from([0, 0xff, 0x0a])]);
    originals.set(file.output, bytes);
    await writeFile(path.join(root, file.source), bytes);
  }
  const context = { appOutDir: root, electronPlatformName: platform, arch,
    packager: { config, appInfo: { productFilename: config.executableName },
      info: { framework: { version: config.electronVersion, distMacOsAppName: 'Electron.app' } } } };
  const packaged = path.join(root, `${context.packager.appInfo.productFilename}.app`);
  return { root, config, context, originals, info, extracted, packaged, resources,
    destination: path.join(resources, 'licenses') };
}

async function packageRename(item) {
  // Only model builder's cleanup/rename. This does not build or launch an app.
  for (const file of NOTICE_FILES) await rm(path.join(item.root, file.source));
  await rename(item.extracted, item.packaged);
  await cp(new URL('../packages/business/resources/subtitles/',import.meta.url),path.join(item.packaged,'Contents/Resources/subtitles'),{recursive:true});
  return path.join(item.packaged, 'Contents/Resources/licenses');
}

async function assertMissing(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('both channels preserve each Mac target notice byte-for-byte through cleanup and bundle rename', async t => {
  for (const channel of ['development', 'production']) {
    const config = builderConfig(channel);
    for (const platform of ['darwin', 'mas']) {
      for (const arch of [1, 3]) {
        const item = await fixture(t, { config, platform, arch });
        // The standard extraction path removes root/version before this hook.
        await assertMissing(path.join(item.root, 'version'));
        await config.afterExtract(item.context);
        for (const file of NOTICE_FILES) {
          assert.deepEqual(await readFile(path.join(item.root, file.source)), item.originals.get(file.output));
          assert.deepEqual(await readFile(path.join(item.destination, file.output)), item.originals.get(file.output));
        }
        const destination = await packageRename(item);
        await config.afterPack(item.context);
        for (const file of NOTICE_FILES) {
          assert.equal(hash(await readFile(path.join(destination, file.output))), hash(item.originals.get(file.output)));
        }
      }
    }
  }
});

test('source validation independently rejects either missing, empty, nonregular, symlinked, hardlinked or oversized notice before copying', async t => {
  for (const file of NOTICE_FILES) {
    for (const kind of ['missing', 'empty', 'directory', 'symlink', 'hardlink', 'oversized']) {
      const item = await fixture(t);
      const source = path.join(item.root, file.source);
      await rm(source);
      if (kind === 'empty') await writeFile(source, '');
      if (kind === 'directory') await mkdir(source);
      if (kind === 'symlink' || kind === 'hardlink') {
        const outside = path.join(item.root, 'original.txt');
        await writeFile(outside, 'must not be read through the alias');
        if (kind === 'symlink') await symlink(outside, source);
        else await link(outside, source);
      }
      if (kind === 'oversized') { await writeFile(source, 'x'); await truncate(source, file.maxBytes + 1); }
      await assert.rejects(item.config.afterExtract(item.context), `${file.source}/${kind} must fail`);
      await assertMissing(item.destination);
    }
  }
});

test('bounded Chromium notice copying supports files larger than the unchanged ASAR inspector buffer', async t => {
  const item = await fixture(t);
  const bytes = Buffer.alloc(11 * 1024 * 1024, 0x41);
  bytes[0] = 0xff;
  bytes[bytes.length - 1] = 0;
  await writeFile(path.join(item.root, 'LICENSES.chromium.html'), bytes);
  await item.config.afterExtract(item.context);
  const destination = await packageRename(item);
  await item.config.afterPack(item.context);
  assert.equal(hash(await readFile(path.join(destination, 'LICENSES.chromium.html'))), hash(bytes));
});

test('target versions fail closed using original plist and framework/config metadata', async t => {
  for (const kind of ['framework-mismatch', 'config-mismatch', 'plist-mismatch', 'missing-plist', 'empty-plist',
    'oversized-plist', 'symlink-plist', 'binary-plist', 'duplicate-version', 'commented-version', 'nonstring-version']) {
    const item = await fixture(t);
    if (kind === 'framework-mismatch') item.context.packager.info.framework.version = '0.0.1';
    if (kind === 'config-mismatch') item.context.packager.config = { ...item.config, electronVersion: '0.0.1' };
    if (kind === 'plist-mismatch') await writeFile(item.info, plist('0.0.1'));
    if (kind === 'missing-plist') await rm(item.info);
    if (kind === 'empty-plist') await writeFile(item.info, '');
    if (kind === 'oversized-plist') await truncate(item.info, PLIST_MAX_BYTES + 1);
    if (kind === 'symlink-plist') {
      await rename(item.info, `${item.info}.original`);
      await symlink(`${item.info}.original`, item.info);
    }
    if (kind === 'binary-plist') await writeFile(item.info, 'bplist00');
    if (kind === 'duplicate-version') await writeFile(item.info, plist(item.config.electronVersion).replace('</dict>',
      `<key>CFBundleShortVersionString</key><string>${item.config.electronVersion}</string></dict>`));
    if (kind === 'commented-version') await writeFile(item.info, plist(item.config.electronVersion).replace('<key>', '<!--<key>').replace('</string>', '</string>-->'));
    if (kind === 'nonstring-version') await writeFile(item.info, plist(item.config.electronVersion).replace('<string>', '<integer>').replace('</string>', '</integer>'));
    await assert.rejects(item.config.afterExtract(item.context), kind);
    await assertMissing(item.destination);
  }
});

test('target path and architecture validation rejects traversal and unsupported contexts', async t => {
  for (const kind of ['relative-root', 'bad-platform', 'bad-arch', 'bundle-traversal', 'product-traversal']) {
    const item = await fixture(t);
    if (kind === 'relative-root') item.context.appOutDir = 'relative';
    if (kind === 'bad-platform') item.context.electronPlatformName = undefined;
    if (kind === 'bad-arch') item.context.arch = undefined;
    if (kind === 'bundle-traversal') item.context.packager.info.framework.distMacOsAppName = '../Electron.app';
    if (kind === 'product-traversal') item.context.packager.appInfo.productFilename = '../other';
    await assert.rejects(item.config.afterExtract(item.context), kind);
    await assertMissing(item.destination);
  }
});

test('source and destination directory symlinks and preexisting destination files fail closed', async t => {
  for (const kind of ['bundle-symlink', 'resources-symlink', 'licenses-symlink', 'destination-file', 'destination-symlink']) {
    const item = await fixture(t);
    const outside = path.join(item.root, 'outside');
    if (kind === 'bundle-symlink' || kind === 'resources-symlink') {
      const original = kind === 'bundle-symlink' ? item.extracted : item.resources;
      await rename(original, outside);
      await symlink(outside, original, 'dir');
    } else if (kind === 'licenses-symlink') {
      await mkdir(outside);
      await symlink(outside, item.destination, 'dir');
    } else {
      await mkdir(item.destination);
      const output = path.join(item.destination, NOTICE_FILES[0].output);
      if (kind === 'destination-file') await writeFile(output, 'preserve existing bytes');
      else { await writeFile(outside, 'preserve external bytes'); await symlink(outside, output); }
    }
    await assert.rejects(item.config.afterExtract(item.context), kind);
    if (kind === 'destination-file') assert.equal(await readFile(path.join(item.destination, NOTICE_FILES[0].output), 'utf8'), 'preserve existing bytes');
    if (kind === 'destination-symlink') assert.equal(await readFile(outside, 'utf8'), 'preserve external bytes');
  }
});

test('post-package inspector independently detects either missing or changed notice', async t => {
  for (const file of NOTICE_FILES) {
    for (const kind of ['missing', 'changed', 'empty', 'symlink', 'oversized']) {
      const item = await fixture(t);
      await item.config.afterExtract(item.context);
      const destination = await packageRename(item);
      const output = path.join(destination, file.output);
      if (kind === 'missing') await rm(output);
      if (kind === 'changed') { const bytes = await readFile(output); bytes[0] ^= 1; await writeFile(output, bytes); }
      if (kind === 'empty') await writeFile(output, '');
      if (kind === 'symlink') { await rename(output, `${output}.original`); await symlink(`${output}.original`, output); }
      if (kind === 'oversized') await truncate(output, file.maxBytes + 1);
      await assert.rejects(item.config.afterPack(item.context), `${file.output}/${kind} must fail`);
    }
  }
});

test('post-package inspector requires provenance from the same target extraction', async t => {
  const config = builderConfig('production');
  const first = await fixture(t, { config, arch: 1 }), second = await fixture(t, { config, arch: 3 });
  await assert.rejects(config.afterPack(first.context), /provenance/);
  await config.afterExtract(first.context);
  await config.afterExtract(second.context);
  await packageRename(first);
  const secondDestination = await packageRename(second);
  // Both targets are well formed, but cross-target source substitution must fail.
  for (const file of NOTICE_FILES) await writeFile(path.join(secondDestination, file.output), first.originals.get(file.output));
  await config.afterPack(first.context);
  await assert.rejects(config.afterPack(second.context), /differs from extracted target/);
});

test('non-Mac runtime notices remain a no-op; external fonts verify with unchanged security envelope', async t => {
  for (const channel of ['production', 'development']) {
    const config = builderConfig(channel);
    for (const platform of ['linux', 'win32']) {
      // No host runtime is needed: only fixed external font fixtures.
      const root=await mkdtemp(path.join(tmpdir(),'mioon-package-font-'));t.after(()=>rm(root,{recursive:true,force:true}));
      await cp(new URL('../packages/business/resources/subtitles/',import.meta.url),path.join(root,'resources/subtitles'),{recursive:true});
      const context = { electronPlatformName: platform, appOutDir: root };
      await config.afterExtract(context);
      await config.afterPack(context);
    }
    assert.deepEqual(config.files, ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/**/*', 'icons/**/*', 'licenses/**/*', '!node_modules/**/*']);
    assert.equal(config.asar, true);
    assert.equal(config.npmRebuild, false);
    assert.equal(config.publish, null);
    assert.equal(config.mac.identity, null);
    assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
    assert.equal(config.electronFuses.runAsNode, false);
    for (const excluded of ['node_modules/electron/LICENSE', 'workspace/workbench.sqlite', '.env', 'mcp-token']) {
      assert.equal(config.files.filter(pattern => !pattern.startsWith('!')).some(pattern => path.matchesGlob(excluded, pattern)), false);
    }
  }
});

test('generated notice locates both runtime files outside ASAR without loading host Electron', async () => {
  const build = await readFile(new URL('../apps/desktop/scripts/build.ts', import.meta.url), 'utf8');
  assert.match(build, /LICENSE\.electron\.txt and LICENSES\.chromium\.html/);
  assert.match(build, /Contents\/Resources\/licenses/);
  assert.match(build, /on Linux they are beside the executable/);
  const helper = await readFile(new URL('../apps/desktop/runtime-notices.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /require\(['"]electron['"]\)|node_modules|child_process|fetch\(/);
});
