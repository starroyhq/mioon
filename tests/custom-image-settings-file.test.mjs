import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, chmod} from 'node:fs/promises';
import {createImageSettingsFile, createCustomImageSettingsFile} from '../packages/business/src/images/settings-file.mjs';
import {createImageSettings, createCustomImageSettings} from '../packages/business/src/images/settings.mjs';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE, CUSTOM_IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.mjs';
const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image'};
const envelope = (revision = 1) => ({version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, revision, configuration, secret: null});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-custom-images-')); t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'image-settings');
  return {root, directory, file: path.join(directory, 'custom-settings.json'), official: path.join(directory, 'settings.json'),
    persistence: createCustomImageSettingsFile({directory, privateRoot: root})};
}

test('custom default read is inert, own private atomic file is separate, old official v1 bytes are never rewritten', async t => {
  const f = await fixture(t);
  assert.equal(await f.persistence.load(), null); await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  await mkdir(f.directory, {mode: 0o700});
  const old = {version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, revision: 17, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: null};
  const bytes = JSON.stringify(old, null, 2) + '\n\n'; await writeFile(f.official, bytes, {mode: 0o600});
  const official = await createImageSettings({persistence: createImageSettingsFile({directory: f.directory, privateRoot: f.root})});
  const custom = await createCustomImageSettings({persistence: f.persistence});
  t.after(async () => { await custom.close(); await official.close(); });
  assert.equal((await official.get()).revision, 17); assert.equal((await custom.get()).revision, 0);
  assert.equal(await readFile(f.official, 'utf8'), bytes);
  await custom.put({expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-private-custom'}});
  assert.equal(await readFile(f.official, 'utf8'), bytes);
  assert.deepEqual((await readdir(f.directory)).sort(), ['custom-settings.json', 'settings.json']);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600); assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await readFile(f.file, 'utf8')).includes('synthetic-private-custom'), false);
  assert.equal((await f.persistence.load()).secret, null);
});

test('custom file cannot select the official filename, persist update DTOs or read foreign/plaintext envelopes', async t => {
  const f = await fixture(t);
  assert.throws(() => createCustomImageSettingsFile({directory: f.directory, filename: 'settings.json'}), {code: 'IMAGE_SETTINGS_CORRUPT'});
  for (const bad of [{expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-secret'}},
    {...envelope(), namespace: IMAGE_SETTINGS_NAMESPACE}, {...envelope(), secret: {value: 'synthetic-secret'}}]) {
    await assert.rejects(f.persistence.save(bad), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  }
  await mkdir(f.directory, {mode: 0o700});
  for (const content of ['{"bad":', 'x'.repeat(65537), JSON.stringify({...envelope(), namespace: IMAGE_SETTINGS_NAMESPACE})]) {
    await writeFile(f.file, content, {mode: 0o600});
    const settings = await createCustomImageSettings({persistence: f.persistence});
    await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put({expectedRevision: 0, configuration, secret: {action: 'remove'}}), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), content); await settings.close();
  }
});

test('custom file reuses symlink/permissions denial without repairing or overwriting the target', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t); await mkdir(f.directory, {mode: 0o700});
  const target = path.join(f.root, 'target.json'), original = JSON.stringify(envelope(99));
  await writeFile(target, original, {mode: 0o600}); await symlink(target, f.file);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(await readFile(target, 'utf8'), original);
  await rm(f.file); await f.persistence.save(envelope()); await chmod(f.file, 0o644);
  await assert.rejects(f.persistence.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(f.persistence.save(envelope(2)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal((await stat(f.file)).mode & 0o777, 0o644);
});
