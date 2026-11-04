import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, rename, link, symlink, chmod} from 'node:fs/promises';
import {createCustomImageSettingsV2File} from '../packages/business/src/images/custom-settings-v2-file.ts';
import {createCustomImageSettingsV2, validateCustomImageSettingsV2Envelope} from '../packages/business/src/images/custom-settings-v2.ts';
import {CUSTOM_IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_NAMESPACE, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS} from '../packages/contracts/src/image-settings.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, CUSTOM_IMAGE_SETTINGS_V2_LIMITS, DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';

const configuration = {...structuredClone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2), enabled: true, baseUrl: 'https://images.example.com/v1', model: 'same-model'};
const create = (expectedRevision = 0) => ({expectedRevision, name: 'A', configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-session-only'}});
const legacy = () => ({version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, revision: 73, configuration: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION}, secret: null});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'g1-custom-images-v2-')); t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'image-settings'), file = path.join(directory, 'custom-settings.json');
  return {root, directory, file, adapter: () => createCustomImageSettingsV2File({directory, privateRoot: root})};
}
const empty = () => ({version: 2, namespace: CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, revision: 0, connections: [], deletedConnectionIds: []});

test('private missing read is inert; explicit save atomically creates v2 without touching official or Comfy files', async t => {
  const f = await fixture(t), file = f.adapter();
  assert.equal(await file.load(), null); await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  await mkdir(f.directory, {mode: 0o700}); await mkdir(path.join(f.root, 'comfy-settings'), {mode: 0o700});
  const official = path.join(f.directory, 'settings.json'), comfy = path.join(f.root, 'comfy-settings', 'settings.json');
  await writeFile(official, 'synthetic-official-unchanged\n', {mode: 0o600}); await writeFile(comfy, 'synthetic-comfy-unchanged\n', {mode: 0o600});
  const settings = await createCustomImageSettingsV2({persistence: file}); t.after(() => settings.close());
  const next = await settings.create(create()); assert.equal(next.revision, 1);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600); assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const contents = await readFile(f.file, 'utf8'); assert.equal(contents.includes('synthetic-session-only'), false);
  assert.equal(validateCustomImageSettingsV2Envelope(JSON.parse(contents)).version, 2);
  assert.equal(await readFile(official, 'utf8'), 'synthetic-official-unchanged\n');
  assert.equal(await readFile(comfy, 'utf8'), 'synthetic-comfy-unchanged\n');
  assert.deepEqual((await readdir(f.directory)).sort(), ['custom-settings.json', 'settings.json']);
});

test('recognized v1 bytes and inode survive repeated reads until the first explicit v2 save', async t => {
  const f = await fixture(t); await mkdir(f.directory, {mode: 0o700});
  const bytes = JSON.stringify(legacy(), null, 2) + '\n\n'; await writeFile(f.file, bytes, {mode: 0o600});
  const before = await stat(f.file), settings = await createCustomImageSettingsV2({persistence: f.adapter()}); t.after(() => settings.close());
  assert.equal((await settings.get()).notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');
  assert.equal((await settings.get()).notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');
  assert.equal(await readFile(f.file, 'utf8'), bytes); assert.equal((await stat(f.file)).ino, before.ino);
  const next = await settings.create(create()); assert.equal(next.notice, null);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).version, 2);
});

test('unknown, corrupt, oversized or foreign files never become resettable legacy settings', async t => {
  const f = await fixture(t); await mkdir(f.directory, {mode: 0o700});
  for (const content of ['{"bad":', JSON.stringify({...legacy(), version: 3}), JSON.stringify({...legacy(), namespace: IMAGE_SETTINGS_NAMESPACE}),
    JSON.stringify({...legacy(), secret: {value: 'synthetic-key'}}), JSON.stringify(legacy()) + ' '.repeat(IMAGE_SETTINGS_LIMITS.envelopeBytes),
    JSON.stringify(empty()) + ' '.repeat(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.envelopeBytes)]) {
    await writeFile(f.file, content, {mode: 0o600});
    const settings = await createCustomImageSettingsV2({persistence: f.adapter()});
    await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.equal(await readFile(f.file, 'utf8'), content); await settings.close();
  }
  const invalidUtf8 = Buffer.concat([Buffer.from('{"version":1,"padding":"'), Buffer.from([0x80]), Buffer.from('"}')]);
  await writeFile(f.file, invalidUtf8, {mode: 0o600});
  await assert.rejects(f.adapter().load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
  assert.deepEqual(await readFile(f.file), invalidUtf8);
});

for (const replacement of ['changed-bytes', 'same-byte-inode', 'removed', 'whitespace-only', 'invalid-utf8'] as const)
  test(`load-to-first-save ${replacement} change is refused and cannot refresh the baseline during read-back`, async t => {
    const f = await fixture(t); await mkdir(f.directory, {mode: 0o700});
    const original = JSON.stringify(legacy()) + '\n'; await writeFile(f.file, original, {mode: 0o600});
    const settings = await createCustomImageSettingsV2({persistence: f.adapter()}); t.after(() => settings.close());
    assert.equal((await settings.get()).notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');
    if (replacement === 'changed-bytes') await writeFile(f.file, JSON.stringify({...legacy(), revision: 74}), {mode: 0o600});
    if (replacement === 'same-byte-inode') {
      const old = await stat(f.file), other = path.join(f.directory, 'other.json'); await writeFile(other, original, {mode: 0o600});
      await rename(other, f.file); assert.notEqual((await stat(f.file)).ino, old.ino);
    }
    if (replacement === 'removed') await rm(f.file);
    if (replacement === 'whitespace-only') await writeFile(f.file, original + '\n', {mode: 0o600});
    if (replacement === 'invalid-utf8') await writeFile(f.file, Buffer.concat([Buffer.from(original), Buffer.from([0x80])]), {mode: 0o600});
    const current = await readFile(f.file).catch(error => {assert.equal(error.code, 'ENOENT'); return null;});
    await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    assert.deepEqual(await readFile(f.file).catch(() => null), current);
  });

test('a missing initial source cannot overwrite a file created later by another owner', async t => {
  const f = await fixture(t), settings = await createCustomImageSettingsV2({persistence: f.adapter()}); t.after(() => settings.close());
  await mkdir(f.directory, {mode: 0o700}); const bytes = JSON.stringify(legacy()); await writeFile(f.file, bytes, {mode: 0o600});
  await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(await readFile(f.file, 'utf8'), bytes);
});

test('only a successful own save advances the file baseline for later collection saves', async t => {
  const f = await fixture(t), settings = await createCustomImageSettingsV2({persistence: f.adapter()}); t.after(() => settings.close());
  const first = await settings.create(create()), a = first.connections[0];
  const next = await settings.put({expectedRevision: 1, connectionId: a.connectionId, expectedConfigurationRevision: 1,
    name: 'Renamed', configuration: a.configuration, secret: {action: 'keep'}});
  assert.equal(next.revision, 2); assert.equal(JSON.parse(await readFile(f.file, 'utf8')).revision, 2);
  const external = JSON.stringify({...validateCustomImageSettingsV2Envelope(JSON.parse(await readFile(f.file, 'utf8'))), revision: 3});
  await writeFile(f.file, external, {mode: 0o600});
  await assert.rejects(settings.remove({expectedRevision: 2, connectionId: a.connectionId, expectedConfigurationRevision: 2}), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(await readFile(f.file, 'utf8'), external);
});

test('private file adapter denies filenames, path escapes, update DTOs, symbolic/hard links and unsafe permissions', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  for (const options of [{directory: f.directory, filename: 'settings.json'}, {directory: 'relative'},
    {directory: f.root, privateRoot: f.directory}, {directory: f.directory + '\0unsafe'}])
    assert.throws(() => createCustomImageSettingsV2File(options), {code: 'IMAGE_SETTINGS_CORRUPT'});
  const file = f.adapter(); await file.load();
  await assert.rejects(file.save(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  await mkdir(f.directory, {mode: 0o700}); const target = path.join(f.root, 'target.json');
  const bytes = JSON.stringify(legacy()); await writeFile(target, bytes, {mode: 0o600});
  for (const kind of ['symbolic', 'hard', 'permission', 'directory']) {
    if (kind === 'symbolic') await symlink(target, f.file);
    if (kind === 'hard') await link(target, f.file);
    if (kind === 'permission') await writeFile(f.file, bytes, {mode: 0o644});
    if (kind === 'directory') await mkdir(f.file, {mode: 0o700});
    const adapter = f.adapter(); await assert.rejects(adapter.load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(adapter.save(empty()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    assert.equal(await readFile(target, 'utf8'), bytes);
    if (kind === 'permission') assert.equal((await stat(f.file)).mode & 0o777, 0o644);
    await rm(f.file, {recursive: true});
  }
  await chmod(f.directory, 0o755);
  await assert.rejects(f.adapter().load(), {code: 'IMAGE_SETTINGS_CORRUPT'});
});
